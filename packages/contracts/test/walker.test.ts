import { describe, expect, it } from "vitest";
import {
  DeviceTurnRequestSchema,
  HeartbeatRequestSchema,
  MODULE_CATALOG,
  PageTurnRequestSchema,
  PairDeviceResponseSchema,
  ProposalViewSchema,
  SNAPSHOT_MAX_AGE_MS,
  SensorSnapshotSchema,
  VOICE_CLIP_MAX_BYTES,
  WALKER_ERROR_STATUS,
  WALKER_SETUP,
  WalkerConfigurationSchema,
  WalkerErrorCodeSchema,
  WalkerStatusViewSchema,
  WalkerTurnResponseSchema,
  WalkerTurnViewSchema,
  checkCuesChange,
  checkSelection,
  isOpenProposal,
  zoneViewReading,
  zoneViews,
  type CapabilityManifest,
} from "../src";

const T0 = "2026-10-24T09:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const configuration = WalkerConfigurationSchema.parse({ version: 1, ...WALKER_SETUP, created_at: T0 });

describe("walker setup", () => {
  it("is a valid catalog selection with voice on", () => {
    expect(checkSelection(MODULE_CATALOG, WALKER_SETUP.selected_module_ids)).toEqual([]);
    expect(WALKER_SETUP.selected_module_ids).toContain("voice");
  });

  it("refuses empty, unknown and repeated cues, and repeated modules", () => {
    expect(WalkerConfigurationSchema.safeParse({ ...configuration, cues: [] }).success).toBe(false);
    expect(WalkerConfigurationSchema.safeParse({ ...configuration, cues: ["telepathy"] }).success).toBe(false);
    expect(WalkerConfigurationSchema.safeParse({ ...configuration, cues: ["vibration", "vibration"] }).success).toBe(false);
    expect(WalkerConfigurationSchema.safeParse({ ...configuration, selected_module_ids: ["voice", "voice"] }).success).toBe(false);
  });
});

describe("cues changes", () => {
  const demo = WALKER_SETUP.selected_module_ids;

  it("allows switching from buzzing to short sounds", () => {
    expect(checkCuesChange(["vibration", "spoken"], ["sound", "spoken"], demo)).toBeNull();
  });

  it("refuses a change that turns obstacle alerts off", () => {
    expect(checkCuesChange(["vibration", "spoken"], ["spoken"], demo)).toBe("alerts_off");
  });

  it("refuses cues the walker has no part to deliver", () => {
    expect(checkCuesChange(["vibration", "spoken"], ["screen", "vibration"], demo)).toBe("undeliverable");
    // Obstacle sensors and voice but no hand controls: a buzz can't play, so it can't be the alert.
    expect(checkCuesChange(["sound"], ["vibration"], ["base.walker", "perception.tof", "voice"])).toBe("undeliverable");
    expect(checkCuesChange(["vibration"], ["sound"], ["base.walker", "controls.hand"])).toBe("undeliverable");
  });

  it("allows speech only on a walker with no obstacle sensors", () => {
    expect(checkCuesChange(["vibration", "spoken"], ["spoken"], ["base.walker", "controls.hand", "voice"])).toBeNull();
  });

  it("refuses empty, repeated and no-op changes, in any order", () => {
    expect(checkCuesChange(["vibration"], [], ["base.walker", "controls.hand"])).toBe("empty");
    expect(checkCuesChange(["vibration"], ["sound", "sound"], demo)).toBe("duplicate");
    expect(checkCuesChange(["vibration", "spoken"], ["spoken", "vibration"], demo)).toBe("unchanged");
  });
});

