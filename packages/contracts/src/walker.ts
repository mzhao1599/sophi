import { z } from "zod";
import { LiftPresetSchema } from "./motion";
import { CATALOG_VERSION, ModuleIdSchema, type ModuleId } from "./catalog";
import {
  CapabilityManifestSchema,
  ModuleHealthSchema,
  SensorSnapshotSchema,
  readZone,
  type CapabilityManifest,
  type SensorSnapshot,
} from "./device";
import { CueSchema, type Cue } from "./onboarding";
import { SerialModuleIdSchema, ZoneDistanceSchema, ZoneNameSchema } from "./serial";

/**
 * The always-on walker assistant, version 1: pairing a walker, its heartbeat, its own configuration, the
 * assistant turn, proposals and the status view the "Your walker" page shows. Two callers with separate
 * proofs: the Pi (`/api/v1/devices/...`, a bearer device credential) and the owner's page
 * (`/api/v1/walkers/...`, the `walker_owner` cookie). Neither proof works on the other's routes. Nothing
 * here moves hardware: the only change a walker can make from a turn is its alert cues, and only after a
 * person confirms it. Objects are strict. Unreleased: no walker has shipped.
 */

/** The Pi reports every few seconds. The server counts the walker offline after a missed few. */
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const OFFLINE_AFTER_MS = 15_000;
/**
 * A snapshot older than this on the server's clock is unknown, whatever the Pi stamped on it. Longer than
 * one heartbeat, so readings don't flicker to unknown between reports; a turn carries its own snapshot.
 */
export const SNAPSHOT_MAX_AGE_MS = HEARTBEAT_INTERVAL_MS + 2_000;
/** The latest shared GPS fix is shown for at most one minute; sweeps erase expired fixes. */
export const LOCATION_FIX_MAX_AGE_MS = 60_000;
/** A proposal not answered by then is expired. */
export const PROPOSAL_TTL_MS = 60_000;
export const PAIRING_CODE_TTL_MS = 10 * 60_000;
/**
 * Wrong pairing codes from one client address: PAIRING_MAX_WRONG of them within a sliding window lock that
 * address out until the oldest of them is PAIRING_LOCK_WINDOW_MS old.
 */
export const PAIRING_MAX_WRONG = 5;
export const PAIRING_LOCK_WINDOW_MS = 10 * 60_000;
/** Turns and walker lines are deleted this long after they happen, the same window as onboarding sessions. */
export const WALKER_HISTORY_RETENTION_MS = 60 * 60_000;
export const MAX_WALKERS_PER_OWNER = 8;
/** Voice clip bounds: 16 kHz mono 16-bit WAV. */
export const VOICE_CLIP_MAX_MS = 15_000;
/** 15 s of 16 kHz mono 16-bit audio is 480,000 bytes plus a 44-byte header. */
export const VOICE_CLIP_MAX_BYTES = 500_000;
/** A spoken reply from the server's voice (Cartesia): 16 kHz mono 16-bit WAV, about a minute at most. */
export const SPEECH_MAX_BYTES = 2_000_000;
/** The walker keeps at most this many unsent lines, dropping the oldest; one heartbeat carries them all. */
export const MAX_QUEUED_EVENTS = 50;
export const MAX_EVENT_AGE_MS = 24 * 60 * 60_000;
export const RECENT_TURNS = 10;
/** Maximum read-only tool steps in one spoken question. */
export const WALKER_MAX_TOOL_CALLS = 8;

const id = z.uuid();
const time = z.iso.datetime();

function base64(maxBytes: number) {
  return z
    .string()
    .min(4)
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)
    .refine((s) => s.length % 4 === 0, "Base64 comes in groups of four characters.");
}

const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
/** Cues with no repeats. */
export const CueListSchema = z.array(CueSchema).min(1).max(4).refine(unique, "Each cue appears once.");

// ---- Configuration ----

/**
 * The walker's own configuration. Version 1 is the walker setup below, made at pairing; each confirmed
 * change adds the next version and never edits an old one. A walker has applied a version when its
 * manifest's `device_configuration_version` says so, not when the server saved it.
 */
