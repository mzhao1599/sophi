import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ActionRequestSchema,
  ActionStatusReportSchema,
  CapabilityManifestSchema,
  SensorSnapshotSchema,
  canFollowActionStatus,
  isTerminalActionStatus,
  readZone,
} from "../src";

const docs = readFileSync(new URL("../../../docs/interfaces.md", import.meta.url), "utf8");
const docActionRequest = [...docs.matchAll(/```json\n([\s\S]*?)```/g)]
  .map((m) => m[1] ?? "")
  .find((block) => block.includes('"action_id"'));

describe("action request v1", () => {
  const request = JSON.parse(docActionRequest ?? "null");

  it("parses the example in docs/interfaces.md", () => {
    expect(ActionRequestSchema.parse(request).kind).toBe("manipulation.pick_place");
  });

  it("refuses an action that skips the user's start", () => {
    expect(ActionRequestSchema.safeParse({ ...request, requires_user_start: false }).success).toBe(false);
  });

  it("refuses raw motion parameters", () => {
    const parameters = { ...request.parameters, joint_angles: [0, 45, 90] };
    expect(ActionRequestSchema.safeParse({ ...request, parameters }).success).toBe(false);
  });
});

describe("action status v1", () => {
  it("ends each action in exactly one terminal status", () => {
    expect(canFollowActionStatus(null, "accepted")).toBe(true);
    expect(canFollowActionStatus(null, "started")).toBe(false);
    expect(canFollowActionStatus("started", "progress")).toBe(true);
    expect(canFollowActionStatus("progress", "completed")).toBe(true);
    for (const terminal of ["rejected", "completed", "cancelled", "failed"] as const) {
      expect(isTerminalActionStatus(terminal)).toBe(true);
      expect(canFollowActionStatus(terminal, "failed")).toBe(false);
      expect(canFollowActionStatus(terminal, "started")).toBe(false);
    }
  });

  it("names a reason for a rejection and only then", () => {
    const report = {
      action_id: "9c7e35ad-7602-4c6a-8a29-306f69599edc",
      seq: 0,
      status: "rejected",
      reported_at: "2026-10-23T19:58:00Z",
    };
    expect(ActionStatusReportSchema.safeParse(report).success).toBe(false);
    expect(ActionStatusReportSchema.safeParse({ ...report, reason: "stale_sensors" }).success).toBe(true);
    expect(ActionStatusReportSchema.safeParse({ ...report, status: "accepted", reason: "busy" }).success).toBe(false);
  });
});

describe("capability manifest v1", () => {
  it("parses a Pi report with an unplugged module", () => {
    const manifest = {
      device_configuration_version: 7,
      generated_at: "2026-10-23T19:58:00Z",
      modules: [
        { module_id: "controls.hand", instance_id: "hand-left-01", firmware_version: "0.1.0", protocol_version: 1,
          health: "ok", faults: [], observed_at: "2026-10-23T19:57:59Z" },
        { module_id: "perception.tof", instance_id: "tof-front-01", firmware_version: null, protocol_version: 1,
          health: "unavailable", faults: ["heartbeat_lost"], observed_at: "2026-10-23T19:50:00Z" },
      ],
    };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
    expect(CapabilityManifestSchema.safeParse({ ...manifest, modules: [{ ...manifest.modules[0], module_id: "jetpack" }] }).success).toBe(false);
  });
});

describe("sensor snapshot v1", () => {
  const snapshot = SensorSnapshotSchema.parse({
    generated_at: "2026-10-23T19:58:00.300Z",
    zones: [
      { zone: "front_left", instance_id: "tof-front-01", mm: 610, quality: "valid",
        captured_at: "2026-10-23T19:58:00.000Z", expires_at: "2026-10-23T19:58:00.500Z" },
      { zone: "front_right", instance_id: "tof-front-01", mm: null, quality: "invalid",
        captured_at: "2026-10-23T19:58:00.000Z", expires_at: "2026-10-23T19:58:00.500Z" },
    ],
  });
  const at = (iso: string) => new Date(iso);

  it("reads a fresh valid zone as measured", () => {
    expect(readZone(snapshot, "front_left", at("2026-10-23T19:58:00.400Z"))).toMatchObject({ status: "measured", mm: 610 });
  });

  it("reads a stale zone as unknown, never clear", () => {
    expect(readZone(snapshot, "front_left", at("2026-10-23T19:58:00.500Z"))).toEqual({ status: "unknown", reason: "stale" });
  });

  it("reads missing and invalid zones as unknown", () => {
    const now = at("2026-10-23T19:58:00.400Z");
    expect(readZone(snapshot, "rear", now)).toEqual({ status: "unknown", reason: "missing" });
    expect(readZone(snapshot, "front_right", now)).toEqual({ status: "unknown", reason: "invalid" });
  });
});