describe("zone freshness across two clocks", () => {
  // The Pi's clock runs an hour behind the server's: only each clock's own differences count.
  const piSent = "2026-10-24T08:00:00.300Z";
  const snapshot = SensorSnapshotSchema.parse({
    generated_at: piSent,
    zones: [
      { zone: "front_left", instance_id: "tof-front-01", mm: 610, quality: "valid",
        captured_at: "2026-10-24T08:00:00.200Z", expires_at: "2026-10-24T08:00:00.700Z" },
      { zone: "front_right", instance_id: "tof-front-01", mm: null, quality: "invalid",
        captured_at: "2026-10-24T08:00:00.200Z", expires_at: "2026-10-24T08:00:00.700Z" },
      { zone: "rear", instance_id: "tof-front-01", mm: 900, quality: "valid",
        captured_at: "2026-10-24T07:59:59.000Z", expires_at: "2026-10-24T07:59:59.500Z" },
      { zone: "left", instance_id: "tof-ghost-01", mm: 300, quality: "valid",
        captured_at: "2026-10-24T08:00:00.200Z", expires_at: "2026-10-24T08:00:00.700Z" },
    ],
  });
  const received = Date.parse(T0);

  it("reads a zone the Pi still counted as fresh, received just now, as measured with its age", () => {
    expect(zoneViewReading(snapshot, "front_left", received, received + 400)).toEqual({ status: "measured", mm: 610, age_ms: 500 });
    expect(zoneViewReading(snapshot, "front_left", received, received + 400.6)).toEqual({ status: "measured", mm: 610, age_ms: 501 });
  });

  it("stays measured between two heartbeats", () => {
    expect(zoneViewReading(snapshot, "front_left", received, received + 5_000).status).toBe("measured");
  });

  it("reads invalid, missing and Pi-expired zones as unknown", () => {
    expect(zoneViewReading(snapshot, "front_right", received, received)).toEqual({ status: "unknown", reason: "invalid" });
    expect(zoneViewReading(snapshot, "back", received, received)).toEqual({ status: "unknown", reason: "missing" });
    expect(zoneViewReading(snapshot, "rear", received, received)).toEqual({ status: "unknown", reason: "stale" });
  });

  it("reads a snapshot the server got too long ago, or in its future, as stale", () => {
    expect(zoneViewReading(snapshot, "front_left", received, received + SNAPSHOT_MAX_AGE_MS + 1)).toEqual({ status: "unknown", reason: "stale" });
    expect(zoneViewReading(snapshot, "front_left", received, received - 1)).toEqual({ status: "unknown", reason: "stale" });
  });

  const manifest: CapabilityManifest = {
    device_configuration_version: 1, generated_at: piSent, simulator: false,
    modules: [{ module_id: "perception.tof", instance_id: "tof-front-01", firmware_version: null, protocol_version: 1,
      health: "ok", faults: [], observed_at: piSent, simulated: true }],
  };

  it("takes each zone's simulated flag from its part, and distrusts a part the manifest doesn't list", () => {
    const views = zoneViews(snapshot, manifest, received, received + 100, true);
    expect(views.find((v) => v.zone === "front_left")).toMatchObject({ simulated: true, reading: { status: "measured" } });
    expect(views.find((v) => v.zone === "left")).toEqual({
      zone: "left", instance_id: "tof-ghost-01", simulated: true, reading: { status: "unknown", reason: "missing" },
    });
  });

  it("trusts a real part plugged into a simulator", () => {
    const mixed = { ...manifest, simulator: true, modules: [{ ...manifest.modules[0]!, simulated: false }] };
    expect(zoneViews(snapshot, mixed, received, received + 100, true).find((v) => v.zone === "front_left")?.simulated).toBe(false);
  });

  it("shows every zone unknown while the walker is offline", () => {
    expect(zoneViews(snapshot, manifest, received, received + 100, false).every((v) => v.reading.status === "unknown")).toBe(true);
    expect(zoneViews(null, manifest, received, received, true)).toEqual([]);
  });
});

describe("turn requests", () => {
  const clip = { type: "audio", mime: "audio/wav", data_base64: "UklGRiQAAABXQVZF", duration_ms: 2400 };
  const turn = (input: unknown) => ({ client_turn_id: uuid(1), input, snapshot: null });

  it("takes a voice clip or text from the walker, and text only from the page", () => {
    expect(DeviceTurnRequestSchema.safeParse(turn(clip)).success).toBe(true);
    expect(DeviceTurnRequestSchema.safeParse(turn({ type: "text", text: "Hi" })).success).toBe(true);
    expect(PageTurnRequestSchema.safeParse({ client_turn_id: uuid(1), input: clip }).success).toBe(false);
    expect(PageTurnRequestSchema.safeParse({ client_turn_id: uuid(1), input: { type: "text", text: "  " } }).success).toBe(false);
  });

  it("bounds the clip's length, size and encoding", () => {
    expect(DeviceTurnRequestSchema.safeParse(turn({ ...clip, duration_ms: 15_001 })).success).toBe(false);
    const tooBig = "A".repeat(Math.ceil(VOICE_CLIP_MAX_BYTES / 3) * 4 + 4);
    expect(DeviceTurnRequestSchema.safeParse(turn({ ...clip, data_base64: tooBig })).success).toBe(false);
    expect(DeviceTurnRequestSchema.safeParse(turn({ ...clip, mime: "audio/mpeg" })).success).toBe(false);
    expect(DeviceTurnRequestSchema.safeParse(turn({ ...clip, data_base64: "" })).success).toBe(false);
    expect(DeviceTurnRequestSchema.safeParse(turn({ ...clip, data_base64: "UklGR" })).success).toBe(false);
  });
});

