import { z } from "zod";
import { ModuleIdSchema } from "./catalog";
import {
  SerialModuleIdSchema,
  ZoneDistanceSchema,
  ZoneNameSchema,
  ZoneQualitySchema,
  distanceMatchesQuality,
} from "./serial";

/**
 * Pi ↔ cloud device contract, version 1: what the Pi reports about its hardware and sensors, and the
 * action requests and status reports for physical tasks. Carried by the proposed `/api/v1/devices/...`
 * routes in docs/interfaces.md. Specified only: no Pi or cloud code uses it yet. Objects are strict.
 */

export const DEVICE_API_VERSION = 1;

// ---- Capability manifest ----

/** `unavailable`: not detected, unplugged, or heartbeats stopped. The Pi decides this, not the module. */
export const ModuleHealthSchema = z.enum(["ok", "degraded", "fault", "unavailable"]);

export const ManifestModuleSchema = z.strictObject({
  module_id: ModuleIdSchema,
  /** Provisioned hardware ID, such as `hand-left-01`. For an ESP32 it is the serial `module_id`. */
  instance_id: SerialModuleIdSchema,
  /** null when the part doesn't report one. */
  firmware_version: z.string().min(1).max(32).nullable(),
  /** Serial protocol version from the hello; null for parts with their own protocol (cameras, arm drivers). */
  protocol_version: z.int().positive().nullable(),
  health: ModuleHealthSchema,
  faults: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/).max(32)).max(8),
  /** When the Pi last heard from the part. */
  observed_at: z.iso.datetime(),
});

/** Built from detected, healthy hardware, not from the user's selected configuration. */
export const CapabilityManifestSchema = z.strictObject({
  /** null until the Pi has fetched a configuration. */
  device_configuration_version: z.int().positive().nullable(),
  generated_at: z.iso.datetime(),
  modules: z.array(ManifestModuleSchema).max(32),
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;

// ---- Sensor snapshot ----

/**
 * One zone as the Pi last saw it. `captured_at` is when the Pi received the reading and `expires_at` when
 * it stops counting; the Pi sets both from its own clock. Read zones through `readZone`.
 */
export const SnapshotZoneSchema = z
  .strictObject({
    zone: ZoneNameSchema,
    instance_id: SerialModuleIdSchema,
    mm: ZoneDistanceSchema.nullable(),
    quality: ZoneQualitySchema,
    captured_at: z.iso.datetime(),
    expires_at: z.iso.datetime(),
  })
  .refine(distanceMatchesQuality, { message: "mm is a number exactly when quality is valid.", path: ["mm"] })
  .refine((r) => Date.parse(r.captured_at) <= Date.parse(r.expires_at), {
    message: "expires_at is not before captured_at.",
    path: ["expires_at"],
  });

/** A compact snapshot for the cloud, not a stream. A zone left out is unknown. */
export const SensorSnapshotSchema = z.strictObject({
  generated_at: z.iso.datetime(),
  zones: z
    .array(SnapshotZoneSchema)
    .max(32)
    .refine((zones) => new Set(zones.map((r) => r.zone)).size === zones.length, "Each zone appears once."),
});
export type SensorSnapshot = z.infer<typeof SensorSnapshotSchema>;

export type ZoneReading =
  | { status: "measured"; mm: number; captured_at: string }
  | { status: "unknown"; reason: "missing" | "invalid" | "stale" };

/**
 * What the snapshot says about one zone at `now`. Missing, invalid and expired zones are unknown, never
 * clear: no reading must not be taken to mean nothing is there.
 */
export function readZone(snapshot: SensorSnapshot, zone: string, now: Date): ZoneReading {
  const entry = snapshot.zones.find((r) => r.zone === zone);
  if (!entry) return { status: "unknown", reason: "missing" };
  if (entry.quality !== "valid" || entry.mm === null) return { status: "unknown", reason: "invalid" };
  // Written so an unparseable expiry (NaN) also reads as stale.
  if (!(now.getTime() < Date.parse(entry.expires_at))) return { status: "unknown", reason: "stale" };
  return { status: "measured", mm: entry.mm, captured_at: entry.captured_at };
}

// ---- Actions ----

/** From model output: labels to match against what the cameras see, never instructions. */
const label = z.string().trim().min(1).max(64);

/**
 * Cloud → Pi: an intent, never joint angles. The Pi checks id, expiry, configuration version, capability,
 * state and the user's start, plans bounded motion locally, and may reject any request. A repeated
 * `action_id` gets its existing status back and never repeats motion.
 */
export const ActionRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    action_id: z.uuid(),
    kind: z.literal("manipulation.pick_place"),
    expires_at: z.iso.datetime(),
    device_configuration_version: z.int().positive(),
    parameters: z.strictObject({ object_label: label, destination_label: label }),
    /** Every v1 action moves hardware, so none can skip the user's start signal. */
    requires_user_start: z.literal(true),
  }),
]);
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionStatusSchema = z.enum([
  "accepted",
  "rejected",
  "started",
  "progress",
  "completed",
  "cancelled",
  "failed",
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

/** Which status may follow which. Each action ends in exactly one terminal status, and nothing follows it. */
const NEXT_STATUS: Record<ActionStatus | "none", readonly ActionStatus[]> = {
  none: ["accepted", "rejected"],
  accepted: ["started", "cancelled", "failed"],
  started: ["progress", "completed", "cancelled", "failed"],
  progress: ["progress", "completed", "cancelled", "failed"],
  rejected: [],
  completed: [],
  cancelled: [],
  failed: [],
};

export function isTerminalActionStatus(status: ActionStatus): boolean {
  return NEXT_STATUS[status].length === 0;
}

/** `previous` is null for an action's first report. */
export function canFollowActionStatus(previous: ActionStatus | null, next: ActionStatus): boolean {
  return NEXT_STATUS[previous ?? "none"].includes(next);
}

export const ActionReasonSchema = z.enum([
  /** Past `expires_at`, including no start signal in time. */
  "expired",
  "configuration_mismatch",
  /** A needed module or camera is missing or unhealthy. */
  "capability_unavailable",
  "stale_sensors",
  /** Stop engaged or drivers disabled. */
  "stopped",
  /** Another action is running. */
  "busy",
  /** Local stop or cancel, or the user declined to start. */
  "user_cancelled",
  "cloud_cancelled",
  /** Arm or lift fault, limit hit or lost communication; drivers are disabled. */
  "fault",
]);

const NEEDS_REASON = new Set<ActionStatus>(["rejected", "cancelled", "failed"]);

/** Pi → cloud, one report per status event. */
export const ActionStatusReportSchema = z
  .strictObject({
    action_id: z.uuid(),
    /** Counts this action's reports from 0, so a retried POST can be recognised. */
    seq: z.int().nonnegative(),
    status: ActionStatusSchema,
    reason: ActionReasonSchema.optional(),
    /** Short note for logs and the status screen; never personal data. */
    detail: z.string().max(200).optional(),
    reported_at: z.iso.datetime(),
  })
  .refine((r) => NEEDS_REASON.has(r.status) === (r.reason !== undefined), {
    message: "rejected, cancelled and failed name a reason; other statuses don't.",
    path: ["reason"],
  });
export type ActionStatusReport = z.infer<typeof ActionStatusReportSchema>;
