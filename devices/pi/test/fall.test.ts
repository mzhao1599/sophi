import { describe, expect, it } from "vitest";
import { CameraLeases, RawFrames, ffmpegArgs, type AnalysisFrame, type CameraFrame, type FrameSource } from "../src/camera/capture";
import {
  DROP_WINDOW_MS,
  FALL_CONFIRM_MS,
  FallDetector,
  LYING_CONFIRM_MS,
  REARM_MS,
  postureOf,
  type FallEvent,
} from "../src/fall/detector";
import { readFallSettings } from "../src/fall";
import { KEYPOINTS, MODEL_SIZE, letterbox, loadMoveNet, poseFromMoveNet, type Pose, type PoseModel } from "../src/fall/pose";
import { FallWatch } from "../src/fall/watch";
import { boot, captureLogger, flush, makeHarness, FakeClock } from "./support/fakes";

/** Rows FD (detector), FP (pose), FC (camera sharing), FW (watch) and FH (help) in test/EXPECTED.md ("Fall check"). */

// ---- Synthetic people: a torso of fixed length, its centre at (x, y), leaning `tiltDeg` from upright ----

const ASPECT = 4 / 3;

/** A person seen from the walker: head, shoulders, hips and knees around a centre, every point sure. */
function person(y: number, tiltDeg = 0, x = 0.5, score = 0.9): Pose {
  const rad = (tiltDeg * Math.PI) / 180;
  // Half the torso, in frame heights; x offsets are divided by the aspect so the true angle is tiltDeg.
  const half = 0.15;
  const dx = (Math.sin(rad) * half) / ASPECT;
  const dy = Math.cos(rad) * half;
  const at = (k: number, spread = 0.04): Array<{ x: number; y: number; score: number }> => [
    { x: x + dx * k - spread, y: y - dy * k, score },
    { x: x + dx * k + spread, y: y - dy * k, score },
  ];
  const pose: Pose = KEYPOINTS.map(() => ({ x, y, score: 0.05 }));
  const [ls, rs] = at(1);
  const [lh, rh] = at(-1);
  const [lk, rk] = at(-2.2);
  pose[0] = { x: x + dx * 1.6, y: y - dy * 1.6, score };
  pose[5] = ls!;
  pose[6] = rs!;
  pose[11] = lh!;
  pose[12] = rh!;
  pose[13] = lk!;
  pose[14] = rk!;
  return pose;
}

/** Feeds frames at `fps` from `from` ms for `ms`, each from `poseAt(t)` (t from 0 to 1), returning any event. */
function run(d: FallDetector, from: number, ms: number, poseAt: (t: number) => Pose | null, fps = 5): { events: FallEvent[]; end: number } {
  const events: FallEvent[] = [];
  const step = 1000 / fps;
  let at = from;
  for (; at <= from + ms; at += step) {
    const e = d.push(poseAt(ms === 0 ? 1 : (at - from) / ms), at);
    if (e) events.push(e);
  }
  return { events, end: at };
}