describe("turn views", () => {
  const view = {
    turn_id: uuid(5), client_turn_id: uuid(1), source: "walker", heard: "What can you help me with?", heard_by: "gemini",
    reply: "I can buzz your handles when something is close.", answered_by: "model", voiced_by: "cartesia", created_at: T0,
  };

  it("lets a failed voice turn say nothing was heard", () => {
    expect(WalkerTurnViewSchema.safeParse({ ...view, heard: null, heard_by: null, answered_by: "fixed", voiced_by: "walker" }).success).toBe(true);
    expect(WalkerTurnViewSchema.safeParse({ ...view, heard: null }).success).toBe(false);
  });

  it("keeps page turns typed and unspoken", () => {
    expect(WalkerTurnViewSchema.safeParse({ ...view, source: "page", heard_by: "typed", voiced_by: null }).success).toBe(true);
    expect(WalkerTurnViewSchema.safeParse({ ...view, source: "page", voiced_by: null }).success).toBe(false);
    expect(WalkerTurnViewSchema.safeParse({ ...view, source: "page", heard_by: "typed" }).success).toBe(false);
  });
});

describe("proposals", () => {
  const proposal = ProposalViewSchema.parse({
    proposal_id: uuid(2), client_turn_id: uuid(1), kind: "cues_change", from_cues: ["vibration", "spoken"], cues: ["sound", "spoken"],
    base_configuration_version: 1, summary: "Switch your alerts from buzzing to short sounds.", state: "open",
    created_at: T0, expires_at: "2026-10-24T09:01:00.000Z", configuration_version: null,
  });

  it("is open only before it expires", () => {
    expect(isOpenProposal(proposal, new Date("2026-10-24T09:00:59.999Z"))).toBe(true);
    expect(isOpenProposal(proposal, new Date("2026-10-24T09:01:00.000Z"))).toBe(false);
    expect(isOpenProposal({ ...proposal, state: "superseded" }, new Date(T0))).toBe(false);
  });

  it("names the version it created exactly when confirmed", () => {
    expect(ProposalViewSchema.safeParse({ ...proposal, state: "confirmed", configuration_version: 2 }).success).toBe(true);
    expect(ProposalViewSchema.safeParse({ ...proposal, state: "confirmed" }).success).toBe(false);
    expect(ProposalViewSchema.safeParse({ ...proposal, configuration_version: 2 }).success).toBe(false);
  });

  it("must change something, and expire after it was made", () => {
    expect(ProposalViewSchema.safeParse({ ...proposal, cues: ["spoken", "vibration"] }).success).toBe(false);
    expect(ProposalViewSchema.safeParse({ ...proposal, expires_at: T0 }).success).toBe(false);
  });

  it("can't carry anything but a cues change", () => {
    expect(ProposalViewSchema.safeParse({ ...proposal, kind: "pick_place" }).success).toBe(false);
    expect(ProposalViewSchema.safeParse({ ...proposal, motion: "up" }).success).toBe(false);
  });
});

describe("pairing and heartbeat", () => {
  it("hands out a 32-byte base64url credential", () => {
    const credential = Buffer.alloc(32, 7).toString("base64url");
    expect(PairDeviceResponseSchema.safeParse({ device_id: uuid(3), credential, configuration }).success).toBe(true);
    expect(PairDeviceResponseSchema.safeParse({ device_id: uuid(3), credential: "short", configuration }).success).toBe(false);
  });

  const manifest = {
    device_configuration_version: 1, generated_at: T0, simulator: true,
    modules: [{ module_id: "perception.tof", instance_id: "tof-front-01", firmware_version: null, protocol_version: 1,
      health: "ok", faults: [], observed_at: T0, simulated: true }],
  };
  const beat = {
    sent_at: T0, service_version: "0.1.0", manifest, snapshot: null,
    events: [{ event_id: uuid(4), kind: "notice", text: "Steady is on.", ago_ms: 1200 }],
  };

  it("carries the walker's own lines and the simulated flags", () => {
    expect(HeartbeatRequestSchema.safeParse(beat).success).toBe(true);
    expect(HeartbeatRequestSchema.safeParse({ ...beat, manifest: { ...manifest, simulator: undefined } }).success).toBe(false);
  });

  it("lets a simulator report a real part plugged into it, flagged by the part itself", () => {
    const realPart = { ...manifest, modules: [{ ...manifest.modules[0], simulated: false }] };
    expect(HeartbeatRequestSchema.safeParse({ ...beat, manifest: realPart }).success).toBe(true);
  });

  it("refuses the same line twice, and more lines than the walker may queue", () => {
    const line = beat.events[0]!;
    expect(HeartbeatRequestSchema.safeParse({ ...beat, events: [line, line] }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, n) => ({ ...line, event_id: uuid(100 + n) }));
    expect(HeartbeatRequestSchema.safeParse({ ...beat, events: many }).success).toBe(false);
    expect(HeartbeatRequestSchema.safeParse({ ...beat, events: many.slice(1) }).success).toBe(true);
  });
});

