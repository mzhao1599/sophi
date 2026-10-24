import { chmodSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { ArmRoleSchema, ArmSideSchema } from "@walker/contracts";
import { z } from "zod";
import type { Logger } from "../log";
import type { MotionCoordinator } from "./coordinator";

/**
 * The Pi's operator channel: a Unix socket the running walker service listens on, for `walker arms` and
 * `walker motion` at a terminal on the Pi. It is the `operator_cli` input channel: whatever a request says,
 * every command from here runs as `operator_cli`, and every command but a stop waits for a Confirm press on
 * the walker (the coordinator does that). The socket is 0600 in the service's 0700 runtime folder, so only
 * the service's user and root can reach it; it is never a network port.
 *
 * One JSON object per line each way. Requests are parsed with the schema below; unknown fields (an
 * `initiator`, `walker_confirm_at`, `base_parked`...) are dropped, never used.
 */
export const DEFAULT_MOTION_SOCKET = "/run/steady-walker/motion.sock";
const MAX_LINE = 4096;

const side = ArmSideSchema;
export const OperatorRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }),
  z.object({ op: z.literal("stop") }),
  z.object({ op: z.literal("torque"), enabled: z.boolean(), arm: side.optional() }),
  z.object({ op: z.literal("pose.list") }),
  z.object({ op: z.literal("pose.save"), name: z.string().max(64), title: z.string().trim().min(1).max(60).optional(), arm: side.optional() }),
  z.object({ op: z.literal("pose.go"), name: z.string().max(64), arm: side }),
  z.object({ op: z.literal("teleop"), arm: side }),
  z.object({ op: z.literal("clear"), reason: z.string().max(400) }),
  z.object({ op: z.literal("request"), id: z.string().max(64) }),
  z.object({ op: z.literal("calibrate.begin"), arm: side, role: ArmRoleSchema }),
  z.object({ op: z.literal("calibrate.middle") }),
  z.object({ op: z.literal("calibrate.status") }),
  z.object({ op: z.literal("calibrate.finish") }),
  z.object({ op: z.literal("calibrate.cancel") }),
]);
export type OperatorRequestMessage = z.infer<typeof OperatorRequestSchema>;

/** Answers one operator request. Every path is the coordinator's operator API: the channel is fixed here. */
export async function answerOperator(coordinator: MotionCoordinator, raw: unknown): Promise<Record<string, unknown>> {
  const parsed = OperatorRequestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: `not a request this socket takes: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const request = parsed.data;
  switch (request.op) {
    case "status":
      return { ok: true, state: coordinator.state() };
    case "stop":
      return coordinator.operatorStop();
    case "torque":
      return coordinator.operatorTorque(request.enabled, request.arm ? [request.arm] : null);
    case "pose.list":
      return { ok: true, poses: coordinator.operatorPoses() };
    case "pose.save":
      return coordinator.operatorSavePose(request.name, request.title ?? null, request.arm ? [request.arm] : null);
    case "pose.go":
      return coordinator.operatorGoToPose(request.arm, request.name);
    case "teleop":
      return coordinator.operatorTeleop(request.arm);
    case "clear":
      return coordinator.operatorClear(request.reason);
    case "request": {
      const found = coordinator.operatorRequestStatus(request.id);
      return found ? { ok: true, request: found } : { ok: false, error: "no such request" };
    }
    case "calibrate.begin":
      return coordinator.operatorCalibrateBegin(request.arm, request.role);
    case "calibrate.middle":
      return coordinator.operatorCalibrateMiddle();
    case "calibrate.status":
      return coordinator.operatorCalibrateStatus();
    case "calibrate.finish":
      return coordinator.operatorCalibrateFinish();
    case "calibrate.cancel":
      return coordinator.operatorCalibrateCancel();
  }
}

export class OperatorSocket {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly path: string,
    private readonly coordinator: MotionCoordinator,
    private readonly log: Logger,
  ) {}

  async listen(): Promise<void> {
    try {
      unlinkSync(this.path); // a socket left by an earlier run
    } catch {
      // None there.
    }
    const server = createServer((socket) => this.serve(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(this.path, 0o600);
    server.on("error", (error) => this.log.error("operator socket error", { error: error.message }));
    this.log.info("operator socket listening", { path: this.path });
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone.
    }
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    let buffer = "";
    let calibrating = false;
    /** Requests this terminal prepared: withdrawn if still waiting, stopped if running, when it goes away. */
    const mine = new Set<string>();
    let chain: Promise<void> = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes("\n")) {
        socket.end(`${JSON.stringify({ ok: false, error: "line too long" })}\n`);
        return;
      }
      for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          socket.write(`${JSON.stringify({ ok: false, error: "not JSON" })}\n`);
          continue;
        }
        const op = (raw as { op?: unknown })?.op;
        // Answered one at a time, so replies come back in the order asked.
        chain = chain.then(() =>
          answerOperator(this.coordinator, raw).then(
            (reply) => {
              if (op === "calibrate.begin" && reply.ok === true) calibrating = true;
              const request = (reply as { request?: { id?: unknown; state?: unknown } | null }).request;
              if (request && typeof request.id === "string") mine.add(request.id);
              if ((op === "calibrate.finish" && reply.ok === true) || op === "calibrate.cancel") calibrating = false;
              if (socket.writable) socket.write(`${JSON.stringify(reply)}\n`);
            },
            (error: unknown) => void (socket.writable && socket.write(`${JSON.stringify({ ok: false, error: (error as Error).message })}\n`)),
          ),
        );
      }
    });
    // A terminal that goes away mid-calibration (Ctrl-C, a dropped SSH) cancels it.
    socket.on("close", () => {
      this.sockets.delete(socket);
      for (const id of mine) {
        this.coordinator.operatorWithdraw(id);
        this.coordinator.operatorStopIfRunning(id);
      }
      if (calibrating) this.coordinator.operatorCalibrateCancel();
    });
    socket.on("error", () => {});
  }
}

/** The CLI side: one connection, requests answered in order. */
export class OperatorClient {
  private readonly socket: Socket;
  private buffer = "";
  private readonly waiting: Array<(reply: Record<string, unknown>) => void> = [];
  private closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let i = this.buffer.indexOf("\n"); i >= 0; i = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + 1);
        let reply: Record<string, unknown>;
        try {
          reply = JSON.parse(line) as Record<string, unknown>;
        } catch {
          reply = { ok: false, error: "unreadable reply" };
        }
        this.waiting.shift()?.(reply);
      }
    });
    socket.on("close", () => {
      this.closed = true;
      for (const resolve of this.waiting.splice(0)) resolve({ ok: false, error: "the walker service closed the connection" });
    });
  }

  static connect(path: string): Promise<OperatorClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolve(new OperatorClient(socket)));
      socket.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            error.code === "ENOENT" || error.code === "ECONNREFUSED"
              ? `the walker service isn't running with arms configured (no socket at ${path})`
              : error.code === "EACCES"
                ? `no permission for ${path}: run it with sudo`
                : error.message,
          ),
        ),
      );
    });
  }

  send(request: OperatorRequestMessage): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.resolve({ ok: false, error: "not connected" });
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      this.socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  close(): void {
    this.socket.end();
  }
}
