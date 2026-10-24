import { z } from "zod";
import { LiftConfigSchema, LIFT_RAIL_LENGTH_MM, LIFT_SPEED_CEILING_MM_S } from "./motion";
import {
  SERIAL_MAX_LINE_BYTES,
  SERIAL_PROTOCOL_VERSION,
  SerialErrorSchema,
  SerialHelloRequestSchema,
  SerialModuleIdSchema,
  SerialProblemSchema,
} from "./serial";

/**
 * Pi ↔ lift ESP32 serial lines, version 1. PROPOSED. The lift firmware (firmware/, env `lift`) implements it and
 * is tested on a computer only (firmware/test/EXPECTED.md, "Lift board"); it hasn't run on hardware, and no Pi
 * code exists yet.
 * See docs/interfaces.md ("Pi ↔ lift ESP32"). Same transport and envelope as serial.ts (UTF-8 JSON Lines,
 * at most SERIAL_MAX_LINE_BYTES a line, `v`, `type`, `module_id`, `seq`, strict objects), and the same
 * `hello.request` and `error` lines, unchanged. The lift's own lines all start with `lift.`, so a hand or
 * obstacle board (and today's Pi, whose parser doesn't know them) can never mistake one for its own:
 * today's `parseSerialLine` answers `unknown_type` and acts on nothing.
 *
 * The lift ESP32 (provisioned as `lift-01`) generates the step pulses, reads both end switches and the stop,
 * and checks every command again against the limits built into its firmware (reported in `lift.hello`;
 * nothing over serial can raise them). The Pi decides whether a move may happen at all (motion.ts): a lift
 * move starts only from a handle Confirm press and runs only while a person holds the screen's hold control.
 * What the firmware does, exactly (constants from motion.ts):
 *
 * 1. Pins and boot. PUL, DIR and ENA (and the stop-sense and switch inputs) never use an ESP32-WROOM-32
 *    strapping pin (GPIO 0, 2, 5, 12, 15) or a flash pin (GPIO 6 to 11); GPIO 34 to 39 are input-only and
 *    have no internal pull-ups. At boot: not stepping, step output low, unhomed, no fault latched, and the
 *    driver left enabled so the motor holds the carriage. On most TB6600-type drivers ENA is an active-DISABLE
 *    input (current through it frees the motor), so wire it so a resetting or unpowered ESP32 leaves it
 *    enabled; check the received unit. Then send `lift.hello` with `seq` 0, and refuse moves until heartbeats
 *    arrive. Status reports `driver_enabled: true` from the first line.
 * 2. A `hello.request` (the Pi reconnected or restarted) stops any running move or homing (ramp down, hold,
 *    `lift.done` `stopped`), forgets the last Pi `seq`, and is answered with `lift.hello`.
 * 3. Every Pi line's `seq` must be above the last Pi `seq` accepted since the last `hello.request`. A
 *    `lift.heartbeat` that isn't is ignored, as if it never arrived; a command that isn't is rejected `stale_seq`
 *    (except rule 6). A heartbeat that is resets the watchdog and carries the hold lease: `hold_request_id`
 *    names the move or homing a person at the walker is holding for, or null when nobody is.
 * 4. `lift.home` / `lift.move` with request R are accepted only if, checked in this order: fresh `seq`
 *    (`stale_seq`); R never accepted before, meaning its counter is above the highest counter accepted under
 *    the same boot prefix since this lift booted (`request_used`; a new prefix starts again); a heartbeat in the last LIFT_WATCHDOG_TIMEOUT_MS (`no_heartbeat`) and the latest one
 *    named R (`not_held`); the stop input released (`stop_pressed`); no fault latched (`fault_latched`); nothing
 *    else running (`busy`); the driver enabled (`driver_disabled`); for a move, homed (`not_homed`), the target
 *    inside the soft limits and the speed at most the built-in maximum (`out_of_range`). So the Pi sends the
 *    heartbeat naming R first, then the command.
 * 5. While R runs: a heartbeat naming R renews the lease. A heartbeat naming anything else (the person let go)
 *    stops it: ramp down at LIFT_STOP_DECEL_MM_S2, hold, `lift.done` `stopped`, no fault. No heartbeat for
 *    LIFT_WATCHDOG_TIMEOUT_MS stops it the same way, latches `watchdog_expired`, `lift.done` `failed`. A request
 *    that is stopping or has finished never resumes, whatever later heartbeats name; only a new request can move
 *    the lift again. An idle lift that stops hearing heartbeats latches nothing; it just refuses moves until
 *    they return.
 *    LIFT_WATCHDOG_DRIVER_ACTION is `hold`: stopping never disables the driver.
 * 6. `lift.stop` is always accepted: no `stale_seq`, `busy`, `no_heartbeat`, `not_homed`, `fault_latched` or
 *    any other refusal; it ramps down and holds. `lift.enable` with `enabled: false` skips the same checks but
 *    frees the motor only when the bottom switch reads pressed, or when the firmware was built disable-safe
 *    (`WALKER_LIFT_DISABLE_SAFE=1`, set only after a recorded passed drop test or with a brake fitted): then it
 *    first stops stepping at once, frees the motor, and clears `homed`. Otherwise it is rejected
 *    `disable_unsafe`, the driver stays enabled, and a running move or homing ramps down and holds as for a
 *    stop. The Pi sends it only for a confirmed `lift.disable` (a passed drop test, a brake, or the carriage on
 *    the bottom switch); no fault reaction sends it. `lift.enable` with `enabled: true` is refused only for
 *    `stale_seq`.
 * 7. Homing, in four phases: fast approach down at LIFT_HOMING_FAST_MM_S until the bottom switch presses
 *    (skipped if it is already pressed); back off up at LIFT_HOMING_SLOW_MM_S by LIFT_HOMING_BACKOFF_MM, the
 *    switch releasing within LIFT_HOMING_BACKOFF_MM + LIFT_HOMING_RELEASE_MARGIN_MM of travel; slow approach down
 *    at LIFT_HOMING_SLOW_MM_S until it presses again within that same distance, which is 0 mm; back off up at
 *    LIFT_HOMING_SLOW_MM_S by LIFT_HOMING_BACKOFF_MM, the same release check: that is home. A release or press
 *    that doesn't happen within its distance, more than LIFT_HOMING_MAX_TRAVEL_MM over all phases, or the top
 *    switch pressing latches `homing_failed`.
 * 8. Switches (wired normally closed, so a cut wire reads pressed): a switch pressing while the lift is homed
 *    (moving, stopping or idle) or during `stopping` from a homing, other than the bottom switch during homing's
 *    own approaches and back-offs, stops stepping at once with no ramp and latches `limit_hit`; both pressed at
 *    once, at any time, latches `limit_wiring`. The stop-sense input (its own pin, normally closed, read on an
 *    edge interrupt so a quick tap of the latching switch isn't missed) latches `stop_circuit_opened` on any
 *    press: the stop cut the step signal, so the counted height can't be trusted. Every latched fault clears
 *    `homed`. If the firmware is built without a stop-sense input (bench), it reports `not_wired`.
 * 9. `lift.clear` clears every latched fault if no cause remains (the stop released, the top switch released,
 *    not both pressed, heartbeats arriving), else refuses with `cause_present`. The bottom switch alone may stay
 *    pressed: homing backs off it. It is sent only for a confirmed local `fault.clear`. The lift stays unhomed.
 * 10. `lift.status` at LIFT_STATUS_HZ and at once on any change of state, switch, stop, fault or request.
 */

