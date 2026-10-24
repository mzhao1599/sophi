import { createInterface, type Interface } from "node:readline";
import { REFUSAL_SENTENCES, type ArmSide, type MotionState } from "@walker/contracts";
import type { OperatorRequest } from "./coordinator";
import { DEFAULT_MOTION_SOCKET, OperatorClient, type OperatorRequestMessage } from "./operator";

/**
 * `walker arms ...` and `walker motion ...`: the operator's terminal commands. They talk to the running walker
 * service over its local socket; the service owns the servo buses. Every command but a stop is announced on
 * the walker and waits for a Confirm press there (30 s). Plain text lines only, so a screen reader reads them.
 */
export const ARMS_USAGE = `  walker arms status
  walker arms torque <on|off> [--arm left|right]
  walker arms calibrate <left|right> [--leader]
  walker arms pose save <name> [--arm left|right] [--title "<words the walker says>"]
  walker arms pose go <name> [--arm left|right]
  walker arms pose list
  walker arms teleop <left|right>
  walker motion stop
  walker motion clear --reason "<why it is safe>"
  walker motion status
      Talk to the running walker service's motion coordinator (socket: --socket, else WALKER_MOTION_SOCKET, else
      ${DEFAULT_MOTION_SOCKET}). Needs sudo on the Pi. Everything but a stop waits for Confirm on the walker.`;

type Flags = Map<string, string | true>;
const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);
const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Ctrl-C was pressed: a stop has been sent and the process is about to end. */
let interrupted = false;

function sideArg(value: string | undefined): ArmSide | null {
  return value === "left" || value === "right" ? value : null;
}

function socketPath(flags: Flags): string {
  return text(flags.get("socket")) ?? process.env.WALKER_MOTION_SOCKET ?? DEFAULT_MOTION_SOCKET;
}

function fail(reply: Record<string, unknown>): number {
  out(`Not done: ${String(reply.error ?? "unknown error")}`);
  return 1;
}

function describeRequest(request: OperatorRequest): string {
  if (request.state === "refused" || request.state === "expired") {
    const sentence = request.refusal ? REFUSAL_SENTENCES[request.refusal] : (request.sentence ?? "");
    return `Refused (${request.refusal ?? request.state}): ${sentence}${request.detail ? ` [${request.detail}]` : ""}`;
  }
  return `${request.state}${request.detail ? `: ${request.detail}` : ""}`;
}

/** Waits for the walker's Confirm press, then (with `untilDone`) for the motion to end. Ctrl-C stops motion. */
async function follow(client: OperatorClient, first: OperatorRequest, untilDone: boolean): Promise<OperatorRequest> {
  let request = first;
  if (request.state === "waiting_confirm") out(`The walker says: "${request.prompt}" Press Confirm on the walker within 30 s. Ctrl-C cancels.`);
  let announcedRunning = false;
  for (;;) {
    if (request.state === "running" && !announcedRunning) {
      out("Confirmed on the walker. Running. Any handle press, or Ctrl-C here, stops it.");
      announcedRunning = true;
    }
    if (request.state !== "waiting_confirm" && (request.state !== "running" || !untilDone)) return request;
    await sleep(250);
    const reply = await client.send({ op: "request", id: request.id });
    // After Ctrl-C the interrupt handler ends the process; nothing here reports a half-closed connection.
    if (interrupted) return new Promise<never>(() => {});
    if (reply.ok !== true) throw new Error(String(reply.error));
    request = reply.request as OperatorRequest;
  }
}