export const WalkerConfigurationSchema = z.strictObject({
  version: z.int().positive(),
  catalog_version: z.int().positive(),
  selected_module_ids: z.array(ModuleIdSchema).min(1).max(16).refine(unique, "Each module appears once."),
  cues: CueListSchema,
  created_at: time,
});
export type WalkerConfiguration = z.infer<typeof WalkerConfigurationSchema>;

/**
 * The walker the demo pairs: hand controls, obstacle sensors and voice, alerting by vibration and speech.
 * It is not Wren's setup from the onboarding script; she declined voice.
 */
export const WALKER_SETUP: Pick<WalkerConfiguration, "catalog_version" | "selected_module_ids" | "cues"> = {
  catalog_version: CATALOG_VERSION,
  selected_module_ids: ["base.walker", "controls.hand", "perception.tof", "voice"],
  cues: ["vibration", "spoken"],
};

/**
 * Which part delivers each cue on a walker. A walker may have a screen for its own UI (circle.ts's
 * `ScreenState`), but the screen is not an alert channel and no part reports its health, so the `screen` cue
 * stays undeliverable.
 */
const CUE_NEEDS: Record<Cue, ModuleId | null> = {
  vibration: "controls.hand",
  sound: "voice",
  spoken: "voice",
  screen: null,
};

export type CuesProblem = "empty" | "duplicate" | "unchanged" | "undeliverable" | "alerts_off";

/**
 * Whether a walker may switch to `next` cues. Every cue needs a part that can deliver it, and a walker with
 * obstacle sensors keeps a buzz or a short sound, the two ways obstacle alerts play, so a change can never
 * silently turn obstacle alerts off.
 */
export function checkCuesChange(
  current: readonly Cue[],
  next: readonly Cue[],
  selected: readonly ModuleId[],
): CuesProblem | null {
  if (next.length === 0) return "empty";
  if (!unique(next)) return "duplicate";
  if (sameCues(current, next)) return "unchanged";
  if (next.some((cue) => CUE_NEEDS[cue] === null || !selected.includes(CUE_NEEDS[cue]))) return "undeliverable";
  if (selected.includes("perception.tof") && !next.includes("vibration") && !next.includes("sound")) return "alerts_off";
  return null;
}

/** Same cues in any order. Both lists are repeat-free (CueListSchema). */
export function sameCues(a: readonly Cue[], b: readonly Cue[]): boolean {
  return a.length === b.length && a.every((cue) => b.includes(cue));
}

// ---- Proposals ----

/**
 * Something the assistant offers to change, which happens only when a person confirms it by id, from the
 * walker's Confirm button or the page; voice can't confirm. One open proposal per walker: a new one
 * supersedes it. It expires PROPOSAL_TTL_MS after it was made, and for good when the walker goes offline
 * (the server marks it expired on the first read after a gap longer than OFFLINE_AFTER_MS; it never comes
 * back on reconnect). Answering anything but an open proposal gets `409 proposal_closed` with the proposal
 * as it stands, so a retried Confirm that already won sees `confirmed`. Only confirming the one open
 * proposal changes the configuration; if its base version ever moved anyway, the server supersedes it.
 * No proposal opens while the walker is offline. `summary` is written by the server
 * from the payload, never by the model. `client_turn_id` names the turn that made it, so a walker that
 * cancelled that turn can decline it.
 */
export const ProposalStateSchema = z.enum(["open", "confirmed", "declined", "expired", "superseded"]);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

export const ProposalViewSchema = z
  .strictObject({
    proposal_id: id,
    client_turn_id: id,
    kind: z.literal("cues_change"),
    from_cues: CueListSchema,
    cues: CueListSchema,
    base_configuration_version: z.int().positive(),
    /** Short enough that "Still waiting for you: <summary> Press Confirm to do it." fits in a reply. */
    summary: z.string().min(1).max(120),
    state: ProposalStateSchema,
    created_at: time,
    expires_at: time,
    /** Set exactly when confirmed: the configuration version the change created. */
    configuration_version: z.int().positive().nullable(),
  })
  .refine((p) => (p.state === "confirmed") === (p.configuration_version !== null), {
    message: "configuration_version is set exactly when confirmed.",
    path: ["configuration_version"],
  })
  .refine((p) => !sameCues(p.from_cues, p.cues), { message: "A proposal changes the cues.", path: ["cues"] })
  .refine((p) => Date.parse(p.created_at) < Date.parse(p.expires_at), {
    message: "expires_at is after created_at.",
    path: ["expires_at"],
  });
