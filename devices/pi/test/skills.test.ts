import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ARM_JOINTS,
  ARM_SPEED_CEILING_DEG_S,
  MAX_GOAL_LEAD_DEG,
  MAX_GOAL_STEP_DEG,
  MOTION_LIMITS,
  SKILL_MAX_DURATION_MS,
  SkillSchema,
  checkSkillAgainstSetup,
  type MotionSetup,
  type ArmCalibration,
  type ArmJoints,
  type Skill,
} from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { MotionFiles, skillJson } from "../src/motion/files";
import { OperatorClient, OperatorSocket, answerOperator } from "../src/motion/operator";
import { servoSpeedRegister } from "../src/motion/limits";
import { clampSamples, recordedSkill, replayCaps, replayStretch, retime, retimeEvent, skillPoint } from "../src/motion/skills";
import { SIM_SAMPLE_SKILL_ID, simSampleSkill } from "../src/sim/sampleSkill";
import { SIM_TAUGHT_SKILL_ID } from "../src/sim/motionSim";
import { GRASP_SHORT_MS, RECORD_MAX_MS } from "../src/motion/coordinator";
import { captureLogger } from "./support/fakes";
import { makeMotionHarness, type MotionHarness } from "./support/motion";

/** Rows T8 to T35 in test/EXPECTED.md ("Taught skills"). Every clock is fake and every servo SIMULATED. */

const AT = "2026-10-24T12:00:00.000Z";
const TICKS_PER_DEG = 4096 / 360;
const zeros: ArmJoints = { shoulder_pan: 0, shoulder_lift: 0, elbow_flex: 0, wrist_flex: 0, wrist_roll: 0, gripper: 0 };

function calibration(halfRange = 1100): ArmCalibration {
  const joints = Object.fromEntries(
    ARM_JOINTS.map((joint, i) => [joint, { servo_id: i + 1, homing_offset: 0, min_ticks: 2048 - halfRange, max_ticks: 2048 + halfRange, zero_ticks: 2048, direction: 1 as const }]),
  ) as ArmCalibration["joints"];
  return { format: "sophi.arm_calibration", version: 2, arm: "left", role: "follower", bus_id: "x", calibrated_at: AT, joints };
}

/** Advances in 10 ms steps (a chain of fake-bus replies needs small steps), `each` after every step. */
async function step(h: MotionHarness, ms: number, each?: () => void): Promise<void> {
  const end = h.clock.monotonic() + ms;
  while (h.clock.monotonic() < end) {
    await h.clock.advance(10);
    each?.();
  }
}

async function confirm(h: MotionHarness): Promise<void> {
  await step(h, 2100);
  h.press("c");
  await step(h, 50);
}

/** Torque on for the left arm, then the left arm to the made-up `ready` pose (where the sample skill starts). */
async function readyLeft(h: MotionHarness): Promise<void> {
  h.coordinator.operatorTorque(true, ["left"]);
  await confirm(h);
  h.coordinator.operatorGoToPose("left", "ready");
  await confirm(h);
  await step(h, 1500);
  expect(h.coordinator.state().arms.find((a) => a.arm === "left" && a.role === "follower")?.pose).toEqual({ status: "at", name: "ready" });
}

function follower(h: MotionHarness) {
  return h.sim.buses.get("left/follower")!;
}
function leader(h: MotionHarness) {
  return h.sim.buses.get("left/leader")!;
}

function files(h: MotionHarness): MotionFiles {
  return new MotionFiles(h.dir, captureLogger());
}

/** Records on the left arm for `ms` after its Confirm (the leader matched first), then a terminal stop. Returns the request id. */
async function recordLeft(h: MotionHarness, ms: number, options: { during?: (id: string) => Promise<void>; replace?: boolean } = {}): Promise<string> {
  for (const servo of follower(h).servos.values()) leader(h).servo(servo.id).moveByHand(servo.get("presentPosition"));
  await step(h, 100);
  const begin = h.coordinator.operatorRecord(SIM_TAUGHT_SKILL_ID, "Hand it over", "left", options.replace ?? true);
  expect(begin.ok).toBe(true);
  if (!begin.ok) throw new Error(begin.error);
  expect(begin.request.state).toBe("waiting_confirm");
  await confirm(h);
  expect(h.coordinator.state().active).toMatchObject({ kind: "teleop", recording_skill_id: SIM_TAUGHT_SKILL_ID });
  await options.during?.(begin.request.id);
  await step(h, ms);
  h.coordinator.operatorStop();
  await step(h, 50);
  return begin.request.id;
}