const lerp = (a: number, b: number) => (t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

describe("fall detector over body points (src/fall/detector.ts)", () => {
  it("FD1: upright reads as upright, lying as lying, with the frame's aspect", () => {
    expect(postureOf(person(0.5, 0), ASPECT).tiltDeg).toBeCloseTo(0, 5);
    expect(postureOf(person(0.5, 80), ASPECT).tiltDeg).toBeCloseTo(80, 5);
    expect(postureOf(person(0.5), ASPECT).centerY).toBeCloseTo(0.5, 5);
    expect(postureOf(null).present).toBe(false);
    // Low confidence everywhere: nobody.
    expect(postureOf(person(0.5, 0, 0.5, 0.1)).present).toBe(false);
  });

  it("FD2: a fast drop to lying, staying down, is a fall (dropped_and_down) once FALL_CONFIRM_MS has passed", () => {
    const d = new FallDetector({ aspect: ASPECT });
    expect(run(d, 0, 2000, () => person(0.45)).events).toEqual([]);
    const y = lerp(0.45, 0.82);
    const tilt = lerp(0, 85);
    const fall = run(d, 2200, 600, (t) => person(y(t), tilt(t)));
    expect(fall.events).toEqual([]);
    const down = run(d, fall.end, FALL_CONFIRM_MS + 400, () => person(0.82, 85));
    expect(down.events).toHaveLength(1);
    expect(down.events[0]!.why).toBe("dropped_and_down");
    expect(down.events[0]!.at - down.events[0]!.since).toBeLessThan(DROP_WINDOW_MS + FALL_CONFIRM_MS + 800);
  });

  it("FD3: sitting down slowly, upright, is never a fall", () => {
    const d = new FallDetector({ aspect: ASPECT });
    run(d, 0, 1000, () => person(0.45));
    const y = lerp(0.45, 0.68);
    const sit = run(d, 1200, 2500, (t) => person(y(t), 8));
    const seated = run(d, sit.end, 20_000, () => person(0.68, 5));
    expect([...sit.events, ...seated.events]).toEqual([]);
  });

  it("FD4: a stumble she catches (fast dip, back upright where she was) is not a fall", () => {
    const d = new FallDetector({ aspect: ASPECT });
    run(d, 0, 1000, () => person(0.45));
    const dip = run(d, 1200, 400, (t) => person(lerp(0.45, 0.72)(t), lerp(0, 40)(t)));
    const back = run(d, dip.end, 400, (t) => person(lerp(0.72, 0.47)(t), lerp(40, 5)(t)));
    const after = run(d, back.end, 10_000, () => person(0.46));
    expect([...dip.events, ...back.events, ...after.events]).toEqual([]);
  });

  it("FD5: dropping fast out of the bottom of the picture and staying gone is a fall (dropped_out_of_view)", () => {
    const d = new FallDetector({ aspect: ASPECT });
    run(d, 0, 1000, () => person(0.5));
    const drop = run(d, 1200, 400, (t) => person(lerp(0.5, 0.75)(t), lerp(0, 30)(t)));
    const gone = run(d, drop.end, FALL_CONFIRM_MS + 400, () => null);
    expect(gone.events.map((e) => e.why)).toEqual(["dropped_out_of_view"]);
  });

  it("FD6: walking out of the picture sideways, or being out of it from the start, is not a fall", () => {
    const d = new FallDetector({ aspect: ASPECT });
    const walk = run(d, 0, 1500, (t) => person(0.45, 0, lerp(0.5, 0.95)(t)));
    const gone = run(d, walk.end, 30_000, () => null);
    expect([...walk.events, ...gone.events]).toEqual([]);
    const empty = new FallDetector();
    expect(run(empty, 0, 30_000, () => null).events).toEqual([]);
  });

  it("FD7: lying in view for LYING_CONFIRM_MS with no drop first (a slow slump) is a fall (lying)", () => {
    const d = new FallDetector({ aspect: ASPECT });
    run(d, 0, 1000, () => person(0.6));
    const slump = run(d, 1200, 4000, (t) => person(lerp(0.6, 0.66)(t), lerp(0, 75)(t)));
    expect(slump.events).toEqual([]);
    const lying = run(d, slump.end, LYING_CONFIRM_MS + 400, () => person(0.66, 78));
    expect(lying.events.map((e) => e.why)).toEqual(["lying"]);
  });

  it("FD8: one report per fall; another only after she has been upright for REARM_MS", () => {
    const d = new FallDetector({ aspect: ASPECT });
    run(d, 0, 1000, () => person(0.45));
    const first = run(d, 1200, 500, (t) => person(lerp(0.45, 0.82)(t), lerp(0, 85)(t)));
    const down = run(d, first.end, 30_000, () => person(0.82, 85));
    expect(down.events).toHaveLength(1);
    expect(d.reported()).toBe(true);
    // Upright, but not for long enough: still reported.
    const brief = run(d, down.end, REARM_MS - 1000, () => person(0.45));
    expect(d.reported()).toBe(true);
    const longer = run(d, brief.end, 2000, () => person(0.45));
    expect(d.reported()).toBe(false);
    const second = run(d, longer.end, 500, (t) => person(lerp(0.45, 0.82)(t), lerp(0, 85)(t)));
    const again = run(d, second.end, FALL_CONFIRM_MS + 400, () => person(0.82, 85));
    expect(again.events).toHaveLength(1);
  });

  it("FD9: a fast drop that ends seated upright (dropping onto a seat) times out without a report", () => {
    const d = new FallDetector({ aspect: ASPECT });
    run(d, 0, 1000, () => person(0.45));
    const plop = run(d, 1200, 400, (t) => person(lerp(0.45, 0.72)(t), 10));
    const seated = run(d, plop.end, 15_000, () => person(0.72, 8));
    expect([...plop.events, ...seated.events]).toEqual([]);
  });
});

describe("MoveNet's points on the camera frame (src/fall/pose.ts)", () => {
  it("FP1: a 640 x 480 frame fits 192 x 144 inside the square, 24 pixels of border above and below", () => {
    expect(letterbox(640, 480)).toEqual({ size: 192, width: 192, height: 144, padX: 0, padY: 24 });
    expect(letterbox(480, 640)).toEqual({ size: 192, width: 144, height: 192, padX: 24, padY: 0 });
  });

  it("FP2: (y, x, score) in the padded square map back to the frame; the border clamps to the edge", () => {
    const box = letterbox(640, 480);
    const out = new Float32Array(17 * 3);
    // Point 0 at the frame's centre, point 1 at its top-left corner, point 2 in the top border.
    out.set([0.5, 0.5, 0.9], 0);
    out.set([24 / 192, 0, 0.8], 3);
    out.set([0.05, 0.25, 0.7], 6);
    const pose = poseFromMoveNet(out, box);
    expect(pose[0]).toEqual({ x: 0.5, y: 0.5, score: expect.closeTo(0.9, 5) });
    expect(pose[1]!.x).toBeCloseTo(0, 5);
    expect(pose[1]!.y).toBeCloseTo(0, 5);
    expect(pose[2]!.y).toBe(0);
    expect(() => poseFromMoveNet(new Float32Array(10), box)).toThrow(/expected 51/);
  });

  it("FP3: loadMoveNet feeds int32 RGB [1, 192, 192, 3] and reads the first output", async () => {
    const box = letterbox(640, 480);
    const seen: Array<{ type: string; dims: number[]; first: number }> = [];
    class Tensor {
      constructor(
        readonly type: string,
        readonly data: Int32Array,
        readonly dims: number[],
      ) {}
    }
    const output = new Float32Array(51).fill(0.5);
    let released = false;
    const model = await loadMoveNet("/model.onnx", box, {
      importOrt: async () => ({
        Tensor: Tensor as never,
        InferenceSession: {
          create: async () => ({
            inputNames: ["input"],
            outputNames: ["output_0"],
            run: async (feeds: Record<string, unknown>) => {
              const t = feeds.input as Tensor;
              seen.push({ type: t.type, dims: t.dims, first: t.data[0]! });
              return { output_0: { data: output } };
            },
            release: async () => {
              released = true;
            },
          }),
        },
      }),
    });
    const rgb = new Uint8Array(MODEL_SIZE * MODEL_SIZE * 3).fill(200);
    const pose = await model.estimate(rgb);
    expect(seen).toEqual([{ type: "int32", dims: [1, 192, 192, 3], first: 200 }]);
    expect(pose).toHaveLength(17);
    await expect(model.estimate(new Uint8Array(5))).rejects.toThrow(/must be 110592 bytes/);
    await model.close();
    expect(released).toBe(true);
  });

  it("FP4: without onnxruntime-node, loading says so plainly", async () => {
    await expect(
      loadMoveNet("/model.onnx", letterbox(640, 480), {
        importOrt: async () => {
          throw new Error("Cannot find package");
        },
      }),
    ).rejects.toThrow(/onnxruntime-node isn't installed beside walker.mjs/);
  });

  it("FP5: settings: off unless WALKER_FALL_CHECK=on; the model path and rate have defaults and limits", () => {
    expect(readFallSettings({})).toEqual({ kind: "off" });
    expect(readFallSettings({ WALKER_FALL_CHECK: "off" })).toEqual({ kind: "off" });
    expect(readFallSettings({ WALKER_FALL_CHECK: "on" })).toEqual({ kind: "on", modelPath: "/opt/steady-walker/models/movenet-singlepose-lightning.onnx", fps: 5 });
    expect(readFallSettings({ WALKER_FALL_CHECK: "on", WALKER_POSE_MODEL: "/m.onnx", WALKER_FALL_FPS: "8" })).toEqual({ kind: "on", modelPath: "/m.onnx", fps: 8 });
    expect(readFallSettings({ WALKER_FALL_CHECK: "yes" }).kind).toBe("error");
    expect(readFallSettings({ WALKER_FALL_CHECK: "on", WALKER_FALL_FPS: "40" }).kind).toBe("error");
  });
});

describe("one camera for the live view and the fall check (src/camera/capture.ts)", () => {
  it("FC1: with analysis, ffmpeg adds a second output: scaled, padded, RGB on pipe:3; the MJPEG copy is unchanged", () => {
    const spec = { kind: "camera" as const, device: "/dev/v4l/by-id/usb-046d_C270-video-index0", width: 640, height: 480, fps: 15 };
    const plain = ffmpegArgs(spec);
    const both = ffmpegArgs(spec, { box: letterbox(640, 480), fps: 5 });
    expect(both.slice(0, plain.length)).toEqual(plain);
    expect(both.slice(plain.length)).toEqual(["-an", "-vf", "fps=5,scale=192:144,pad=192:192:0:24:black", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:3"]);
  });

  it("FC2: raw pictures come out whole, whatever the chunking", () => {
    const size = 12;
    const stream = Buffer.from(Array.from({ length: size * 3 + 5 }, (_, i) => i));
    for (const chunk of [1, 5, 12, 13, 41]) {
      const frames: number[][] = [];
      const raw = new RawFrames(size, (rgb) => frames.push([...rgb]));
      for (let i = 0; i < stream.length; i += chunk) raw.push(stream.subarray(i, i + chunk));
      expect(frames, `chunks of ${chunk}`).toEqual([0, 1, 2].map((f) => [...stream.subarray(f * size, (f + 1) * size)]));
    }
  });

  it("FC3: the camera runs while any lease is started, and stops only when the last one stops", () => {
    const calls: string[] = [];
    const camera: FrameSource = {
      source: "camera",
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
      latest: () => ({ seq: 1, jpeg: Buffer.alloc(0), at: 0 }) satisfies CameraFrame,
      onFrame: () => () => {},
    };
    const leases = new CameraLeases(camera);
    const link = leases.lease();
    const fall = leases.lease();
    fall.start();
    link.start();
    link.start();
    expect(calls).toEqual(["start"]);
    link.stop();
    expect(calls).toEqual(["start"]);
    expect(link.latest()).toBeNull();
    expect(fall.latest()?.seq).toBe(1);
    fall.stop();
    fall.stop();
    expect(calls).toEqual(["start", "stop"]);
  });
});

/** A fake model: answers each picture with the pose its first byte names, after `ms` on the fake clock. */
function fakeModel(clock: FakeClock, poses: Pose[], ms = 50): PoseModel & { runs: number } {
  const model = {
    runs: 0,
    async estimate(rgb: Uint8Array) {
      model.runs += 1;
      await new Promise<void>((resolve) => clock.setTimeout(resolve, ms));
      const pose = poses[rgb[0]!];
      if (!pose) throw new Error("no such pose");
      return pose;
    },
    close: async () => {},
  };
  return model;
}

describe("the fall watch (src/fall/watch.ts)", () => {
  function setup(poses: Pose[], ms = 50) {
    const clock = new FakeClock();
    const log = captureLogger();
    let emit: ((f: AnalysisFrame) => void) | null = null;
    const started: string[] = [];
    const lease: FrameSource = { source: "camera", start: () => started.push("start"), stop: () => started.push("stop"), latest: () => null, onFrame: () => () => {} };
    const falls: FallEvent[] = [];
    const model = fakeModel(clock, poses, ms);
    const watch = new FallWatch({
      clock,
      log,
      camera: lease,
      onAnalysis: (fn) => {
        emit = fn;
        return () => (emit = null);
      },
      model,
      detector: new FallDetector({ aspect: ASPECT }),
      onFall: (e) => falls.push(e),
    });
    let seq = 0;
    const picture = (poseIndex: number) => emit?.({ seq: ++seq, rgb: new Uint8Array([poseIndex]), at: clock.monotonic() });
    return { clock, log, watch, falls, model, started, picture, emitting: () => emit !== null };
  }

  it("FW1: keeps the camera on while running; a picture that arrives while the model is busy replaces the waiting one", async () => {
    const s = setup([person(0.45)], 100);
    s.watch.start();
    expect(s.started).toEqual(["start"]);
    s.picture(0);
    s.picture(0);
    s.picture(0);
    s.picture(0);
    await s.clock.advance(100);
    await flush();
    await s.clock.advance(100);
    await flush();
    // The first, then only the newest of the three that waited.
    expect(s.model.runs).toBe(2);
    await s.watch.stop();
    expect(s.started).toEqual(["start", "stop"]);
    expect(s.emitting()).toBe(false);
  });

  it("FW2: a fall in the pictures calls onFall once; model errors never count as a fall", async () => {
    const poses = [person(0.45), person(0.6, 40), person(0.82, 85)];
    const s = setup(poses, 10);
    s.watch.start();
    const frame = async (i: number) => {
      s.picture(i);
      await s.clock.advance(200);
      await flush();
    };
    for (let i = 0; i < 6; i += 1) await frame(0);
    await frame(1);
    for (let i = 0; i < 30; i += 1) await frame(2);
    expect(s.falls.map((f) => f.why)).toEqual(["dropped_and_down"]);
    expect(s.log.lines.some((l) => l.includes("fall check: possible fall"))).toBe(true);

    const broken = setup([], 10);
    broken.watch.start();
    for (let i = 0; i < 50; i += 1) {
      broken.picture(7);
      await broken.clock.advance(200);
      await flush();
    }
    expect(broken.falls).toEqual([]);
    expect(broken.log.lines.filter((l) => l.startsWith("error pose model failed"))).toHaveLength(1);
  });
});

describe("a possible fall asks for help after a countdown (src/help.ts, fallSeen)", () => {
  const FALL_LINE = "It looks like you may have fallen. I'll ask for help in 8 seconds. Press any button to stop.";

  it("FH1: the walker says the line, counts down 8 s, then asks with source camera", async () => {
    const h = makeHarness();
    await boot(h);
    h.service.fallSeen();
    await flush();
    expect(h.speaker.cues).toContain("help");
    expect(h.spoken("help")).toEqual([FALL_LINE]);
    await h.clock.advance(7_000);
    expect(h.client.calls.filter((c) => c === "help:ask")).toHaveLength(0);
    await h.clock.advance(2_000);
    expect(h.client.calls.filter((c) => c === "help:ask")).toHaveLength(1);
    expect(h.device()!.help[0]!.source).toBe("camera");
    expect(h.spoken("help")).toEqual([FALL_LINE, "Asking for help.", "Sent to Maya's phone."]);
  });

  it("FH2: any handle press during the countdown stops it, and nothing is sent", async () => {
    const h = makeHarness();
    await boot(h);
    h.service.fallSeen();
    await flush();
    await h.clock.advance(3_000);
    h.press("talk", "pressed");
    h.press("talk", "released");
    await flush();
    await h.clock.advance(20_000);
    expect(h.client.calls.filter((c) => c === "help:ask")).toHaveLength(0);
    expect(h.spoken("help")).toEqual([FALL_LINE, "Okay. I didn't ask anyone."]);
  });

  it("FH3: while a request is already open, a possible fall starts nothing new", async () => {
    const h = makeHarness();
    await boot(h);
    h.service.fallSeen();
    await flush();
    await h.clock.advance(9_000);
    expect(h.client.calls.filter((c) => c === "help:ask")).toHaveLength(1);
    h.service.fallSeen();
    await flush();
    await h.clock.advance(20_000);
    expect(h.client.calls.filter((c) => c === "help:ask")).toHaveLength(1);
    expect(h.spoken("help").filter((l) => l === FALL_LINE)).toHaveLength(1);
  });
});