export type ProposalView = z.infer<typeof ProposalViewSchema>;

/** Open and not past its expiry. The server also expires it when the walker goes offline. */
export function isOpenProposal(p: Pick<ProposalView, "state" | "expires_at">, now: Date): boolean {
  return p.state === "open" && now.getTime() < Date.parse(p.expires_at);
}

export const AnswerProposalRequestSchema = z.strictObject({ answer: z.enum(["confirm", "decline"]) });
export type AnswerProposalRequest = z.infer<typeof AnswerProposalRequestSchema>;

// ---- Turns and walker lines ----

const typedText = z.string().trim().min(1).max(500);

/** A clip from the walker's microphone. It is sent to the model with the turn, then dropped; nothing keeps it. */
export const VoiceClipSchema = z.strictObject({
  type: z.literal("audio"),
  mime: z.literal("audio/wav"),
  /** Base64 of the WAV file, at most VOICE_CLIP_MAX_BYTES before encoding. */
  data_base64: base64(VOICE_CLIP_MAX_BYTES),
  duration_ms: z.int().min(1).max(VOICE_CLIP_MAX_MS),
});

export const TextInputSchema = z.strictObject({ type: z.literal("text"), text: typedText });

/** Tool results supplied by the paired Pi during one user-initiated turn. Coordinates never appear here. */
export const WalkerToolResultSchema = z.strictObject({
  name: z.enum(["get_location", "get_distance", "get_weather"]),
  text: z.string().trim().min(1).max(1000),
});
export type WalkerToolResult = z.infer<typeof WalkerToolResultSchema>;

/** The walker sends voice or text, with the snapshot it has at that moment (null without obstacle sensors). */
export const DeviceTurnRequestSchema = z.strictObject({
  client_turn_id: id,
  input: z.discriminatedUnion("type", [VoiceClipSchema, TextInputSchema]),
  snapshot: SensorSnapshotSchema.nullable(),
  /** Present on a continuation. The first step's transcript is sent as text; no audio is replayed. */
  tool_results: z.array(WalkerToolResultSchema).max(WALKER_MAX_TOOL_CALLS).optional(),
  original_audio: z.boolean().optional(),
}).refine((r) => !r.tool_results || (r.input.type === "text" && r.original_audio !== undefined), { message: "A continuation carries the original question as text.", path: ["tool_results"] });
export type DeviceTurnRequest = z.infer<typeof DeviceTurnRequestSchema>;

/** The page sends text only. */
export const PageTurnRequestSchema = z.strictObject({ client_turn_id: id, input: TextInputSchema });
export type PageTurnRequest = z.infer<typeof PageTurnRequestSchema>;

export const WalkerTurnViewSchema = z
  .strictObject({
    turn_id: id,
    client_turn_id: id,
    source: z.enum(["walker", "page"]),
    /** Her words: what she typed, or the model's transcript of the clip; null when nothing was transcribed. */
    heard: z.string().max(1000).nullable(),
    /** `typed`, or who transcribed the clip, so the page can say "as heard by Gemini". */
    heard_by: z.enum(["typed", "gemini"]).nullable(),
    reply: z.string().min(1).max(600),
    /**
     * `model` when the model's reply is what the person gets: its own words, or an offer it chose, worded by the
     * server ("I can switch… Press Confirm to do it."), with any line the server appends. `fixed` when the
     * server's own fixed reply replaced it: the model didn't answer (an error, a refusal, a bad reply twice, the
     * deadline, no key), or a rule overrode it (robot arms, a change the walker can't make, a change while
     * offline).
     */
    answered_by: z.enum(["model", "fixed"]),
    /**
     * The voice the server offered for the reply: Cartesia's when it sent speech, otherwise the walker's own.
     * null for page turns, which aren't spoken. What actually played (or a cancelled playback) only the walker
     * knows; it doesn't change this.
     */
    voiced_by: z.enum(["cartesia", "walker"]).nullable(),
    created_at: time,
  })
  .refine((t) => (t.heard === null) === (t.heard_by === null), { message: "heard and heard_by go together.", path: ["heard_by"] })
  .refine((t) => t.source === "walker" || (t.heard_by === "typed" && t.voiced_by === null), {
    message: "A page turn is typed and not spoken.",
    path: ["heard_by"],
  });