describe("skill arithmetic", () => {
  it("T8: samples are clamped into the commandable range; a stretch over the speed limit is slowed to it, never sped up", () => {
    const cal = calibration();
    const max = 1100 / TICKS_PER_DEG - 2;
    const clamped = clampSamples([{ t: 0, joints: { ...zeros, elbow_flex: 120, wrist_roll: -120 } }], cal);
    // Rounded toward the inside: 94.6777…° is the end, so 94.67°, never 94.68° (which would fail the setup check).
    expect(clamped[0]!.joints.elbow_flex).toBe(Math.floor(max * 100) / 100);
    expect(clamped[0]!.joints.elbow_flex).toBeLessThanOrEqual(max);
    expect(clamped[0]!.joints.wrist_roll).toBeGreaterThanOrEqual(-max);
    // A recording pinned at both ends of a range passes checkSkillAgainstSetup.
    const pinned = Array.from({ length: 3 }, (_, i) => ({ t: i * 20, joints: { ...zeros, elbow_flex: 120, wrist_roll: -120 } }));
    const built = recordedSkill({ skillId: "pinned", title: "Pinned", arm: "left", createdAt: AT, samples: pinned, events: [], calibration: cal, speedDegS: 60, letGoDeg: null });
    if (!built.ok) throw new Error(built.error);
    const setup = { format: "sophi.motion_setup", version: 2, stop_sense: "wired", arms: [cal], poses: [], lift: null } as const;
    expect(checkSkillAgainstSetup(built.skill, setup as unknown as MotionSetup)).toEqual([]);
    // 1.5° in 20 ms is 75°/s: lengthened to 25 ms at 60°/s. 0.5° in 20 ms stays 20 ms. Under 10 ms becomes 10 ms.
    const samples = [
      { t: 0, joints: zeros },
      { t: 20, joints: { ...zeros, shoulder_pan: 1.5 } },
      { t: 40, joints: { ...zeros, shoulder_pan: 2 } },
      { t: 45, joints: { ...zeros, shoulder_pan: 2 } },
    ];
    const r = retime(samples, 60);
    expect(r).toEqual({ ok: true, times: [0, 25, 45, 55] });
    // Events move with the samples around them.
    expect(retimeEvent(30, samples, [0, 25, 45, 55])).toBe(35);
    expect(retimeEvent(1000, samples, [0, 25, 45, 55])).toBe(55);
    // Too long once slowed, or a gap over a second: refused.
    expect(retime([{ t: 0, joints: zeros }, { t: SKILL_MAX_DURATION_MS, joints: { ...zeros, wrist_roll: 1 } }], 60).ok).toBe(false);
    expect(retime([{ t: 0, joints: zeros }, { t: 20, joints: { ...zeros, wrist_roll: 70 } }], 60).ok).toBe(false);
  });

  it("T8: a recording that ends grasping needs a let-go angle; the built skill passes SkillSchema", () => {
    const samples = Array.from({ length: 50 }, (_, i) => ({ t: i * 20, joints: { ...zeros, shoulder_pan: i * 0.5 } }));
    const base = { skillId: "tray_pick_handover", title: "Hold it out", arm: "left" as const, createdAt: AT, samples, calibration: calibration(), speedDegS: 60 };
    const events = [{ t: 300, kind: "grasp" as const }];
    expect(recordedSkill({ ...base, events, letGoDeg: null })).toMatchObject({ ok: false });
    const built = recordedSkill({ ...base, events, letGoDeg: 25 });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(SkillSchema.safeParse(built.skill).success).toBe(true);
    expect(built.skill).toMatchObject({ source: "recorded", arms: ["left"], let_go: [{ arm: "left", gripper_open_deg: 25 }], lift_mm: null, gripper_events: [{ t_ms: 300, arm: "left", kind: "grasp" }] });
    expect(built.skill.start.joints.left).toEqual(built.skill.waypoints[0]!.joints.left);
    const released = recordedSkill({ ...base, events: [...events, { t: 600, kind: "release" }], letGoDeg: null });
    expect(released.ok && released.skill.let_go).toEqual([]);
  });

  it("T8: replay: bench mode stretches a 60°/s skill to its 30°/s; caps never pass the mode's replay limit; waypoints interpolate", () => {
    const fast = { max_speed_deg_s: Object.fromEntries(ARM_JOINTS.map((j) => [j, ARM_SPEED_CEILING_DEG_S])) as Skill["max_speed_deg_s"] };
    expect(replayStretch(fast, MOTION_LIMITS.bench.arm_speed_deg_s.replay)).toBe(2);
    expect(replayStretch(fast, MOTION_LIMITS.normal.arm_speed_deg_s.replay)).toBe(1);
    expect(replayCaps(fast, MOTION_LIMITS.bench.arm_speed_deg_s.replay).elbow_flex).toBe(30);
    const skill = { waypoints: [{ t_ms: 0, joints: { left: zeros } }, { t_ms: 100, joints: { left: { ...zeros, gripper: 10 } } }] };
    expect(skillPoint(skill, "left", 25).joints.gripper).toBeCloseTo(2.5);
    expect(skillPoint(skill, "left", 500).joints.gripper).toBe(10);
  });

  it("T8: the SIMULATED sample skill passes SkillSchema, says it is simulated, and isn't the real first skill", () => {
    const sample = simSampleSkill(AT);
    expect(SkillSchema.safeParse(sample).success).toBe(true);
    expect(sample.skill_id).not.toBe("tray_pick_handover");
    expect(sample.title).toMatch(/^SIMULATED/);
    expect(JSON.parse(skillJson(sample))).toEqual(sample);
  });
});