function printState(state: MotionState): void {
  out(`Mode: ${state.mode}${state.bench_mode ? " (BENCH MODE: no hardware stop)" : ""}. Stop: ${state.stop_circuit}. Hand control: ${state.hand_controls_connected ? "connected" : "none"}.`);
  for (const arm of state.arms) {
    const pose = arm.pose.status === "at" ? `at ${arm.pose.name}` : arm.pose.status;
    out(`${arm.arm} ${arm.role}: ${arm.connected ? "connected" : "NOT connected"}, ${arm.calibrated ? "calibrated" : "NOT calibrated"}, torque ${arm.torque}, ${pose}${arm.faults.length ? `, faults ${arm.faults.join(", ")}` : ""}`);
    if (arm.joints) {
      out(
        `  ${Object.entries(arm.joints)
          .map(([joint, r]) => `${joint} ${r.degrees.toFixed(1)}° ${r.temperature_c}°C ${r.load_pct.toFixed(0)}% ${r.voltage_v.toFixed(1)}V`)
          .join("; ")}`,
      );
    }
  }
  if (state.active) out(`Active: ${state.active.kind}`);
  if (state.confirm_target) out(`Waiting for Confirm (prepared by ${state.confirm_target.prepared_by}): "${state.confirm_target.prompt}"`);
  if (state.last_command) out(`Last command: ${state.last_command.kind} ${state.last_command.outcome}${state.last_command.refusal ? ` (${state.last_command.refusal})` : ""}`);
  for (const fault of state.faults) out(`FAULT ${fault.code} (${fault.part}${fault.joint ? ` ${fault.joint}` : ""}): ${fault.sentence}`);
}

function lines(): { next(prompt: string): Promise<string>; close(): void } {
  const rl: Interface = createInterface({ input: process.stdin });
  const queue: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });
  return {
    next(prompt) {
      out(prompt);
      const line = queue.shift();
      return line !== undefined ? Promise.resolve(line) : new Promise((resolve) => waiters.push(resolve));
    },
    close: () => rl.close(),
  };
}

/** Runs one request that waits for Confirm; returns the exit code. Ctrl-C sends a stop. */
async function confirmed(client: OperatorClient, message: OperatorRequestMessage, untilDone: boolean, stoppedIsOk = false): Promise<number> {
  const reply = await client.send(message);
  if (reply.ok !== true) return fail(reply);
  const onInterrupt = () => {
    interrupted = true;
    // A stop (it also withdraws a target still waiting for Confirm); whatever its answer, this command ends.
    void client.send({ op: "stop" }).finally(() => {
      out("Stopped from the terminal.");
      process.exit(130);
    });
  };
  process.once("SIGINT", onInterrupt);
  // A dropped SSH session sends SIGHUP: the same as Ctrl-C (the service also stops what this terminal started).
  process.once("SIGHUP", onInterrupt);
  try {
    const request = await follow(client, reply.request as OperatorRequest, untilDone);
    out(describeRequest(request));
    return request.state === "completed" || (stoppedIsOk && request.state === "stopped") ? 0 : 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGHUP", onInterrupt);
  }
}

async function calibrate(client: OperatorClient, side: ArmSide, leader: boolean): Promise<number> {
  const role = leader ? "leader" : "follower";
  out(
    leader
      ? `Calibrating the ${side} teaching arm. Its motors stay off.`
      : `Calibrating the ${side} arm. Its motors turn OFF and it goes limp: hold it before you press Confirm on the walker.`,
  );
  const begin = await client.send({ op: "calibrate.begin", arm: side, role });
  if (begin.ok !== true) return fail(begin);
  const request = await follow(client, begin.request as OperatorRequest, false);
  if (request.state !== "completed") {
    out(describeRequest(request));
    return 1;
  }
  const input = lines();
  try {
    await input.next("Move every joint to the middle of its range (gripper half open), hold it still, then press Enter.");
    const middle = await client.send({ op: "calibrate.middle" });
    if (middle.ok !== true) return fail(middle);
    out("Centred. Now move every joint slowly through its whole range, one at a time. Press Enter when done.");
    let done = false;
    const finished = input.next("").then(() => {
      done = true;
    });
    let last = "";
    while (!done) {
      const status = await client.send({ op: "calibrate.status" });
      if (status.ok !== true) return fail(status);
      const summary = (status.joints as Array<{ joint: string; range_deg: number }>).map((j) => `${j.joint} ${j.range_deg}°`).join(", ");
      if (summary !== last) {
        out(`Ranges so far: ${summary}`);
        last = summary;
      }
      await Promise.race([finished, sleep(1500)]);
    }
    const finish = await client.send({ op: "calibrate.finish" });
    if (finish.ok !== true) {
      out("Not saved. Keep moving the joints and press Enter again, or Ctrl-C to cancel (the arm stays uncalibrated).");
      return fail(finish);
    }
    out(`Saved the ${side} ${role} calibration.`);
    return 0;
  } finally {
    input.close();
  }
}