export type WalkerTurnView = z.infer<typeof WalkerTurnViewSchema>;

/**
 * A line the walker said on its own, with no turn behind it: a fixed notice ("Sophi is on", a part stopped
 * responding, "pair me again") or its offline reply to a Talk press. Status lines only, never a clip. The
 * walker keeps the newest MAX_QUEUED_EVENTS until a heartbeat succeeds; the server ignores an `event_id`
 * it already has. `ago_ms` is how long before sending it was said, measured on a monotonic clock (one that
 * never jumps, like `performance.now()`), never by subtracting wall-clock times: a Pi has no battery clock,
 * and its date jumps when it syncs after boot. The walker drops lines older than MAX_EVENT_AGE_MS, so one
 * old line can't get every heartbeat refused.
 */
export const WalkerEventSchema = z.strictObject({
  event_id: id,
  kind: z.enum(["notice", "local_reply"]),
  text: z.string().min(1).max(200),
  ago_ms: z.int().min(0).max(MAX_EVENT_AGE_MS),
});
export type WalkerEvent = z.infer<typeof WalkerEventSchema>;

/** As the page shows it: `at` is the server's receive time minus `ago_ms`. */
export const WalkerEventViewSchema = z.strictObject({
  event_id: id,
  kind: WalkerEventSchema.shape.kind,
  text: WalkerEventSchema.shape.text,
  at: time,
});
export type WalkerEventView = z.infer<typeof WalkerEventViewSchema>;

/**
 * The reply in the server's voice (Cartesia), for the walker to play: 16 kHz mono 16-bit WAV. A reply that
 * would be longer than SPEECH_MAX_BYTES comes back without speech, and the walker speaks it itself.
 */
export const SpeechSchema = z.strictObject({
  mime: z.literal("audio/wav"),
  data_base64: base64(SPEECH_MAX_BYTES),
});

/** A paired Pi may voice one of its own short notices without creating a conversation turn. */
export const DeviceSpeechRequestSchema = z.strictObject({ text: z.string().trim().min(1).max(200) });
export const DeviceSpeechResponseSchema = z.strictObject({ speech: SpeechSchema.nullable() });
export type DeviceSpeechResponse = z.infer<typeof DeviceSpeechResponseSchema>;

// ---- Status view ----

export const ZoneViewSchema = z.strictObject({
  zone: ZoneNameSchema,
  instance_id: SerialModuleIdSchema,
  simulated: z.boolean(),
  reading: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("measured"), mm: ZoneDistanceSchema, age_ms: z.int().nonnegative() }),
    z.strictObject({ status: z.literal("unknown"), reason: z.enum(["missing", "invalid", "stale"]) }),
  ]),
});
export type ZoneView = z.infer<typeof ZoneViewSchema>;

export const PartViewSchema = z.strictObject({
  module_id: ModuleIdSchema,
  /** null for a part in the configuration that the walker hasn't reported. */
  instance_id: SerialModuleIdSchema.nullable(),
  /** `unavailable` also covers a configured part the walker never reported, and every part while offline. */
  health: ModuleHealthSchema,
  simulated: z.boolean(),
  in_configuration: z.boolean(),
});
export type PartView = z.infer<typeof PartViewSchema>;

/** What the page shows and the assistant reads, built on the server. */
export const WalkerStatusViewSchema = z
  .strictObject({
    device_id: id,
    name: z.string().min(1).max(40),
    online: z.boolean(),
    last_seen_at: time.nullable(),
    simulator: z.boolean(),
    configuration: WalkerConfigurationSchema,
    /** From the walker's manifest; null until it reports one. */
    applied_configuration_version: z.int().positive().nullable(),
    parts: z.array(PartViewSchema).max(32),
    zones: z.array(ZoneViewSchema).max(32),
    open_proposal: ProposalViewSchema.refine((p) => p.state === "open", "Only an open proposal is open.").nullable(),
    /** Oldest first, at most RECENT_TURNS each. */
    turns: z.array(WalkerTurnViewSchema).max(RECENT_TURNS),
    walker_said: z.array(WalkerEventViewSchema).max(RECENT_TURNS),
  })
  .refine(
    (s) =>
      s.online ||
      (s.open_proposal === null &&
        s.parts.every((p) => p.health === "unavailable") &&
        s.zones.every((zone) => zone.reading.status === "unknown")),
    { message: "An offline walker has no open proposal, no available part and no measured zone.", path: ["online"] },
  );