describe("skill files", () => {
  it("T9: written atomically at 0600, never over an existing file without replace; a replaced or removed one is set aside", () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-skills-"));
    const f = new MotionFiles(dir, captureLogger());
    const sample = simSampleSkill(AT);
    expect(f.writeSkill(sample, { replace: false, stamp: AT })).toBeNull();
    expect(statSync(f.skillPath(SIM_SAMPLE_SKILL_ID)).mode & 0o777).toBe(0o600);
    expect(statSync(f.skillsDir).mode & 0o777).toBe(0o700);
    expect(() => f.writeSkill({ ...sample, title: "Other" }, { replace: false, stamp: AT })).toThrow(/EEXIST/);
    expect(f.readSkill(SIM_SAMPLE_SKILL_ID)).toMatchObject({ kind: "ok", skill: { title: sample.title } });
    expect(f.writeSkill({ ...sample, title: "Other" }, { replace: true, stamp: AT })).toMatch(/\.replaced-/);
    expect(f.readSkill(SIM_SAMPLE_SKILL_ID)).toMatchObject({ kind: "ok", skill: { title: "Other" } });
    expect(readdirSync(f.skillsDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // A file whose id isn't its name, or that fails the schema, is invalid, never guessed at.
    writeFileSync(join(f.skillsDir, "renamed.json"), skillJson(sample));
    expect(f.readSkill("renamed")).toMatchObject({ kind: "invalid" });
    expect(f.removeSkill(SIM_SAMPLE_SKILL_ID, AT)).toMatch(/\.removed-/);
    expect(f.readSkill(SIM_SAMPLE_SKILL_ID)).toEqual({ kind: "missing" });
    expect(f.listSkillIds()).toEqual(["renamed"]);
    // For people reading it: one waypoint a line.
    const text = readFileSync(join(f.skillsDir, "renamed.json"), "utf8");
    expect(text.split("\n").filter((l) => l.trim().startsWith('{"t_ms"')).length).toBe(sample.waypoints.length);
  });
});

describe("recording", () => {
  it("T10: it samples the follower's own readings, not the leader's; saved as a contract skill file", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    // The follower's wrist is held at 0° by something; its leader sits 2.5° away (under the 3° stall lead).
    const id = await recordLeft(h, 1000, {
      during: async () => {
        follower(h).servo(5).heldAt = 2048;
        leader(h).servo(5).moveByHand(2048 + Math.round(2.5 * TICKS_PER_DEG));
      },
    });
    const saved = h.coordinator.operatorRecordFinish(id, null);
    expect(saved).toMatchObject({ ok: true, asked_let_go: false });
    const load = files(h).readSkill(SIM_TAUGHT_SKILL_ID);
    expect(load.kind).toBe("ok");
    if (load.kind !== "ok") return;
    const skill = load.skill;
    expect(skill.waypoints.length).toBeGreaterThan(40);
    expect(Math.max(...skill.waypoints.map((w) => Math.abs(w.joints.left!.wrist_roll)))).toBeLessThan(0.2);
    expect(skill).toMatchObject({ source: "recorded", title: "Hand it over", arms: ["left"], lift_mm: null, gripper_events: [], let_go: [] });
    expect(Object.values(skill.max_speed_deg_s)).toEqual(ARM_JOINTS.map(() => 60));
    expect(statSync(files(h).skillPath(SIM_TAUGHT_SKILL_ID)).mode & 0o777).toBe(0o600);
    await h.stop();
  });

  it("T11: a skill by that id isn't recorded over without --replace; with it, the old file is set aside", async () => {
    const h = makeMotionHarness();
    await h.start();
    files(h).writeSkill({ ...simSampleSkill(AT), skill_id: SIM_TAUGHT_SKILL_ID }, { replace: false, stamp: AT });
    const refused = h.coordinator.operatorRecord(SIM_TAUGHT_SKILL_ID, "Hand it over", "left", false);
    expect(refused).toMatchObject({ ok: false });
    expect(!refused.ok && refused.error).toMatch(/--replace/);
    expect(h.coordinator.state().confirm_target).toBeNull();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    const id = await recordLeft(h, 300, { replace: true });
    expect(h.coordinator.operatorRecordFinish(id, null)).toMatchObject({ ok: true });
    expect(readdirSync(files(h).skillsDir).some((n) => n.startsWith(`${SIM_TAUGHT_SKILL_ID}.json.replaced-`))).toBe(true);
    await h.stop();
  });

  it("T12: a recording that ends grasping needs its let-go angle (out of range is asked again); then the Pi asks \"Let go?\"", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    // A grasp marked at 0°, then the teaching gripper closes 20° (toward lower angles here).
    const id = await recordLeft(h, 1000, {
      during: async (id) => {
        expect(h.coordinator.operatorRecordMark("someone-else", "grasp")).toMatchObject({ ok: false });
        expect(h.coordinator.operatorRecordMark(id, "grasp")).toMatchObject({ ok: true });
        leader(h).servo(6).moveByHand(2048 - Math.round(20 * TICKS_PER_DEG));
      },
    });
    // Ended holding: "Let go?" at once, to where the grasp began (LETTING GO IS ALWAYS POSSIBLE).
    expect(h.coordinator.state().confirm_target).toMatchObject({ prepared_by: "walker_local", action: { kind: "gripper.release", gripper_open_deg: 0 } });
    const first = h.coordinator.operatorRecordFinish(id, null);
    expect(first).toMatchObject({ ok: false, needs_let_go: { arm: "left", suggest_deg: 0 } });
    expect(h.coordinator.operatorRecordFinish(id, 170)).toMatchObject({ ok: false, needs_let_go: { arm: "left" } });
    // −30° would close it further: asked again.
    const closing = h.coordinator.operatorRecordFinish(id, -30);
    expect(closing).toMatchObject({ ok: false, needs_let_go: { arm: "left" } });
    expect(!closing.ok && closing.error).toMatch(/would close/);
    expect(files(h).readSkill(SIM_TAUGHT_SKILL_ID)).toEqual({ kind: "missing" });
    await step(h, 2100);
    const saved = h.coordinator.operatorRecordFinish(id, 25);
    expect(saved).toMatchObject({ ok: true, asked_let_go: true });
    const load = files(h).readSkill(SIM_TAUGHT_SKILL_ID);
    expect(load.kind === "ok" && load.skill.let_go).toEqual([{ arm: "left", gripper_open_deg: 25 }]);
    expect(h.coordinator.state().confirm_target).toMatchObject({ prepared_by: "walker_local", title: "Let go?", action: { kind: "gripper.release", arm: "left", gripper_open_deg: 25 } });
    await h.stop();
  });

  it("T13: a recording whose terminal went away (Ctrl-C) is thrown away, not saved", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    const id = await recordLeft(h, 300);
    h.coordinator.operatorWithdraw(id);
    expect(h.coordinator.operatorRecordFinish(id, null)).toMatchObject({ ok: false, error: "there is no recording to save" });
    expect(files(h).readSkill(SIM_TAUGHT_SKILL_ID)).toEqual({ kind: "missing" });
    await h.stop();
  });

  it("T13: a terminal that drops mid-recording (no Ctrl-C, the socket just closes): stopped, and nothing is left to save", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    for (const servo of follower(h).servos.values()) leader(h).servo(servo.id).moveByHand(servo.get("presentPosition"));
    await step(h, 100);
    const path = join(mkdtempSync(join(tmpdir(), "walker-sock-")), "m.sock");
    const socket = new OperatorSocket(path, h.coordinator, captureLogger());
    await socket.listen();
    const client = await OperatorClient.connect(path);
    const reply = (await client.send({ op: "record", skill_id: SIM_TAUGHT_SKILL_ID, title: "Hand it over", arm: "left", replace: true })) as { request: { id: string } };
    await confirm(h);
    expect(h.coordinator.state().active?.kind).toBe("teleop");
    client.close();
    for (let i = 0; i < 50 && h.coordinator.state().active; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(h.coordinator.state().active).toBeNull();
    expect(h.coordinator.operatorRecordFinish(reply.request.id, null)).toMatchObject({ ok: false, error: "there is no recording to save" });
    socket.close();
    await h.stop();
  });

  it("T14: while recording, teleop is capped at the skill ceiling (60°/s) and a recording can't be saved until it ends", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    for (const servo of follower(h).servos.values()) leader(h).servo(servo.id).moveByHand(servo.get("presentPosition"));
    await step(h, 100);
    const begin = h.coordinator.operatorRecord(SIM_TAUGHT_SKILL_ID, "Hand it over", "left", true);
    if (!begin.ok) throw new Error(begin.error);
    await confirm(h);
    // The leader's elbow jumps 40°: the follower's goal ramps at no more than 60°/s (90°/s without a recording),
    // so in 0.5 s the elbow goes at most 30°.
    leader(h).servo(3).moveByHand(2048 + Math.round(40 * TICKS_PER_DEG));
    const start = follower(h).servo(3).get("presentPosition");
    await step(h, 500);
    const moved = (follower(h).servo(3).get("presentPosition") - start) / TICKS_PER_DEG;
    expect(moved).toBeGreaterThan(15);
    expect(moved).toBeLessThanOrEqual(60 * 0.5 + 0.5);
    // The servos' own speed register is set from the same cap: 60°/s while recording (90°/s for plain teleop).
    for (const servo of follower(h).servos.values()) expect(servo.get("goalSpeed")).toBe(servoSpeedRegister(ARM_SPEED_CEILING_DEG_S));
    expect(servoSpeedRegister(ARM_SPEED_CEILING_DEG_S)).toBeLessThan(servoSpeedRegister(MOTION_LIMITS.normal.arm_speed_deg_s.teleop));
    expect(h.coordinator.operatorRecordFinish(begin.request.id, null)).toMatchObject({ ok: false, error: "it is still recording: stop it first" });
    await h.stop();
  });
});