export const LIFT_SERIAL_PROTOCOL_VERSION = SERIAL_PROTOCOL_VERSION;

/** Lift modules are provisioned `lift-<nn>`, so a lift command can't be addressed to a hand or obstacle board. */
export const LiftModuleIdSchema = SerialModuleIdSchema.regex(/^lift-[a-z0-9-]+$/);

/**
 * A lift request id: the Pi service's boot prefix (six lowercase letters or digits, new each time the
 * service starts) and a counter, such as `k3x9q2-17`. Ids from before a restart can never match a new one.
 */
export const LiftRequestIdSchema = z.string().regex(/^[a-z0-9]{6}-[1-9][0-9]{0,8}$/);

const envelope = {
  v: z.literal(LIFT_SERIAL_PROTOCOL_VERSION),
  module_id: LiftModuleIdSchema,
  seq: z.int().nonnegative(),
};
/** Milliseconds since the lift ESP32 booted. The Pi judges freshness by its own receive time. */
const uptime = z.int().nonnegative();
const height = z.number().min(0).max(LIFT_RAIL_LENGTH_MM);
const switchState = z.enum(["pressed", "released"]);

/** Faults the lift ESP32 latches itself. Each is also a motion.ts fault code with the same name. */
export const LiftSerialFaultSchema = z.enum(["limit_hit", "limit_wiring", "homing_failed", "watchdog_expired", "stop_circuit_opened"]);
export type LiftSerialFault = z.infer<typeof LiftSerialFaultSchema>;

