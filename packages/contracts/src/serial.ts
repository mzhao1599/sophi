import { z } from "zod";

/**
 * Pi ↔ ESP32 serial protocol, version 1: UTF-8 JSON Lines, one USB serial port per module.
 * See docs/interfaces.md ("Pi ↔ ESP32 USB serial"). The Pi service (devices/pi) speaks it; no firmware does yet.
 *
 * Every line carries `v`, `type`, `module_id` and `seq`. `module_id` is the module's provisioned ID
 * (for example `hand-left-01`), not a catalog id: on a module's own message it names the sender, on a
 * Pi command it names the destination. `seq` counts each sender's lines and resets on reboot, which the
 * module announces with a new hello. Objects are strict: a field v1 doesn't document is rejected.
 */

export const SERIAL_PROTOCOL_VERSION = 1;

/** Maximum UTF-8 bytes in one line, counting its `\n`, so a 1024-byte buffer holds any valid line. */
export const SERIAL_MAX_LINE_BYTES = 1024;

/** Proposal, not measured: each module sends a heartbeat about once a second. */
export const SERIAL_HEARTBEAT_INTERVAL_MS = 1000;

/** Proposal, not measured: ToF reports at 10–20 Hz. Controls report edges, not every sample. */
export const SERIAL_TOF_REPORT_HZ = { min: 10, max: 20 } as const;

/**
 * Placeholder, not bench-tested: the longest haptic cue the Pi may request. The proposal only gives a
 * 400 ms example; replace this after measuring the actuator.
 */
export const HAPTIC_MAX_DURATION_MS = 1000;

const snakeName = (max: number) => z.string().regex(/^[a-z][a-z0-9_]*$/).max(max);

export const SerialModuleIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(32);
/** The destination of a `hello.request`: whichever module is on this port. No module is provisioned with it. */
export const SERIAL_ANY_MODULE = "any";
export const SerialRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(40);

/** Why a line or command was refused. Shared by `parseSerialLine`, `ack.reason` and `error.code`. */
export const SerialProblemSchema = z.enum([
  "oversize",
  "malformed",
  "unsupported_version",
  "unknown_type",
  /** Missing field, wrong type, out of range, an extra field, or a value outside an allowlist. */
  "invalid_field",
  /** Valid, but this module lacks the capability (for example haptics on a ToF module). */
  "unsupported",
  /** A bounded queue was full, so the line was dropped. */
  "overflow",
]);
export type SerialProblem = z.infer<typeof SerialProblemSchema>;

const envelope = {
  v: z.literal(SERIAL_PROTOCOL_VERSION),
  module_id: SerialModuleIdSchema,
  seq: z.int().nonnegative(),
};
/** Milliseconds since the module booted. The Pi judges freshness by its own receive time, not this. */
const uptime = z.int().nonnegative();

export const SerialModuleTypeSchema = z.enum(["hand", "perception", "voice"]);
export type SerialModuleType = z.infer<typeof SerialModuleTypeSchema>;

/**
 * Module → Pi on boot, and again whenever it receives a `hello.request`. Capabilities are self-reported
 * and never count as authorization.
 */
export const SerialHelloSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("hello"),
    module_type: SerialModuleTypeSchema,
    capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_.]*$/).max(32)).max(16),
    firmware_version: z.string().min(1).max(32).optional(),
    uptime_ms: uptime.optional(),
  })
  .refine((h) => h.module_id !== SERIAL_ANY_MODULE, { message: `"${SERIAL_ANY_MODULE}" is not a module's id.`, path: ["module_id"] });

/**
 * Pi → module: "send your hello now". The Pi sends it when it opens a port, so a module that didn't
 * reboot when the Pi service restarted still announces itself. One module per port, so `module_id` is
 * SERIAL_ANY_MODULE or the module's own id. The module answers with a hello, keeping its `seq` running
 * (only a reboot resets it), and acts on nothing else in it.
 */
export const SerialHelloRequestSchema = z.strictObject({
  ...envelope,
  type: z.literal("hello.request"),
});

export const SerialHealthSchema = z.enum(["ok", "degraded", "fault"]);

/** Module → Pi. If heartbeats stop, the Pi marks the module unavailable and its readings unknown. */
export const SerialHeartbeatSchema = z.strictObject({
  ...envelope,
  type: z.literal("heartbeat"),
  uptime_ms: uptime,
  health: SerialHealthSchema,
  /** Short codes chosen by the firmware owner, such as `sensor_timeout`. */
  faults: z.array(snakeName(32)).max(8).optional(),
});

/** Module → Pi when a button changes or the trigger moves; unchanged samples are not sent. */
export const SerialHandInputSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("hand.input"),
    uptime_ms: uptime,
    /** A button the module declared as `button.<name>` in its hello. Always sent with `edge`. */
    button: snakeName(16).optional(),
    edge: z.enum(["pressed", "released"]).optional(),
    /** Trigger position from 0 (released) to 1 (fully pulled). */
    trigger: z.number().min(0).max(1).optional(),
  })
  .refine((m) => (m.button === undefined) === (m.edge === undefined), {
    message: "button and edge are sent together.",
    path: ["edge"],
  })
  .refine((m) => m.button !== undefined || m.trigger !== undefined, {
    message: "Report a button edge, a trigger value or both.",
  });