describe("replay", () => {
  it("T15: every goal a replay writes is within the lead and step limits; it ends HOLDING the last waypoint", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("object-left");
    expect(h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID)).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    await confirm(h);
    expect(h.coordinator.state().active).toMatchObject({ kind: "skill.run", skill_id: SIM_SAMPLE_SKILL_ID, title: "SIMULATED sample: hold it out" });
    const servos = [...follower(h).servos.values()];
    const last = new Map(servos.map((s) => [s.id, s.get("goalPosition")]));
    let worstLead = 0;
    let worstStep = 0;
    let grasping = false;
    await step(h, 5000, () => {
      for (const s of servos) {
        worstLead = Math.max(worstLead, Math.abs(s.get("goalPosition") - s.get("presentPosition")));
        worstStep = Math.max(worstStep, Math.abs(s.get("goalPosition") - last.get(s.id)!));
        last.set(s.id, s.get("goalPosition"));
      }
      grasping ||= h.coordinator.state().arms.find((a) => a.arm === "left" && a.role === "follower")!.grasp_active;
    });
    expect(worstLead).toBeLessThanOrEqual(Math.round(MAX_GOAL_LEAD_DEG * TICKS_PER_DEG) + 1);
    expect(worstStep).toBeLessThanOrEqual(Math.round(MAX_GOAL_STEP_DEG * TICKS_PER_DEG) + 1);
    expect(grasping).toBe(true);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "completed" });
    // Holding the last waypoint (the gripper, stopped by the object, keeps its squeeze).
    const end = simSampleSkill(AT).waypoints.at(-1)!.joints.left!;
    const arm = h.coordinator.state().arms.find((a) => a.arm === "left" && a.role === "follower")!;
    for (const joint of ARM_JOINTS.filter((j) => j !== "gripper")) expect(Math.abs(arm.joints![joint].degrees - end[joint])).toBeLessThanOrEqual(3);
    expect(arm.grasp_active).toBe(true);
    await h.stop();
  });

  it("T16: bench mode stretches a 60°/s skill's timeline to 30°/s: it takes twice as long", async () => {
    for (const bench of [false, true]) {
      const h = makeMotionHarness({ bench });
      await h.start();
      await readyLeft(h);
      // The sample at double speed (gaps 10 ms, joints under 60°/s), declared 60°/s.
      const sample = simSampleSkill(AT);
      const fast: Skill = {
        ...sample,
        skill_id: "fast_sample",
        max_speed_deg_s: Object.fromEntries(ARM_JOINTS.map((j) => [j, 60])) as Skill["max_speed_deg_s"],
        waypoints: sample.waypoints.map((w) => ({ ...w, t_ms: w.t_ms / 2 })),
        gripper_events: sample.gripper_events.map((e) => ({ ...e, t_ms: e.t_ms / 2 })),
      };
      files(h).writeSkill(fast, { replace: false, stamp: AT });
      h.coordinator.operatorSkillRun("fast_sample");
      await confirm(h);
      const started = h.clock.monotonic() - 50;
      let took = -1;
      await step(h, 8000, () => {
        if (took < 0 && h.coordinator.state().last_command?.kind === "skill.run") took = h.clock.monotonic() - started;
      });
      expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "completed" });
      if (bench) expect(took).toBeGreaterThanOrEqual(4500);
      else expect(took).toBeLessThan(3500);
      await h.stop();
    }
  });

  it("T17: the file is read again at the press: changed since the walker asked is refused; removed is unknown_skill", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    const f = files(h);
    const first = h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    if (!first.ok) throw new Error(first.error);
    f.writeSkill({ ...simSampleSkill(AT), title: "Something else" }, { replace: true, stamp: AT });
    await confirm(h);
    expect(h.coordinator.operatorRequestStatus(first.request.id)).toMatchObject({ state: "refused", refusal: "confirm_target_mismatch" });
    expect(h.coordinator.state().active).toBeNull();
    const second = h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    if (!second.ok) throw new Error(second.error);
    f.removeSkill(SIM_SAMPLE_SKILL_ID, AT);
    await confirm(h);
    expect(h.coordinator.operatorRequestStatus(second.request.id)).toMatchObject({ state: "refused", refusal: "unknown_skill" });
    expect(h.coordinator.state().active).toBeNull();
    await h.stop();
  });

  it("T18: not at the start: refused before any Confirm, and the reason names the pose to go to first", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    const r = h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    expect(r).toMatchObject({ ok: true, request: { state: "refused", refusal: "not_at_start" } });
    expect(r.ok && r.request.detail).toMatch(/elbow_flex is 30(\.\d)?° from where it starts .*walker arms pose go ready --arm left/);
    expect(h.coordinator.state().confirm_target).toBeNull();
    await h.stop();
  });

  it("T19: an offer carries an id only: words or an unknown skill are dropped; the title is the skill file's own", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    expect(h.coordinator.requestOffer({ target: { kind: "skill.run", skill_id: SIM_SAMPLE_SKILL_ID, title: "Do something else" } })).toBeNull();
    expect(h.coordinator.requestOffer({ target: { kind: "skill.run", skill_id: "no_such_skill" } })).toBeNull();
    expect(h.coordinator.requestOffer({ target: { kind: "skill.run", skill_id: SIM_SAMPLE_SKILL_ID } })).toMatchObject({
      prepared_by: "offer",
      title: "SIMULATED sample: hold it out",
      prompt: "SIMULATED sample: hold it out. Park the walker and lock the brakes, then press Confirm.",
    });
    await h.stop();
  });

  it("T20: a grasping gripper keeps 30% when its arm goes compliant (a push while holding), so it doesn't drop the object", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("object-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    await step(h, 6000);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "completed" });
    h.press("push-left");
    await step(h, 600);
    expect(h.coordinator.state().faults.map((f) => f.code)).toContain("feedback_divergence");
    expect([...follower(h).servos.values()].map((s) => s.get("torqueLimit"))).toEqual([250, 250, 250, 250, 250, 300]);
    await h.stop();
  });
});