/**
 * What the lift ESP32 is doing. `idle` and `moving` need it homed; `unhomed` and `homing` mean it isn't;
 * `stopping` (ramping down) and `fault` can be either.
 */
export const LiftSerialStateSchema = z.enum(["unhomed", "homing", "idle", "moving", "stopping", "fault"]);

/**
 * Lift → Pi on boot and on each `hello.request`. `config` is built into the firmware; the Pi compares it
 * with its own lift configuration and refuses lift motion on any difference (`lift_config_mismatch`).
 * `stop_sense` says whether the firmware was built to read a stop-sense input.
 */
export const LiftHelloSchema = z.strictObject({
  ...envelope,
  type: z.literal("lift.hello"),
  firmware_version: z.string().min(1).max(32),
  uptime_ms: uptime,
  config: LiftConfigSchema,
  stop_sense: z.enum(["wired", "not_wired"]),
});

/**
 * Lift → Pi at LIFT_STATUS_HZ, and at once on any change. It doubles as the lift's heartbeat: there is no
 * separate `heartbeat` line from the lift.
 */
export const LiftStatusSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("lift.status"),
    uptime_ms: uptime,
    state: LiftSerialStateSchema,
    homed: z.boolean(),
    /** Counted steps converted to millimetres above the bottom switch; null when unhomed. Not a measurement. */
    position_mm: height.nullable(),
    /** Where a move is heading (required while moving), or a homing phase's known end (optional); else null. */
    target_mm: height.nullable(),
    driver_enabled: z.boolean(),
    limits: z.strictObject({ top: switchState, bottom: switchState }),
    /** The lift's own reading of the stop-sense input, or `not_wired` when built without one. */
    stop_sense: z.enum(["pressed", "released", "not_wired"]),
    faults: z.array(LiftSerialFaultSchema).max(LiftSerialFaultSchema.options.length),
    /** The command being carried out, if any. */
    request_id: LiftRequestIdSchema.nullable(),
    /** Time since the last Pi heartbeat, on the lift's clock; null before the first. */
    heartbeat_age_ms: z.int().nonnegative().nullable(),
  })
  .refine((s) => s.homed === (s.position_mm !== null), {
    message: "position_mm is a number exactly when homed.",
    path: ["position_mm"],
  })
  .refine((s) => !(s.state === "idle" || s.state === "moving") || s.homed, {
    message: "idle and moving mean homed.",
    path: ["state"],
  })
  .refine((s) => !(s.state === "unhomed" || s.state === "homing") || !s.homed, {
    message: "unhomed and homing mean not homed.",
    path: ["state"],
  })
  .refine((s) => (s.state === "fault") === (s.faults.length > 0), {
    message: "The state is fault exactly when a fault is latched.",
    path: ["state"],
  })
  .refine((s) => new Set(s.faults).size === s.faults.length, { message: "Each fault appears once.", path: ["faults"] })
  // With the stop pressed its fault is latched, so the state is `fault`: nothing steps.
  .refine((s) => s.stop_sense !== "pressed" || s.faults.includes("stop_circuit_opened"), {
    message: "A pressed stop always has stop_circuit_opened latched.",
    path: ["faults"],
  })
  .refine((s) => !(s.state === "moving" || s.state === "homing" || s.state === "stopping") || s.driver_enabled, {
    message: "Stepping needs the driver enabled.",
    path: ["driver_enabled"],
  })
  .refine((s) => s.state !== "moving" || s.target_mm !== null, { message: "A move has a target.", path: ["target_mm"] })
  .refine((s) => s.target_mm === null || s.state === "moving" || s.state === "homing", {
    message: "A target exists only while moving or homing.",
    path: ["target_mm"],
  })
  .refine((s) => !(s.state === "moving" || s.state === "homing") || s.request_id !== null, {
    message: "Moving and homing name their request.",
    path: ["request_id"],
  });