describe("status view", () => {
  const status = {
    device_id: uuid(3), name: "Steady walker", online: false, last_seen_at: null, simulator: false,
    configuration, applied_configuration_version: null,
    parts: [{ module_id: "voice", instance_id: null, health: "unavailable", simulated: false, in_configuration: true }],
    zones: [], open_proposal: null, turns: [], walker_said: [],
  };

  it("parses an offline walker with a configured part it never reported", () => {
    expect(WalkerStatusViewSchema.safeParse(status).success).toBe(true);
  });

  it("refuses an offline walker that still looks available", () => {
    const okPart = { module_id: "voice", instance_id: "pi-audio-01", health: "ok", simulated: false, in_configuration: true };
    expect(WalkerStatusViewSchema.safeParse({ ...status, parts: [okPart] }).success).toBe(false);
    expect(WalkerStatusViewSchema.safeParse({ ...status, online: true, parts: [okPart] }).success).toBe(true);
    const measured = { zone: "front_left", instance_id: "tof-front-01", simulated: false, reading: { status: "measured", mm: 600, age_ms: 10 } };
    expect(WalkerStatusViewSchema.safeParse({ ...status, zones: [measured] }).success).toBe(false);
  });

  it("shows only an open proposal as open", () => {
    const superseded = {
      proposal_id: uuid(2), client_turn_id: uuid(1), kind: "cues_change", from_cues: ["vibration", "spoken"], cues: ["sound", "spoken"],
      base_configuration_version: 1, summary: "Switch your alerts from buzzing to short sounds.", state: "superseded",
      created_at: T0, expires_at: "2026-10-24T09:01:00.000Z", configuration_version: null,
    };
    expect(WalkerStatusViewSchema.safeParse({ ...status, online: true, open_proposal: superseded }).success).toBe(false);
    expect(WalkerStatusViewSchema.safeParse({ ...status, online: true, open_proposal: { ...superseded, state: "open" } }).success).toBe(true);
  });
});

describe("turn responses", () => {
  const status = {
    device_id: uuid(3), name: "Steady walker", online: true, last_seen_at: T0, simulator: true,
    configuration, applied_configuration_version: 1, parts: [], zones: [], open_proposal: null, turns: [],
    walker_said: [{ event_id: uuid(4), kind: "local_reply", text: "I'm offline right now.", at: T0 }],
  };
  const turn = {
    turn_id: uuid(5), client_turn_id: uuid(1), source: "walker", heard: "Hello", heard_by: "gemini",
    reply: "Hi, I'm Steady.", answered_by: "model", voiced_by: "cartesia", created_at: T0,
  };
  const speech = { mime: "audio/wav", data_base64: "UklGRiQAAABXQVZF" };

  it("credits speech to Cartesia, and lets a replay come back without its audio", () => {
    expect(WalkerTurnResponseSchema.safeParse({ turn, proposal: null, speech, status }).success).toBe(true);
    expect(WalkerTurnResponseSchema.safeParse({ turn, proposal: null, speech: null, status }).success).toBe(true);
    expect(WalkerTurnResponseSchema.safeParse({ turn: { ...turn, voiced_by: "walker" }, proposal: null, speech, status }).success).toBe(false);
  });

  it("never speaks a page turn", () => {
    const pageTurn = { ...turn, source: "page", heard_by: "typed", voiced_by: null };
    expect(WalkerTurnResponseSchema.safeParse({ turn: pageTurn, proposal: null, speech: null, status }).success).toBe(true);
    expect(WalkerTurnResponseSchema.safeParse({ turn: pageTurn, proposal: null, speech, status }).success).toBe(false);
  });
});

describe("errors", () => {
  it("gives every code an HTTP status", () => {
    for (const code of WalkerErrorCodeSchema.options) expect(WALKER_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
});