describe("read before act, mid-replay", () => {
  it("T22: a torque limit that changes under a replaying arm (not the one torque on wrote) latches torque_lost (hold); no goal goes to it after", async () => {
    const h = makeMotionHarness();
    const writes: number[] = [];
    h.bus.on("sim", ({ text }) => {
      if (text === "goal-write left follower") writes.push(h.clock.monotonic());
    });
    await h.start();
    await readyLeft(h);
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    await step(h, 500);
    expect(h.coordinator.state().active?.kind).toBe("skill.run");
    follower(h).servo(2).set("torqueLimit", 1000);
    await step(h, 60);
    expect(h.coordinator.state().active).toBeNull();
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "faulted" });
    expect(h.coordinator.state().faults).toMatchObject([{ code: "torque_lost", part: "arm_left" }]);
    const after = h.clock.monotonic();
    await step(h, 1000);
    expect(writes.filter((t) => t > after)).toEqual([]);
    await h.stop();
  });
});

describe("a grasp ends with the arm's torque", () => {
  it("T23: a power loss while holding the object ends the grasp: the limp gripper holds nothing, and its exemptions end", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("object-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    await step(h, 6000);
    const left = () => h.coordinator.state().arms.find((a) => a.arm === "left" && a.role === "follower")!;
    expect(left().grasp_active).toBe(true);
    h.press("power-cycle-left");
    await step(h, 800);
    expect(left().torque).toBe("off");
    expect(left().grasp_active).toBe(false);
    h.coordinator.operatorClear("test: power back");
    await confirm(h);
    expect(h.coordinator.operatorLetGo("left", null)).toMatchObject({ ok: true, request: { state: "refused", refusal: "torque_off" } });
    // Torque on again: the gripper gets the mode's 50%, not the 30% hold, and there is nothing to let go of.
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    expect(follower(h).servo(6).get("torqueLimit")).toBe(500);
    expect(h.coordinator.operatorLetGo("left", null)).toMatchObject({ ok: true, request: { state: "refused", refusal: "no_grasp" } });
    await h.stop();
  });
});

describe("listing, removal and let-go", () => {
  it("T21: list shows what won't run and why; rm sets the file aside without Confirm, withdraws a target for it, and is refused while it runs", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    const f = files(h);
    const broken = simSampleSkill(AT);
    broken.skill_id = "broken";
    for (const wp of broken.waypoints) wp.joints.left!.wrist_roll = 95;
    broken.start.joints.left!.wrist_roll = 95;
    f.writeSkill(broken, { replace: false, stamp: AT });
    const listed = (await answerOperator(h.coordinator, { op: "skill.list" })) as { skills: Array<{ skill_id: string; valid: boolean; problem: string | null }> };
    expect(listed.skills.map((s) => [s.skill_id, s.valid])).toEqual([
      ["broken", false],
      [SIM_SAMPLE_SKILL_ID, true],
    ]);
    expect(listed.skills[0]!.problem).toMatch(/wrist_roll at 95° .* outside/);
    // A pending target for it is withdrawn by its removal.
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    expect(h.coordinator.state().confirm_target?.action).toEqual({ kind: "skill.run", skill_id: SIM_SAMPLE_SKILL_ID });
    await step(h, 2100);
    expect(h.coordinator.operatorSkillRemove("broken")).toMatchObject({ ok: true });
    expect(h.coordinator.state().confirm_target).not.toBeNull();
    // While it runs, it can't be removed.
    h.press("c");
    await step(h, 200);
    expect(h.coordinator.state().active?.kind).toBe("skill.run");
    expect(h.coordinator.operatorSkillRemove(SIM_SAMPLE_SKILL_ID)).toMatchObject({ ok: false });
    h.coordinator.operatorStop();
    await step(h, 100);
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    const target = h.coordinator.state().confirm_target;
    expect(target?.action.kind).toBe("skill.run");
    expect(h.coordinator.operatorSkillRemove(SIM_SAMPLE_SKILL_ID)).toMatchObject({ ok: true });
    expect(h.coordinator.state().confirm_target).toBeNull();
    expect(h.coordinator.operatorSkillRemove(SIM_SAMPLE_SKILL_ID)).toMatchObject({ ok: false });
    await h.stop();
  });

  it("T21: \"Let go?\" from the terminal: refused no_grasp when nothing is held, out_of_range past the gripper's range or toward closing", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    expect(h.coordinator.operatorLetGo("left", 20)).toMatchObject({ ok: true, request: { state: "refused", refusal: "no_grasp" } });
    h.press("object-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    await step(h, 2500);
    h.coordinator.operatorStop();
    await step(h, 100);
    // The stop offered "Let go?" itself; the terminal can ask again once its 2 s have passed.
    expect(h.coordinator.state().confirm_target).toMatchObject({ prepared_by: "walker_local", action: { kind: "gripper.release", gripper_open_deg: 30 } });
    await step(h, 2100);
    expect(h.coordinator.operatorLetGo("left", 170)).toMatchObject({ ok: true, request: { state: "refused", refusal: "out_of_range" } });
    // Opening only: the grasp began near 20°, the object stops it at 12°, so 5° would close it.
    const closing = h.coordinator.operatorLetGo("left", 5);
    expect(closing).toMatchObject({ ok: true, request: { state: "refused", refusal: "out_of_range" } });
    expect(closing.ok && closing.request.detail).toMatch(/would close/);
    expect(h.coordinator.operatorLetGo(null, null)).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    expect(h.coordinator.state().confirm_target).toMatchObject({ prepared_by: "operator_cli", action: { kind: "gripper.release", gripper_open_deg: 30 } });
    await h.stop();
  });
});

const leftArm = (h: MotionHarness) => h.coordinator.state().arms.find((a) => a.arm === "left" && a.role === "follower")!;
const goals = (h: MotionHarness) => [...follower(h).servos.values()].map((s) => s.get("goalPosition"));

/** Steps until `done` holds (or `limitMs` passes); the time it took, or null. */
async function until(h: MotionHarness, done: () => boolean, limitMs: number): Promise<number | null> {
  const start = h.clock.monotonic();
  while (h.clock.monotonic() - start < limitMs) {
    if (done()) return h.clock.monotonic() - start;
    await h.clock.advance(10);
  }
  return done() ? h.clock.monotonic() - start : null;
}