/** Lift → Pi once per accepted move or homing: how it ended. An `ack` is only receipt. */
export const LiftDoneSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("lift.done"),
    request_id: LiftRequestIdSchema,
    uptime_ms: uptime,
    /** `stopped`: a `lift.stop`, a disable, a `hello.request`, or letting go of the hold ended it early. `failed`: a fault did. */
    outcome: z.enum(["completed", "stopped", "failed"]),
    fault: LiftSerialFaultSchema.optional(),
    position_mm: height.nullable(),
  })
  .refine((d) => (d.outcome === "failed") === (d.fault !== undefined), {
    message: "A failure names its fault; other outcomes don't.",
    path: ["fault"],
  });

/** Why the lift refused a command: a line problem from serial.ts, or a lift reason. */
export const LiftAckReasonSchema = z.enum([
  ...SerialProblemSchema.options,
  "not_homed",
  "driver_disabled",
  "out_of_range",
  "fault_latched",
  /** The lift's own stop-sense input reads pressed. */
  "stop_pressed",
  /** No Pi heartbeat within LIFT_WATCHDOG_TIMEOUT_MS: the lift moves only while it hears the Pi. */
  "no_heartbeat",
  /** The latest heartbeat's `hold_request_id` isn't this command's: nobody is holding the control for it. */
  "not_held",
  /** Another move or homing is running; stop it first. */
  "busy",
  /** The command's seq isn't above the last Pi seq the lift accepted since the last `hello.request`. */
  "stale_seq",
  /** This request id (or a later one under the same boot prefix) was already accepted: it never runs twice. */
  "request_used",
  /** `lift.clear` while a fault's cause (the stop, a pressed switch, missing heartbeat) is still present. */
  "cause_present",
  /** `lift.enable` false off the bottom switch on a build that isn't disable-safe: the carriage could drop. */
  "disable_unsafe",
]);
export type LiftAckReason = z.infer<typeof LiftAckReasonSchema>;

/** Lift → Pi: a command was received and checked (or not). Not completion. */
export const LiftAckSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("lift.ack"),
    request_id: LiftRequestIdSchema,
    result: z.enum(["accepted", "rejected"]),
    reason: LiftAckReasonSchema.optional(),
    uptime_ms: uptime,
  })
  .refine((a) => (a.result === "rejected") === (a.reason !== undefined), {
    message: "A rejection names a reason; an acceptance has none.",
    path: ["reason"],
  });

/**
 * Pi → lift every LIFT_HEARTBEAT_INTERVAL_MS, from the motion coordinator's control loop. `hold_request_id` is
 * the hold lease: the request a person at the walker is holding the screen's hold control for right now, or
 * null. The Pi stops sending heartbeats when it stops hearing
 * `lift.status`, so a one-way break also stops the lift.
 */
export const LiftHeartbeatSchema = z.strictObject({
  ...envelope,
  type: z.literal("lift.heartbeat"),
  hold_request_id: LiftRequestIdSchema.nullable(),
});

const command = { ...envelope, request_id: LiftRequestIdSchema };

/** Pi → lift: find home (rule 7). Hold-to-run. */
export const LiftHomeSchema = z.strictObject({ ...command, type: z.literal("lift.home") });
/** Pi → lift: go to `target_mm` at up to `speed_mm_s`, accelerating at the firmware's limit. Homed only. Hold-to-run. */
export const LiftMoveSchema = z.strictObject({
  ...command,
  type: z.literal("lift.move"),
  target_mm: height,
  speed_mm_s: z.number().positive().max(LIFT_SPEED_CEILING_MM_S),
});
/** Pi → lift: stop now (ramp down at LIFT_STOP_DECEL_MM_S2) and hold. Always accepted (rule 6). */
export const LiftStopSchema = z.strictObject({ ...command, type: z.literal("lift.stop") });
/** Pi → lift: driver enable on (holds the carriage) or off (frees it and clears homed; always accepted, rule 6). */
export const LiftEnableSchema = z.strictObject({ ...command, type: z.literal("lift.enable"), enabled: z.boolean() });
/** Pi → lift: clear latched faults (rule 9), relayed only from a confirmed local `fault.clear`. */
export const LiftClearSchema = z.strictObject({ ...command, type: z.literal("lift.clear") });