export type WalkerStatusView = z.infer<typeof WalkerStatusViewSchema>;

/**
 * One zone as the server should present it. Two clocks never meet: the Pi's own stamps decide whether the
 * reading was still valid when the Pi sent it (`generated_at`), and the server's clock decides how long ago
 * the server got it. Older than SNAPSHOT_MAX_AGE_MS on the server's clock is stale.
 */
export function zoneViewReading(
  snapshot: SensorSnapshot,
  zone: string,
  receivedAtMs: number,
  nowMs: number,
): ZoneView["reading"] {
  const atSend = readZone(snapshot, zone, new Date(snapshot.generated_at));
  if (atSend.status === "unknown") return atSend;
  const sinceReceipt = nowMs - receivedAtMs;
  if (!(sinceReceipt >= 0 && sinceReceipt <= SNAPSHOT_MAX_AGE_MS)) return { status: "unknown", reason: "stale" };
  const ageAtSend = Math.max(0, Date.parse(snapshot.generated_at) - Date.parse(atSend.captured_at));
  return { status: "measured", mm: atSend.mm, age_ms: Math.round(ageAtSend + sinceReceipt) };
}

/**
 * Every zone in the snapshot as the page and the model see it. A zone's `simulated` is the flag of the
 * manifest part with the same `instance_id` (each part's own flag carries the truth, even on a simulator
 * with a real part plugged in); a zone from a part the manifest doesn't list reads as unknown and
 * simulated, since nothing vouches for it. Offline walkers show every zone unknown.
 */
export function zoneViews(
  snapshot: SensorSnapshot | null,
  manifest: CapabilityManifest | null,
  receivedAtMs: number,
  nowMs: number,
  online: boolean,
): ZoneView[] {
  if (!snapshot) return [];
  return snapshot.zones.map((entry) => {
    const part = manifest?.modules.find((m) => m.instance_id === entry.instance_id);
    const base = { zone: entry.zone, instance_id: entry.instance_id, simulated: part ? part.simulated : true };
    if (!part) return { ...base, reading: { status: "unknown", reason: "missing" } };
    if (!online) return { ...base, reading: { status: "unknown", reason: "stale" } };
    return { ...base, reading: zoneViewReading(snapshot, entry.zone, receivedAtMs, nowMs) };
  });
}

// ---- Device routes (the Pi) ----

/** POST /api/v1/devices/pair: no credential yet, the code proves the owner asked. */
export const PairDeviceRequestSchema = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  name: z.string().trim().min(1).max(40).optional(),
  service_version: z.string().min(1).max(32),
});
export type PairDeviceRequest = z.infer<typeof PairDeviceRequestSchema>;

/**
 * The credential is shown once; the server keeps only its SHA-256. The walker adopts `configuration` as
 * its current one: versions are numbered per device and start again at 1 for every pairing. Pairing isn't
 * idempotent (a code works once), so a walker warms `GET /api/v1/health` before claiming a code, in case
 * a sleeping server takes a minute to wake.
 */
export const PairDeviceResponseSchema = z.strictObject({
  device_id: id,
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  configuration: WalkerConfigurationSchema,
});
export type PairDeviceResponse = z.infer<typeof PairDeviceResponseSchema>;