describe("LETTING GO IS ALWAYS POSSIBLE", () => {
  it("T24: a finger in the gripper mid-replay: grasp_mismatch (hold), the squeeze let off, the gripper soft, and \"Let go?\" opens it with the fault latched", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("finger-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    const took = await until(h, () => h.coordinator.state().faults.some((f) => f.code === "grasp_mismatch"), 5000);
    expect(took).not.toBeNull();
    const state = h.coordinator.state();
    expect(state.faults).toMatchObject([{ code: "grasp_mismatch", part: "arm_left", joint: "gripper" }]);
    expect(state.last_command).toMatchObject({ kind: "skill.run", outcome: "faulted" });
    expect(h.log.lines.some((l) => l.includes("grasp_mismatch") && l.includes("from where the skill has it"))).toBe(true);
    await step(h, 100);
    const grip = follower(h).servo(6);
    expect(Math.abs(grip.get("goalPosition") - grip.get("presentPosition"))).toBeLessThanOrEqual(1);
    expect(grip.get("torqueLimit")).toBe(250);
    // Offered at once, with the fault latched; nothing else may be prepared but clearing or making it safer.
    expect(h.coordinator.state()).toMatchObject({ mode: "fault", confirm_target: { prepared_by: "walker_local", title: "Let go?", action: { kind: "gripper.release", gripper_open_deg: 30 } } });
    const others = goals(h).slice(0, 5);
    await confirm(h);
    expect(h.coordinator.state()).toMatchObject({ mode: "fault", active: { kind: "gripper.release", arm: "left" } });
    await step(h, 1500);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "gripper.release", outcome: "completed" });
    expect(leftArm(h).grasp_active).toBe(false);
    expect(Math.abs(leftArm(h).joints!.gripper.degrees - 30)).toBeLessThanOrEqual(3);
    // Only the gripper was written.
    expect(goals(h).slice(0, 5)).toEqual(others);
    expect(h.invalid).toEqual([]);
    await h.stop();
  });

  it("T24: a finger in the gripper, then a stop: the squeeze is let off at once and \"Let go?\" offered; no mismatch after (no taught goal any more)", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("finger-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    expect(await until(h, () => leftArm(h).grasp_active, 3000)).not.toBeNull();
    await step(h, 300);
    h.press("t");
    await step(h, 100);
    const grip = follower(h).servo(6);
    expect(Math.abs(grip.get("goalPosition") - grip.get("presentPosition"))).toBeLessThanOrEqual(1);
    expect(h.coordinator.state().confirm_target).toMatchObject({ prepared_by: "walker_local", action: { kind: "gripper.release" } });
    await step(h, GRASP_SHORT_MS + 1000);
    expect(h.coordinator.state().faults).toEqual([]);
    await h.stop();
  });

  it("T25: on an arm gone soft (a push while holding): \"Let go?\" is offered with the fault latched, and opens only the gripper", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("object-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    await step(h, 6000);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "completed" });
    h.press("push-left");
    expect(await until(h, () => h.coordinator.state().faults.some((f) => f.code === "feedback_divergence"), 1000)).not.toBeNull();
    await step(h, 100);
    expect([...follower(h).servos.values()].map((s) => s.get("torqueLimit"))).toEqual([250, 250, 250, 250, 250, 300]);
    expect(h.coordinator.state()).toMatchObject({ mode: "fault", confirm_target: { prepared_by: "walker_local", action: { kind: "gripper.release" } } });
    h.press("object-left");
    const others = goals(h).slice(0, 5);
    await confirm(h);
    await step(h, 1500);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "gripper.release", outcome: "completed" });
    expect(leftArm(h).grasp_active).toBe(false);
    expect(goals(h).slice(0, 5)).toEqual(others);
    expect(h.invalid).toEqual([]);
    await h.stop();
  });

  it("T31: opening only: a gripper pulled open faster than \"Let go?\" opens it never gets a goal back toward closing", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("object-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    await step(h, 6000);
    expect(h.coordinator.state().confirm_target).toMatchObject({ action: { kind: "gripper.release", gripper_open_deg: 30 } });
    h.press("object-left");
    await confirm(h);
    expect(h.coordinator.state().active?.kind).toBe("gripper.release");
    // Someone pulls the gripper open to 25° and holds it there.
    const grip = follower(h).servo(6);
    grip.heldAt = 2048 + Math.round(25 * TICKS_PER_DEG);
    let worst = Infinity;
    await step(h, 300, () => {
      if (grip.get("torqueEnable") === 1) worst = Math.min(worst, grip.get("goalPosition") - grip.get("presentPosition"));
    });
    expect(worst).toBeGreaterThanOrEqual(-1);
    grip.heldAt = null;
    await h.stop();
  });

  it("T26: after a fault is cleared, a grasp still held is offered \"Let go?\" again", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    h.press("object-left");
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    await step(h, 6000);
    h.press("push-left");
    expect(await until(h, () => h.coordinator.state().faults.length > 0, 1000)).not.toBeNull();
    await step(h, 2100);
    h.press("push-left");
    // The clear replaces the pending "Let go?" (one target at a time); once it is cleared, "Let go?" comes back.
    expect(h.coordinator.operatorClear("test: the push is gone")).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    await confirm(h);
    expect(h.coordinator.state()).toMatchObject({ mode: "ready", faults: [], confirm_target: { prepared_by: "walker_local", action: { kind: "gripper.release" } } });
    await h.stop();
  });
});

describe("the timeline and the gripper events (M4)", () => {
  it("T27: the timeline starts once the arm is at the first waypoint, and a grasp waits until a lagging joint reaches its point", async () => {
    const h = makeMotionHarness();
    const seen: Array<{ text: string; at: number; elbow: number }> = [];
    await h.start();
    await readyLeft(h);
    h.bus.on("motion", ({ kind, text }) => {
      if (kind === "skill") seen.push({ text, at: h.clock.monotonic(), elbow: leftArm(h).joints?.elbow_flex.degrees ?? NaN });
    });
    // A stiff elbow (about 5°/s): it needs about 3 s for the 15° the sample moves it by its grasp at 1.6 s.
    follower(h).servo(3).slowTo = 57;
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    const pressed = h.clock.monotonic() - 50;
    expect(await until(h, () => seen.some((e) => e.text.startsWith("grasp")), 6000)).not.toBeNull();
    follower(h).servo(3).slowTo = null;
    expect(seen[0]!.text).toMatch(/at its start/);
    const grasp = seen.find((e) => e.text.startsWith("grasp"))!;
    const point = skillPoint(simSampleSkill(AT), "left", 1600).joints.elbow_flex;
    expect(Math.abs(grasp.elbow - point)).toBeLessThanOrEqual(3 + 0.2);
    expect(grasp.at - pressed).toBeGreaterThan(2500);
    expect(h.coordinator.state().faults).toEqual([]);
    expect(await until(h, () => h.coordinator.state().last_command?.kind === "skill.run", 6000)).not.toBeNull();
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "completed" });
    await h.stop();
  });
});