/** `hello.request` and `error` are serial.ts's own lines; on a lift port the lift's id or `any` is the destination. */
export const LiftSerialMessageSchema = z.discriminatedUnion("type", [
  SerialHelloRequestSchema,
  SerialErrorSchema,
  LiftHelloSchema,
  LiftStatusSchema,
  LiftDoneSchema,
  LiftAckSchema,
  LiftHeartbeatSchema,
  LiftHomeSchema,
  LiftMoveSchema,
  LiftStopSchema,
  LiftEnableSchema,
  LiftClearSchema,
]);
export type LiftSerialMessage = z.infer<typeof LiftSerialMessageSchema>;

/** Rule 6: the one command the lift accepts whatever its state, sequence, heartbeat or switches. */
export function isAlwaysAcceptedLiftCommand(message: LiftSerialMessage): boolean {
  return message.type === "lift.stop";
}

/** Rule 6: the commands that skip the sequence check (a disable can still be refused `disable_unsafe`). */
export function skipsLiftSeqCheck(message: LiftSerialMessage): boolean {
  return message.type === "lift.stop" || (message.type === "lift.enable" && !message.enabled);
}

export const LIFT_SERIAL_MESSAGE_TYPES = LiftSerialMessageSchema.options.map((o) => o.shape.type.value);
/** The lift's own types (all but the shared `hello.request` and `error`). */
export const LIFT_ONLY_MESSAGE_TYPES = LIFT_SERIAL_MESSAGE_TYPES.filter((t) => t.startsWith("lift."));
/** Lines the Pi sends to the lift; the rest come from the lift (`error` goes either way). */
export const LIFT_PI_MESSAGE_TYPES = ["hello.request", "lift.heartbeat", "lift.home", "lift.move", "lift.stop", "lift.enable", "lift.clear"] as const;

const knownTypes = new Set<string>(LIFT_SERIAL_MESSAGE_TYPES);
const utf8 = new TextEncoder();

export type LiftSerialParseResult =
  | { ok: true; message: LiftSerialMessage }
  | {
      ok: false;
      problem: "oversize" | "malformed" | "unsupported_version" | "unknown_type" | "invalid_field";
      detail: string;
    };

/**
 * Parses one line on a lift port, with or without its `\n`, in the same order as `parseSerialLine` (size,
 * JSON, `v`, `type`, fields). Never throws. On a port whose module hasn't said hello yet, the Pi tries
 * `parseSerialLine` first and this parser when that answers `unknown_type` for a `lift.` type; the first
 * `hello` or `lift.hello` decides the port's parser from then on.
 */
export function parseLiftSerialLine(line: string): LiftSerialParseResult {
  const text = line.endsWith("\n") ? line.slice(0, -1) : line;
  if (text.length + 1 > SERIAL_MAX_LINE_BYTES || utf8.encode(text).length + 1 > SERIAL_MAX_LINE_BYTES) {
    return { ok: false, problem: "oversize", detail: `Longer than ${SERIAL_MAX_LINE_BYTES} bytes.` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problem: "malformed", detail: "Not JSON." };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, problem: "malformed", detail: "Not a JSON object." };
  }
  const { v, type } = data as Record<string, unknown>;
  if (v !== LIFT_SERIAL_PROTOCOL_VERSION) {
    return { ok: false, problem: "unsupported_version", detail: `Expected v ${LIFT_SERIAL_PROTOCOL_VERSION}.` };
  }
  if (typeof type !== "string" || !knownTypes.has(type)) {
    return { ok: false, problem: "unknown_type", detail: "Unknown message type." };
  }
  const parsed = LiftSerialMessageSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problem: "invalid_field", detail: `${issue?.path.join(".") || "line"}: ${issue?.message}` };
  }
  return { ok: true, message: parsed.data };
}
