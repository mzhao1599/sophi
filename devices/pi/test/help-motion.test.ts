import { HELP_CHORD_WINDOW_MS } from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { helpText } from "../src/sim/script";
import { makeMotionHarness, type MotionHarness } from "./support/motion";

/** Rows GH8 and GM1 to GM4 of test/EXPECTED.md: help and the motion coordinator, on simulated arms and a fake clock. */

function record(h: MotionHarness) {
  const seen: string[] = [];
  const helps: string[] = [];
  const cues: string[] = [];
  const spoke: string[] = [];
  h.bus.on("motion", ({ kind, text }) => seen.push(`${kind} ${text}`));
  h.bus.on("help", ({ screen }) => helps.push(helpText(screen)));
  h.bus.on("cue", ({ name }) => cues.push(name));
  h.bus.on("spoke", ({ text }) => spoke.push(text));
  return { seen, helps, cues, spoke };
}

/** Torque on for the left arm, and the left arm's "ready" pose as the pending target (keyboard Confirm: at once). */
async function poseTarget(h: MotionHarness): Promise<void> {
  h.coordinator.operatorTorque(true, ["left"]);
  await h.clock.advance(2100);
  h.press("c");
  await h.clock.advance(50);
  h.coordinator.operatorGoToPose("left", "ready");
  expect(h.coordinator.state().confirm_target?.action.kind).toBe("arm.go_to_pose");
}

/** Pretends the pending target is a "Let go?" (white box: a real one needs a taught grasp, tested in skills.test.ts). */
function asLetGo(h: MotionHarness): void {
  const pending = (h.coordinator as unknown as { pending: { target: { action: { kind: string } } } }).pending;
  pending.target = { ...pending.target, action: { kind: "gripper.release", arm: "left", gripper_open_deg: 30 } as never };
}

describe("help and the motion coordinator", () => {
  it("GH8: the chord's first press stops a running motion at once, and the chord goes on", async () => {
    const h = makeMotionHarness();
    const r = record(h);
    await h.start();
    await poseTarget(h);
    await h.clock.advance(2100);
    h.press("c");
    await h.clock.advance(60);
    expect(h.coordinator.state().active?.kind).toBe("arm.go_to_pose");
    h.hand.press("talk", "pressed");
    await h.clock.advance(20);
    expect(h.coordinator.state().active).toBeNull();
    h.hand.press("confirm", "pressed");
    await h.clock.advance(20);
    expect(r.cues).toContain("help");
    expect(r.helps.at(-1)).toBe("help_hold");
    await h.clock.advance(2000);
    expect(r.spoke).toContain("Asking for help.");
    await h.stop();
  });

  it("GM1: help taking Confirm withdraws a pending target; a pending Let go? stays", async () => {
    const h = makeMotionHarness();
    const r = record(h);
    await h.start();
    await poseTarget(h);
    h.coordinator.helpActive(true);
    expect(h.coordinator.state().confirm_target).toBeNull();
    expect(r.seen.some((e) => e.startsWith("target-ended withdrawn: help owns Confirm"))).toBe(true);
    h.coordinator.helpActive(false);
    h.coordinator.operatorGoToPose("left", "ready");
    asLetGo(h);
    h.coordinator.helpActive(true);
    expect(h.coordinator.state().confirm_target?.action.kind).toBe("gripper.release");
    await h.stop();
  });

  it("GM2: a new target while help owns Confirm is refused confirm_busy", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.helpActive(true);
    expect(h.coordinator.operatorTorque(true, ["left"])).toMatchObject({ ok: true, request: { state: "refused", refusal: "confirm_busy" } });
    h.coordinator.helpActive(false);
    expect(h.coordinator.operatorTorque(true, ["left"])).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    await h.stop();
  });

  it("GM3: while help owns Confirm, a hand Confirm press doesn't answer a pending Let go?", async () => {
    const h = makeMotionHarness();
    await h.start();
    await poseTarget(h);
    asLetGo(h);
    h.coordinator.helpActive(true);
    await h.clock.advance(2100);
    const claimed = h.coordinator.handlePress({ button: "confirm", edge: "pressed", source: "esp32", detail: "hand-right-sim" });
    expect(claimed).toBe(false);
    await h.clock.advance(HELP_CHORD_WINDOW_MS + 100);
    expect(h.coordinator.state().confirm_target?.action.kind).toBe("gripper.release");
    expect(h.coordinator.state().active).toBeNull();
    await h.stop();
  });

  it("GM4: a hand Confirm on a target is answered 250 ms later; Talk in the window withdraws it and nothing runs", async () => {
    const h = makeMotionHarness();
    await h.start();
    await poseTarget(h);
    await h.clock.advance(2100);
    h.hand.press("confirm", "pressed");
    await h.clock.advance(HELP_CHORD_WINDOW_MS - 20);
    expect(h.coordinator.state().active).toBeNull();
    await h.clock.advance(60);
    expect(h.coordinator.state().active?.kind).toBe("arm.go_to_pose");
    h.hand.press("confirm", "released");
    await h.clock.advance(3000);

    const g = makeMotionHarness();
    await g.start();
    await poseTarget(g);
    await g.clock.advance(2100);
    g.hand.press("confirm", "pressed");
    await g.clock.advance(100);
    g.hand.press("talk", "pressed");
    await g.clock.advance(HELP_CHORD_WINDOW_MS + 200);
    expect(g.coordinator.state().active).toBeNull();
    expect(g.coordinator.state().confirm_target).toBeNull();
    await h.stop();
    await g.stop();
  });
});