export const ZoneNameSchema = snakeName(24);
/** `invalid` covers any reading the firmware rejected; it reads as unknown, never as clear. */
export const ZoneQualitySchema = z.enum(["valid", "invalid"]);
export type ZoneQuality = z.infer<typeof ZoneQualitySchema>;
/** Millimetres. 65535 is the uint16 ceiling, not a sensor's range. */
export const ZoneDistanceSchema = z.int().min(0).max(65535);

/** A distance is present exactly when the reading is valid. */
export const distanceMatchesQuality = (r: { mm: number | null; quality: ZoneQuality }) =>
  (r.quality === "valid") === (r.mm !== null);
const distanceRule = { message: "mm is a number exactly when quality is valid.", path: ["mm"] };

export const SerialZoneSchema = z
  .strictObject({ name: ZoneNameSchema, mm: ZoneDistanceSchema.nullable(), quality: ZoneQualitySchema })
  .refine(distanceMatchesQuality, distanceRule);

/** Module → Pi at the report rate. */
export const SerialPerceptionZonesSchema = z.strictObject({
  ...envelope,
  type: z.literal("perception.zones"),
  uptime_ms: uptime,
  zones: z
    .array(SerialZoneSchema)
    .min(1)
    .max(16)
    .refine((zones) => new Set(zones.map((zone) => zone.name)).size === zones.length, "Each zone appears once."),
});

/** The only cues firmware plays. Shape and strength are fixed per pattern in firmware; no waveform is sent. */
export const HapticPatternSchema = z.enum(["confirmation", "recording", "near_obstacle", "error"]);

/** Pi → module. Ends after `duration_ms`; a newer haptic.play replaces it rather than queueing (proposal). */
export const SerialHapticPlaySchema = z.strictObject({
  ...envelope,
  type: z.literal("haptic.play"),
  request_id: SerialRequestIdSchema,
  pattern: HapticPatternSchema,
  duration_ms: z.int().min(1).max(HAPTIC_MAX_DURATION_MS),
});

/** Module → Pi: the command was received and validated (or not). Not completion. */
export const SerialAckSchema = z
  .strictObject({
    ...envelope,
    type: z.literal("ack"),
    request_id: SerialRequestIdSchema,
    result: z.enum(["accepted", "rejected"]),
    reason: SerialProblemSchema.optional(),
    uptime_ms: uptime.optional(),
  })
  .refine((a) => (a.result === "rejected") === (a.reason !== undefined), {
    message: "A rejection names a reason; an acceptance has none.",
    path: ["reason"],
  });

/** Either direction: a line that can't be acked (no readable request_id), or a fault outside any request. */
export const SerialErrorSchema = z.strictObject({
  ...envelope,
  type: z.literal("error"),
  code: SerialProblemSchema,
  request_id: SerialRequestIdSchema.optional(),
  /** For logs; never personal data. */
  detail: z.string().max(120).optional(),
  uptime_ms: uptime.optional(),
});

export const SerialMessageSchema = z.discriminatedUnion("type", [
  SerialHelloSchema,
  SerialHelloRequestSchema,
  SerialHeartbeatSchema,
  SerialHandInputSchema,
  SerialPerceptionZonesSchema,
  SerialHapticPlaySchema,
  SerialAckSchema,
  SerialErrorSchema,
]);
export type SerialMessage = z.infer<typeof SerialMessageSchema>;

export const SERIAL_MESSAGE_TYPES = SerialMessageSchema.options.map((o) => o.shape.type.value);
const knownTypes = new Set<string>(SERIAL_MESSAGE_TYPES);
const utf8 = new TextEncoder();

export type SerialParseResult =
  | { ok: true; message: SerialMessage }
  | {
      ok: false;
      problem: Extract<SerialProblem, "oversize" | "malformed" | "unsupported_version" | "unknown_type" | "invalid_field">;
      detail: string;
    };

/**
 * Parses one received line, with or without its `\n`. Never throws: a bad line comes back as a problem
 * code to log or send in an `error` reply, and the reader carries on from the next newline.
 */
export function parseSerialLine(line: string): SerialParseResult {
  const text = line.endsWith("\n") ? line.slice(0, -1) : line;
  // UTF-8 never takes fewer bytes than UTF-16 code units, so a long string is refused before encoding.
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
  if (v !== SERIAL_PROTOCOL_VERSION) {
    return { ok: false, problem: "unsupported_version", detail: `Expected v ${SERIAL_PROTOCOL_VERSION}.` };
  }
  if (typeof type !== "string" || !knownTypes.has(type)) {
    return { ok: false, problem: "unknown_type", detail: "Unknown message type." };
  }
  const parsed = SerialMessageSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, problem: "invalid_field", detail: `${issue?.path.join(".") || "line"}: ${issue?.message}` };
  }
  return { ok: true, message: parsed.data };
}