describe("the approach to the first waypoint (M4)", () => {
  it("T27: from 4° off the start (within its 5° tolerance), the timeline doesn't move until every joint is within 3° of the first waypoint", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    // The sample with its elbow 4° further out throughout, and the elbow stiff (about 5°/s): the approach takes a while.
    const sample = simSampleSkill(AT);
    const shifted: Skill = {
      ...sample,
      skill_id: "shifted_sample",
      start: { ...sample.start, joints: { left: { ...sample.start.joints.left!, elbow_flex: sample.start.joints.left!.elbow_flex + 4 } } },
      waypoints: sample.waypoints.map((w) => ({ ...w, joints: { left: { ...w.joints.left!, elbow_flex: w.joints.left!.elbow_flex + 4 } } })),
    };
    files(h).writeSkill(shifted, { replace: false, stamp: AT });
    follower(h).servo(3).slowTo = 57;
    let atStart: number | null = null;
    h.bus.on("motion", ({ kind, text }) => {
      if (kind === "skill" && text.includes("at its start")) atStart = leftArm(h).joints!.elbow_flex.degrees;
    });
    h.coordinator.operatorSkillRun("shifted_sample");
    await confirm(h);
    const progress: number[] = [];
    await step(h, 150, () => {
      const active = h.coordinator.state().active;
      if (active?.kind === "skill.run") progress.push(active.progress);
    });
    expect(progress.length).toBeGreaterThan(5);
    expect(progress.every((p) => p === 0)).toBe(true);
    expect(await until(h, () => atStart !== null, 2000)).not.toBeNull();
    expect(Math.abs(atStart! - shifted.waypoints[0]!.joints.left!.elbow_flex)).toBeLessThanOrEqual(3 + 0.2);
    await h.stop();
  });
});

describe("recording length (M3)", () => {
  it("T28: a recording ends at 55 s, so a servo that overshoots all along (5% over the limit) still saves under 60 s", () => {
    expect(RECORD_MAX_MS).toBe(SKILL_MAX_DURATION_MS - 5000);
    const overshooting = (ms: number) => Array.from({ length: ms / 20 + 1 }, (_, i) => ({ t: i * 20, joints: { ...zeros, shoulder_pan: i % 2 ? 1.26 : 0 } }));
    const base = { skillId: "long", title: "Long", arm: "left" as const, createdAt: AT, events: [], calibration: calibration(), speedDegS: 60, letGoDeg: null };
    const fits = recordedSkill({ ...base, samples: overshooting(RECORD_MAX_MS) });
    expect(fits.ok).toBe(true);
    if (fits.ok) {
      expect(fits.skill.waypoints.at(-1)!.t_ms).toBeGreaterThan(RECORD_MAX_MS);
      expect(fits.skill.waypoints.at(-1)!.t_ms).toBeLessThanOrEqual(SKILL_MAX_DURATION_MS);
      expect(SkillSchema.safeParse(fits.skill).success).toBe(true);
    }
    // At the contract's full 60 s the same overshoot couldn't be saved.
    expect(recordedSkill({ ...base, samples: overshooting(SKILL_MAX_DURATION_MS) }).ok).toBe(false);
  });
});

/** Replays the sample to its end with the object in the left gripper: holding, "Let go?" pending. */
async function holdingSample(h: MotionHarness): Promise<void> {
  await readyLeft(h);
  h.press("object-left");
  h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
  await confirm(h);
  await step(h, 6000);
  expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "completed" });
  expect(leftArm(h).grasp_active).toBe(true);
}