/** POST /api/v1/devices/{id}/heartbeat, every HEARTBEAT_INTERVAL_MS. */
export const HeartbeatRequestSchema = z.strictObject({
  sent_at: time,
  service_version: z.string().min(1).max(32),
  /** A simulator can have real parts plugged in: each part's own `simulated` flag carries the truth. */
  manifest: CapabilityManifestSchema,
  /** null when the walker has no obstacle sensors attached. */
  snapshot: SensorSnapshotSchema.nullable(),
  /** Present only after the server has enabled sharing; absent on older Pi software. */
  location: z.strictObject({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180), age_ms: z.int().min(0).max(30_000) }).optional(),
  /** Lines said since the last heartbeat that succeeded, newest MAX_QUEUED_EVENTS at most. */
  events: z
    .array(WalkerEventSchema)
    .max(MAX_QUEUED_EVENTS)
    .refine((events) => unique(events.map((e) => e.event_id)), "Each event_id appears once."),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

/**
 * The walker fetches the configuration when `configuration_version` is newer than what it has applied.
 * The walker never judges a proposal's expiry by its own clock: a Confirm press always asks the server.
 */
export const HeartbeatResponseSchema = z.strictObject({
  configuration_version: z.int().positive(),
  /** Missing on older servers means off. Only the walker user's phone can change this. */
  location_sharing_enabled: z.boolean().optional(),
  open_proposal: ProposalViewSchema.refine((p) => p.state === "open", "Only an open proposal is open.").nullable(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponseSchema>;

/** GET /api/v1/devices/{id}/configuration. */
export const ConfigurationResponseSchema = z.strictObject({ configuration: WalkerConfigurationSchema });

/**
 * POST /api/v1/devices/{id}/turns and /api/v1/walkers/{id}/turns. A repeated `client_turn_id` gets the
 * stored turn and proposal with a fresh status, and runs nothing again. `proposal` is the one this turn
 * opened, if any. `speech` is the reply in the server's voice, on walker turns only; null means the walker
 * speaks `turn.reply` with its own voice (no key, or the voice service failed).
 */
export const WalkerTurnResponseSchema = z
  .strictObject({
    turn: WalkerTurnViewSchema,
    /** The proposal this turn opened, as it stands now: a replay may find it confirmed, declined or expired. */
    proposal: ProposalViewSchema.nullable(),
    speech: SpeechSchema.nullable(),
    status: WalkerStatusViewSchema,
    /** A user-initiated device tool request. No coordinates cross this route. */
    tool_call: z.strictObject({ name: z.enum(["get_location", "get_distance", "get_weather"]) }).optional(),
    /** Results already gathered in this unfinished turn; the Pi returns them with the next tool result. */
    tool_results: z.array(WalkerToolResultSchema).max(WALKER_MAX_TOOL_CALLS).optional(),
    /** A named lift request, delivered only on a newly saved device turn. The Pi may refuse it. */
    motion_offer: z.strictObject({ preset: LiftPresetSchema }).optional(),
    /** A draft only. The Pi reads this back and requires a fresh Confirm press before POSTing it. */
    message_offer: z.strictObject({ client_message_id: id, to_member_id: id, to_name: z.string().trim().min(1).max(12), text: z.string().trim().min(1).max(30).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*$/u) }).optional(),
  })
  // A replayed turn may come back without its audio, so only speech implies Cartesia, not the reverse.
  .refine((r) => r.speech === null || r.turn.voiced_by === "cartesia", {
    message: "Speech is Cartesia's voice.",
    path: ["turn", "voiced_by"],
  })
  .refine((r) => r.turn.source === "walker" || r.speech === null, { message: "Page turns aren't spoken.", path: ["speech"] })
  .refine((r) => r.proposal === null || r.proposal.client_turn_id === r.turn.client_turn_id, {
    message: "A turn's proposal is the one that turn opened.",
    path: ["proposal", "client_turn_id"],
  });
export type WalkerTurnResponse = z.infer<typeof WalkerTurnResponseSchema>;

/** POST /api/v1/devices/{id}/proposals/{proposal_id} (the Confirm button) and /api/v1/walkers/{id}/proposals/{proposal_id}. */
export const AnswerProposalResponseSchema = z.strictObject({
  proposal: ProposalViewSchema,
  status: WalkerStatusViewSchema,
});
export type AnswerProposalResponse = z.infer<typeof AnswerProposalResponseSchema>;

// ---- Page routes (the owner) ----

/** POST /api/v1/walkers/pairing-codes. Sets the `walker_owner` cookie if the browser has none. */
export const PairingCodeResponseSchema = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  expires_at: time,
});
export type PairingCodeResponse = z.infer<typeof PairingCodeResponseSchema>;

/** GET /api/v1/walkers: the owner's walkers. GET /api/v1/walkers/{id}: one. DELETE answers 204 with no body. */
// ---- Activity (page only) ----
//
// What the server itself saw of a walker's turns, for the /walker page's live companion ("behind the
// scenes"). Page only: it rides on the list response, which the Pi never reads. Never put it in the status
// or turn views, which the Pi parses strictly. It holds no one's words: only kinds, codes and timings. It
// lives in server memory, so a restart empties it; the page then draws only what the status view shows.

/** A turn the server is working on right now: set once the clip or text is accepted, cleared when it ends however it ends. */
export const WalkerTurnInFlightSchema = z.strictObject({
  client_turn_id: id,
  input: z.enum(["audio", "text"]),
  /** When the server accepted it. */
  since: time,
  /** The clip's length; null for typed text. */
  clip_ms: z.int().min(0).nullable(),
  /** "hearing": waiting for the model; "voicing": waiting for Cartesia's audio. */
  stage: z.enum(["hearing", "voicing"]),
});
export type WalkerTurnInFlight = z.infer<typeof WalkerTurnInFlightSchema>;

/** How one saved turn went, measured by the server. Only for turns that saved a new row (never a replay). */
export const WalkerTurnTraceSchema = z.strictObject({
  turn_id: id,
  client_turn_id: id,
  /** When the turn was saved. */
  at: time,
  input: z.enum(["audio", "text"]),
  clip_ms: z.int().min(0).nullable(),
  /** False when no model call was made (no model configured): the page then draws no model step. */
  model_ran: z.boolean(),
  model_ms: z.int().min(0).nullable(),
  /** The rule that decided the reply, as a code ("arms", "offline", "cues_alerts_off", "model_error", …); null when the model's own words were used. */
  rule: z.string().min(1).max(40).nullable(),
  answered_by: z.enum(["model", "fixed"]),
  /** A proposal was opened: its words were written by the server, not the model. */
  proposal_opened: z.boolean(),
  /** The voice the server sent with the reply, not proof it was heard. */
  voiced_by: z.enum(["cartesia", "walker"]).nullable(),
  voice_ms: z.int().min(0).nullable(),
  total_ms: z.int().min(0),
});
export type WalkerTurnTrace = z.infer<typeof WalkerTurnTraceSchema>;

export const WalkerActivityViewSchema = z.strictObject({
  device_id: id,
  in_flight: z.array(WalkerTurnInFlightSchema).max(4),
  /** Oldest first, at most RECENT_TURNS, none older than WALKER_HISTORY_RETENTION_MS. */
  traces: z.array(WalkerTurnTraceSchema).max(RECENT_TURNS),
});
export type WalkerActivityView = z.infer<typeof WalkerActivityViewSchema>;

export const WalkerListResponseSchema = z.strictObject({
  walkers: z.array(WalkerStatusViewSchema).max(MAX_WALKERS_PER_OWNER),
  /** One entry per listed walker that has any; optional so a page and server of different versions still agree. */
  activity: z.array(WalkerActivityViewSchema).max(MAX_WALKERS_PER_OWNER).optional(),
});
export const WalkerResponseSchema = z.strictObject({ walker: WalkerStatusViewSchema });

// ---- Errors ----

export const WalkerErrorCodeSchema = z.enum([
  "invalid_request",
  /** No credential or cookie, or one the server doesn't know (revoked, forgotten). The walker asks to be paired again. */
  "unauthenticated",
  /** Unknown id, or one that belongs to someone else: the two look the same. */
  "not_found",
  "pairing_code_invalid",
  /** Too many wrong codes from this client address recently; it can try again after the window. */
  "pairing_locked",
  /** The owner already has MAX_WALKERS_PER_OWNER walkers; forget one first. */
  "walker_limit",
  /** The proposal isn't open (confirmed, declined, expired or superseded); the body carries it as it stands. */
  "proposal_closed",
  "rate_limited",
  "unavailable",
]);
export type WalkerErrorCode = z.infer<typeof WalkerErrorCodeSchema>;

/** The HTTP status for each code. */
export const WALKER_ERROR_STATUS: Record<WalkerErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  not_found: 404,
  pairing_code_invalid: 400,
  pairing_locked: 429,
  walker_limit: 409,
  proposal_closed: 409,
  rate_limited: 429,
  unavailable: 503,
};

export const WalkerErrorSchema = z.strictObject({
  error: z.strictObject({
    code: WalkerErrorCodeSchema,
    message: z.string(),
    trace_id: z.string(),
    proposal: ProposalViewSchema.optional(),
  }),
});
export type WalkerError = z.infer<typeof WalkerErrorSchema>;