export async function armsCommand(positional: string[], flags: Flags): Promise<number> {
  const [sub, ...rest] = positional;
  const client = await OperatorClient.connect(socketPath(flags));
  try {
    const arm = text(flags.get("arm"));
    const armSide = arm === undefined ? undefined : sideArg(arm);
    if (arm !== undefined && !armSide) {
      out("--arm takes left or right.");
      return 2;
    }
    switch (sub) {
      case "status": {
        const reply = await client.send({ op: "status" });
        if (reply.ok !== true) return fail(reply);
        printState(reply.state as MotionState);
        return 0;
      }
      case "torque": {
        const which = rest[0];
        if (which !== "on" && which !== "off") break;
        return await confirmed(client, { op: "torque", enabled: which === "on", ...(armSide ? { arm: armSide } : {}) }, true);
      }
      case "calibrate": {
        const side = sideArg(rest[0]);
        if (!side) break;
        return await calibrate(client, side, flags.get("leader") === true);
      }
      case "teleop": {
        const side = sideArg(rest[0]);
        if (!side) break;
        // Teleop runs until a handle press, Ctrl-C here, or a guard ends it; a stop is its normal end.
        return await confirmed(client, { op: "teleop", arm: side }, true, true);
      }
      case "pose": {
        const [action, name] = rest;
        if (action === "list") {
          const reply = await client.send({ op: "pose.list" });
          if (reply.ok !== true) return fail(reply);
          for (const pose of reply.poses as Array<{ arm: string; name: string; title: string; joints: Record<string, number> }>) {
            out(`${pose.arm} ${pose.name} ("${pose.title}"): ${Object.entries(pose.joints).map(([j, d]) => `${j} ${d}°`).join(", ")}`);
          }
          return 0;
        }
        if (!name) break;
        if (action === "save") {
          const title = text(flags.get("title"));
          const reply = await client.send({ op: "pose.save", name, ...(title ? { title } : {}), ...(armSide ? { arm: armSide } : {}) });
          if (reply.ok !== true) return fail(reply);
          for (const pose of reply.saved as Array<{ arm: string; name: string }>) out(`Saved ${pose.arm} ${pose.name}.`);
          return 0;
        }
        if (action === "go") {
          let side = armSide;
          if (!side) {
            const status = await client.send({ op: "status" });
            const followers = ((status.state as MotionState | undefined)?.arms ?? []).filter((a) => a.role === "follower");
            if (followers.length !== 1) {
              out("Two arms are configured: name one with --arm left or --arm right.");
              return 2;
            }
            side = followers[0]!.arm;
          }
          return await confirmed(client, { op: "pose.go", name, arm: side }, true);
        }
        break;
      }
    }
    out(`Usage:\n${ARMS_USAGE}`);
    return 2;
  } finally {
    client.close();
  }
}

export async function motionCommand(positional: string[], flags: Flags): Promise<number> {
  const [sub] = positional;
  const client = await OperatorClient.connect(socketPath(flags));
  try {
    switch (sub) {
      case "stop": {
        const reply = await client.send({ op: "stop" });
        if (reply.ok !== true) return fail(reply);
        out(reply.stopped ? "Stopped." : "Nothing was moving; holding.");
        return 0;
      }
      case "clear": {
        const reason = text(flags.get("reason"));
        if (!reason) {
          out('walker motion clear --reason "<why it is safe to clear>" (the reason is logged)');
          return 2;
        }
        return await confirmed(client, { op: "clear", reason }, true);
      }
      case "status": {
        const reply = await client.send({ op: "status" });
        if (reply.ok !== true) return fail(reply);
        printState(reply.state as MotionState);
        return 0;
      }
    }
    out(`Usage:\n${ARMS_USAGE}`);
    return 2;
  } finally {
    client.close();
  }
}