describe("the release path (re-review)", () => {
  it("T32: opening is the way back from how the grasp closed: grasp at 30° closed to 10°, jaws pulled to 50°, Let go? to 30° doesn't move toward closing and completes", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    // A made-up skill (SIMULATED): from `ready` with the gripper opening to 30°, a grasp at 0.7 s, closing to 10°.
    const ready = { shoulder_pan: 0, shoulder_lift: -20, elbow_flex: 30, wrist_flex: 10, wrist_roll: 0, gripper: 28 };
    const keys: Array<[number, number]> = [[0, 28], [600, 30], [1700, 10], [2000, 10]];
    const waypoints: Skill["waypoints"] = [];
    for (let t = 0; t <= 2000; t += 20) {
      const k = keys.findIndex(([kt], i) => i + 1 < keys.length && t >= kt && t <= keys[i + 1]![0]);
      const [t0, g0] = keys[k]!;
      const [t1, g1] = keys[k + 1]!;
      const f = (1 - Math.cos((Math.PI * (t - t0)) / (t1 - t0))) / 2;
      waypoints.push({ t_ms: t, joints: { left: { ...ready, gripper: Math.round((g0 + (g1 - g0) * f) * 100) / 100 } } });
    }
    const wide: Skill = {
      ...simSampleSkill(AT),
      skill_id: "wide_grip",
      start: { joints: { left: { ...ready } }, tolerance_deg: 10 },
      max_speed_deg_s: Object.fromEntries(ARM_JOINTS.map((j) => [j, 40])) as Skill["max_speed_deg_s"],
      waypoints,
      gripper_events: [{ t_ms: 700, arm: "left", kind: "grasp" }],
      let_go: [{ arm: "left", gripper_open_deg: 30 }],
    };
    files(h).writeSkill(wide, { replace: false, stamp: AT });
    h.coordinator.operatorSkillRun("wide_grip");
    await confirm(h);
    await step(h, 4000);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "completed" });
    // Someone pulls the jaws open to 50° and holds them.
    const grip = follower(h).servo(6);
    grip.heldAt = 2048 + Math.round(50 * TICKS_PER_DEG);
    // 40° from its taught 10°: grasp_mismatch, and "Let go?" offered again (to 30°) with the fault latched.
    expect(await until(h, () => h.coordinator.state().faults.some((f) => f.code === "grasp_mismatch"), 1000)).not.toBeNull();
    await step(h, 2100);
    expect(h.coordinator.state().confirm_target).toMatchObject({ action: { kind: "gripper.release", gripper_open_deg: 30 } });
    let worst = Infinity;
    h.press("c");
    await step(h, 500, () => {
      worst = Math.min(worst, grip.get("goalPosition") - grip.get("presentPosition"));
    });
    expect(worst).toBeGreaterThanOrEqual(-1);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "gripper.release", outcome: "completed" });
    expect(leftArm(h).grasp_active).toBe(false);
    grip.heldAt = null;
    await h.stop();
  });

  it("T32: a typed angle is refused while the grasp's closing direction isn't known yet", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirm(h);
    // Marked, but the gripper never closed: no direction yet.
    const id = await recordLeft(h, 300, { during: async (id) => void h.coordinator.operatorRecordMark(id, "grasp") });
    void id;
    await step(h, 2100);
    expect(h.coordinator.operatorLetGo("left", 20)).toMatchObject({ ok: false });
    expect(h.coordinator.operatorLetGo("left", null)).toMatchObject({ ok: true });
    await h.stop();
  });

  it("T33: a release that passes its deadline while motion_timeout is already latched on that arm still ends", async () => {
    const h = makeMotionHarness();
    await h.start();
    await holdingSample(h);
    // Someone holds the gripper shut: "Let go?" can't open it.
    const grip = follower(h).servo(6);
    grip.heldAt = grip.get("presentPosition");
    await confirm(h);
    expect(h.coordinator.state().active?.kind).toBe("gripper.release");
    expect(await until(h, () => h.coordinator.state().faults.some((f) => f.code === "motion_timeout"), 6000)).not.toBeNull();
    expect(h.coordinator.state().active).toBeNull();
    // Offered again with the fault latched; it can't open this time either, and must still end at its deadline.
    await step(h, 2100);
    expect(h.coordinator.state().confirm_target, h.log.lines.filter((l) => l.includes("not prepared") || l.includes("fault")).join("\n")).toMatchObject({ action: { kind: "gripper.release" } });
    h.press("c");
    await step(h, 50);
    expect(h.coordinator.state().active?.kind).toBe("gripper.release");
    expect(await until(h, () => h.coordinator.state().active === null, 6000)).not.toBeNull();
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "gripper.release", outcome: "faulted" });
    grip.heldAt = null;
    await h.stop();
  });

  it("T34: a freeze while holding: the squeeze is let off at the first fresh read (gripper only, the arm stays frozen), and Let go? then opens it", async () => {
    const h = makeMotionHarness();
    await h.start();
    await holdingSample(h);
    const grip = follower(h).servo(6);
    expect(grip.get("goalPosition") - grip.get("presentPosition")).toBeLessThan(-20);
    h.press("stale-left");
    expect(await until(h, () => h.coordinator.state().faults.some((f) => f.code === "feedback_stale"), 1000)).not.toBeNull();
    await step(h, 300);
    // Still squeezing while it can't be read: nothing may be written from a stale reading.
    expect(grip.get("goalPosition") - grip.get("presentPosition")).toBeLessThan(-20);
    const frozen = goals(h).slice(0, 5);
    h.press("stale-left");
    await step(h, 200);
    expect(Math.abs(grip.get("goalPosition") - grip.get("presentPosition"))).toBeLessThanOrEqual(1);
    expect(goals(h).slice(0, 5)).toEqual(frozen);
    // Letting go works on the frozen arm, with the fault latched: only the gripper moves.
    h.press("object-left");
    expect(h.coordinator.operatorLetGo("left", null)).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    await confirm(h);
    await step(h, 1500);
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "gripper.release", outcome: "completed" });
    expect(goals(h).slice(0, 5)).toEqual(frozen);
    expect(Math.abs(leftArm(h).joints!.gripper.degrees - 30)).toBeLessThanOrEqual(3);
    await h.stop();
  });

  it("T35: a fault clear is refused while letting go runs", async () => {
    const h = makeMotionHarness();
    await h.start();
    await holdingSample(h);
    h.press("push-left");
    expect(await until(h, () => h.coordinator.state().faults.length > 0, 1000)).not.toBeNull();
    h.press("push-left");
    h.press("object-left");
    await confirm(h);
    expect(h.coordinator.state().active?.kind).toBe("gripper.release");
    expect(h.coordinator.operatorClear("test: mid-release")).toMatchObject({ ok: true, request: { state: "refused", refusal: "busy" } });
    await h.stop();
  });
});

describe("minors", () => {
  it("T29: a grasp whose hold torque can't be written isn't active (no exemption), and the replay stops", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    const slots = (h.coordinator as unknown as { slots: Array<{ side: string; role: string; link: { writeTorqueLimits: (l: Array<{ id: number; value: number }>) => Promise<void> } }> }).slots;
    const link = slots.find((s) => s.side === "left" && s.role === "follower")!.link;
    const original = link.writeTorqueLimits.bind(link);
    link.writeTorqueLimits = async (limits) => {
      if (limits.length === 1 && limits[0]!.value === 300) throw new Error("no acknowledgement (test)");
      return original(limits);
    };
    h.coordinator.operatorSkillRun(SIM_SAMPLE_SKILL_ID);
    await confirm(h);
    expect(await until(h, () => h.coordinator.state().last_command?.kind === "skill.run", 4000)).not.toBeNull();
    expect(h.coordinator.state().last_command).toMatchObject({ kind: "skill.run", outcome: "stopped" });
    expect(leftArm(h).grasp_active).toBe(false);
    await h.stop();
  });

  it("T30: an offer of a skill that fails its checks is dropped with a log line, and latches nothing", async () => {
    const h = makeMotionHarness();
    await h.start();
    await readyLeft(h);
    for (const edit of ["skill-edit-too-fast", "skill-edit-out-of-range"]) {
      h.press(edit);
      expect(h.coordinator.requestOffer({ target: { kind: "skill.run", skill_id: SIM_SAMPLE_SKILL_ID } })).toBeNull();
      expect(h.coordinator.state().faults).toEqual([]);
      expect(h.coordinator.state().confirm_target).toBeNull();
    }
    expect(h.log.lines.filter((l) => l.includes("that skill fails its checks")).length).toBe(2);
    await h.stop();
  });
});
