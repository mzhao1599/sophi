import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { CAMERA_FRAME_MAX_BYTES, CAMERA_SOURCE_HEADER, type CameraSource } from "@walker/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { FfmpegCamera, KILL_AFTER_MS, ffmpegArgs, type CameraFrame, type FrameSource } from "../src/camera/capture";
import { readCameraSettings } from "../src/camera";
import { JpegSplitter, STANDARD_DHT, withHuffmanTables } from "../src/camera/jpeg";
import { CameraLink, CREDENTIAL_RECHECK_MS, FAILING_MAX_MS, FRAME_INTERVAL_MS, NO_FRAME_MS, WAIT_RETRY_MIN_MS } from "../src/camera/link";
import { CloudError, HttpCameraCloud, type CameraCloud } from "../src/cloud/client";
import type { CredentialFile } from "../src/store";
import { FakeClock, captureLogger, flush } from "./support/fakes";

// ---- Synthetic JPEGs: the splitter walks structure, so the scan bytes needn't decode ----

function segment(marker: number, payload: number[]): number[] {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

/** SOI, an APP0 holding `FF D9`, a DQT, an SOF0, an SOS, scan bytes with stuffing and restart markers, EOI. */
function jpeg(tag: number, options: { dht?: boolean; scanBytes?: number } = {}): Buffer {
  const scan: number[] = [tag, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd7, tag];
  for (let i = 0; i < (options.scanBytes ?? 0); i += 1) scan.push(i % 0xfe);
  return Buffer.from([
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9, 0xff, 0xd8]),
    ...segment(0xdb, Array<number>(65).fill(1)),
    ...(options.dht ? [...STANDARD_DHT] : []),
    ...segment(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    ...scan,
    0xff, 0xd9,
  ]);
}

function split(chunks: Buffer[], max = CAMERA_FRAME_MAX_BYTES) {
  const frames: Buffer[] = [];
  const splitter = new JpegSplitter(max, (f) => frames.push(f));
  for (const chunk of chunks) splitter.push(chunk);
  return { frames, dropped: splitter.dropped };
}

describe("MJPEG splitter and Huffman tables (src/camera/jpeg.ts)", () => {
  const a = jpeg(1);
  const b = jpeg(2, { dht: true });
  const c = jpeg(3);
  const stream = Buffer.concat([a, b, c]);

  it("CJ1: the same frames, byte for byte, whatever the chunking", () => {
    expect(split([stream]).frames).toEqual([a, b, c]);
    for (let size = 1; size <= 7; size += 1) {
      const chunks: Buffer[] = [];
      for (let i = 0; i < stream.length; i += size) chunks.push(stream.subarray(i, i + size));
      expect(split(chunks).frames, `chunks of ${size}`).toEqual([a, b, c]);
    }
    for (let cut = 1; cut < stream.length; cut += 1) {
      expect(split([stream.subarray(0, cut), stream.subarray(cut)]).frames, `cut at ${cut}`).toEqual([a, b, c]);
    }
  });

  it("CJ2: garbage is skipped, a frame cut off by a new SOI is dropped", () => {
    const cut = a.subarray(0, a.length - 6);
    const { frames, dropped } = split([Buffer.from([1, 2, 0xff, 3]), a, Buffer.from([0x00, 0xff, 0x10]), cut, b, Buffer.from([9, 9, 0xff])]);
    expect(frames).toEqual([a, b]);
    expect(dropped).toBe(1);
  });

  it("CJ3: stuffing, restart markers and an FF D9 inside APP0 don't end a frame", () => {
    const { frames } = split([a]);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.length).toBe(a.length);
  });

  it("CJ4: a frame over the limit is dropped and the next comes out whole", () => {
    const big = jpeg(4, { scanBytes: 5_000 });
    const { frames, dropped } = split([a, big, c], 2_000);
    expect(frames).toEqual([a, c]);
    expect(dropped).toBe(1);
    // Fed in small pieces too, so the limit is hit mid-scan.
    const chunks: Buffer[] = [];
    const all = Buffer.concat([a, big, c]);
    for (let i = 0; i < all.length; i += 300) chunks.push(all.subarray(i, i + 300));
    expect(split(chunks, 2_000).frames).toEqual([a, c]);
  });

  it("CJ5: the standard tables are inserted before SOS only when the frame has none", () => {
    expect(STANDARD_DHT.length).toBe(420); // marker + 418-byte segment
    expect(STANDARD_DHT.readUInt16BE(2)).toBe(418);
    // Per table: class/id, 16 counts, then exactly as many values as the counts add up to.
    let p = 4;
    const tables: Array<[number, number]> = [];
    while (p < STANDARD_DHT.length) {
      const counts = [...STANDARD_DHT.subarray(p + 1, p + 17)].reduce((x, y) => x + y, 0);
      tables.push([STANDARD_DHT[p]!, counts]);
      p += 17 + counts;
    }
    expect(p).toBe(STANDARD_DHT.length);
    expect(tables).toEqual([[0x00, 12], [0x10, 162], [0x01, 12], [0x11, 162]]);

    const fixed = withHuffmanTables(a);
    const sos = a.indexOf(Buffer.from([0xff, 0xda]));
    expect(fixed.length).toBe(a.length + STANDARD_DHT.length);
    expect(fixed.subarray(sos, sos + STANDARD_DHT.length)).toEqual(STANDARD_DHT);
    expect(Buffer.concat([fixed.subarray(0, sos), fixed.subarray(sos + STANDARD_DHT.length)])).toEqual(a);
    expect(withHuffmanTables(b)).toBe(b);
    expect(withHuffmanTables(fixed)).toBe(fixed);
    const broken = Buffer.from([0xff, 0xd8, 0x00, 0x01, 0xff, 0xd9]);
    expect(withHuffmanTables(broken)).toBe(broken);
  });
});

// ---- Capture with a fake ffmpeg ----

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; child: FakeChild }> = [];
  const fn = ((command: string, args: string[]) => {
    const child = new FakeChild();
    calls.push({ command, args, child });
    return child;
  }) as unknown as typeof spawn;
  return { fn, calls };
}

describe("camera capture (src/camera/capture.ts, a fake ffmpeg)", () => {
  const spec = { kind: "camera" as const, device: "/dev/v4l/by-id/usb-cam-video-index0", width: 640, height: 480, fps: 15 };

  it("CC1: copies the camera's MJPEG, keeps only the newest frame with tables added, spawns once", async () => {
    expect(ffmpegArgs(spec).join(" ")).toBe(
      "-hide_banner -loglevel error -nostdin -f v4l2 -input_format mjpeg -video_size 640x480 -framerate 15 -i /dev/v4l/by-id/usb-cam-video-index0 -an -c:v copy -f mjpeg pipe:1",
    );
    expect(ffmpegArgs({ kind: "test_pattern", width: 640, height: 480, fps: 10 }).join(" ")).toContain("-re -f lavfi -i testsrc2=size=640x480:rate=10");
    const clock = new FakeClock();
    const spawned = fakeSpawn();
    const camera = new FfmpegCamera(spec, { clock, log: captureLogger(), spawnChild: spawned.fn });
    expect(camera.source).toBe("camera");
    camera.start();
    camera.start();
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0]!.command).toBe("ffmpeg");
    let woken = 0;
    camera.onFrame(() => (woken += 1));
    spawned.calls[0]!.child.stdout.write(Buffer.concat([jpeg(1), jpeg(2)]));
    await flush();
    expect(woken).toBe(2);
    expect(camera.latest()?.seq).toBe(2);
    expect(camera.latest()?.jpeg).toEqual(withHuffmanTables(jpeg(2)));
  });

  it("CC2: restarts after an exit with a doubling delay, reset by a frame; logs only codes", async () => {
    const clock = new FakeClock();
    const log = captureLogger();
    const spawned = fakeSpawn();
    const camera = new FfmpegCamera(spec, { clock, log, spawnChild: spawned.fn });
    camera.start();
    spawned.calls[0]!.child.exit(1);
    await clock.advance(999);
    expect(spawned.calls).toHaveLength(1);
    await clock.advance(1);
    expect(spawned.calls).toHaveLength(2);
    spawned.calls[1]!.child.exit(1);
    await clock.advance(1_999);
    expect(spawned.calls).toHaveLength(2);
    await clock.advance(1);
    expect(spawned.calls).toHaveLength(3);
    spawned.calls[2]!.child.stdout.write(jpeg(5));
    await flush();
    spawned.calls[2]!.child.exit(null, "SIGSEGV");
    expect(camera.latest()).toBeNull();
    await clock.advance(1_000);
    expect(spawned.calls).toHaveLength(4);
    // A spawn failure ("error", no close) counts the same.
    spawned.calls[3]!.child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    await clock.advance(2_000);
    expect(spawned.calls).toHaveLength(5);
    expect(log.lines.join("\n")).toContain('code="ENOENT"');
    expect(log.lines.join("\n")).not.toMatch(/ffd8|\\xff/i);
  });

  it("CC3: stop sends SIGTERM, then SIGKILL after 2 s, drops the frame and never restarts; an unspawned child is never signalled", async () => {
    const clock = new FakeClock();
    const spawned = fakeSpawn();
    const camera = new FfmpegCamera(spec, { clock, log: captureLogger(), spawnChild: spawned.fn });
    camera.start();
    const child = spawned.calls[0]!.child;
    child.stdout.write(jpeg(1));
    await flush();
    camera.stop();
    expect(camera.latest()).toBeNull();
    expect(child.signals).toEqual(["SIGTERM"]);
    await clock.advance(KILL_AFTER_MS);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    child.exit(null, "SIGKILL");
    await clock.advance(60_000);
    expect(spawned.calls).toHaveLength(1);

    camera.start();
    const failed = spawned.calls[1]!.child;
    failed.pid = undefined;
    camera.stop();
    await clock.advance(KILL_AFTER_MS);
    expect(failed.signals).toEqual([]);
  });

  it("reads WALKER_CAMERA_DEVICE, _SIZE and _FPS", () => {
    expect(readCameraSettings({})).toEqual({ kind: "off" });
    expect(readCameraSettings({ WALKER_CAMERA_DEVICE: "test-pattern" })).toEqual({ kind: "on", spec: { kind: "test_pattern", width: 640, height: 480, fps: 10 } });
    expect(readCameraSettings({ WALKER_CAMERA_DEVICE: "/dev/video0", WALKER_CAMERA_SIZE: "1280x720", WALKER_CAMERA_FPS: "30" })).toEqual({
      kind: "on",
      spec: { kind: "camera", device: "/dev/video0", width: 1280, height: 720, fps: 30 },
    });
    expect(readCameraSettings({ WALKER_CAMERA_DEVICE: "video0" }).kind).toBe("error");
    expect(readCameraSettings({ WALKER_CAMERA_DEVICE: "/dev/video0", WALKER_CAMERA_SIZE: "big" }).kind).toBe("error");
    expect(readCameraSettings({ WALKER_CAMERA_DEVICE: "/dev/video0", WALKER_CAMERA_FPS: "60" }).kind).toBe("error");
  });
});

// ---- The HTTP calls against a real local server ----

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("camera HTTP client (src/cloud/client.ts)", () => {
  it("CL1: the wait and a frame on the contract's routes, with the Bearer credential; 401 is unauthorized", async () => {
    const seen: Array<{ method: string; url: string; auth: string | undefined; type: string | undefined; source: string | undefined; body: Buffer }> = [];
    server = createServer(async (request, response) => {
      const body = await readBody(request);
      seen.push({
        method: request.method!,
        url: request.url!,
        auth: request.headers.authorization,
        type: request.headers["content-type"],
        source: request.headers[CAMERA_SOURCE_HEADER] as string | undefined,
        body,
      });
      if (request.headers.authorization !== "Bearer good") {
        response.writeHead(401, { "content-type": "application/json" });
        return response.end(JSON.stringify({ error: { code: "unauthenticated", message: "no", trace_id: "t" } }));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.method === "GET" ? { wanted: true } : { keep_sending: false }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const device = "11111111-1111-4111-8111-111111111111";
    const cloud = new HttpCameraCloud(url, device, "good");
    const signal = new AbortController().signal;
    expect(await cloud.waitForViewer("test_pattern", signal)).toBe(true);
    const frame = jpeg(7);
    expect(await cloud.sendFrame(frame, "test_pattern", signal)).toBe(false);
    expect(seen[0]).toMatchObject({ method: "GET", url: `/api/v1/devices/${device}/camera?source=test_pattern`, auth: "Bearer good" });
    expect(seen[1]).toMatchObject({ method: "POST", url: `/api/v1/devices/${device}/camera/frames`, auth: "Bearer good", type: "image/jpeg", source: "test_pattern" });
    expect(seen[1]!.body).toEqual(frame);
    await expect(new HttpCameraCloud(url, device, "bad").sendFrame(frame, "camera", signal)).rejects.toMatchObject({ kind: "unauthorized" });
    expect(() => new HttpCameraCloud("http://example.com", device, "good")).toThrow(/https/);
  });
});

// ---- The link loop, with a fake camera and a fake cloud ----

class FakeCamera implements FrameSource {
  readonly source: CameraSource = "test_pattern";
  running = false;
  starts = 0;
  private frame: CameraFrame | null = null;
  private seq = 0;
  private readonly listeners = new Set<() => void>();
  start() {
    if (!this.running) this.starts += 1;
    this.running = true;
  }
  stop() {
    this.running = false;
    this.frame = null;
  }
  latest() {
    return this.frame;
  }
  onFrame(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** A new frame from the camera (only while running, as the real one). */
  emit() {
    if (!this.running) return;
    this.seq += 1;
    this.frame = { seq: this.seq, jpeg: Buffer.from([this.seq]), at: 0 };
    for (const fn of [...this.listeners]) fn();
  }
}

type Pending<T> = { resolve: (value: T) => void; reject: (error: unknown) => void; signal: AbortSignal };

class FakeCameraCloud implements CameraCloud {
  waits: Array<Pending<boolean>> = [];
  frames: Array<Pending<boolean> & { jpeg: Buffer; at: number }> = [];
  constructor(private readonly clock: FakeClock) {}
  waitForViewer(_source: CameraSource, signal: AbortSignal) {
    return new Promise<boolean>((resolve, reject) => this.waits.push({ resolve, reject, signal }));
  }
  sendFrame(jpeg: Buffer, _source: CameraSource, signal: AbortSignal) {
    return new Promise<boolean>((resolve, reject) => this.frames.push({ resolve, reject, signal, jpeg, at: this.clock.monotonic() }));
  }
  lastWait() {
    return this.waits[this.waits.length - 1]!;
  }
  lastFrame() {
    return this.frames[this.frames.length - 1]!;
  }
}

function linkHarness(options: { credential?: CredentialFile | null } = {}) {
  const clock = new FakeClock();
  const log = captureLogger();
  const camera = new FakeCamera();
  const cloud = new FakeCameraCloud(clock);
  let credential: CredentialFile | null = options.credential === undefined ? { server_url: "https://sophi.example", device_id: "d", credential: "one" } : options.credential;
  const made: string[] = [];
  const link = new CameraLink({
    clock,
    log,
    camera,
    credential: () => credential,
    makeCloud: (c) => {
      made.push(c.credential);
      return cloud;
    },
  });
  return { clock, log, camera, cloud, link, made, setCredential: (c: CredentialFile | null) => (credential = c) };
}

describe("camera link (src/camera/link.ts)", () => {
  it("CL2: wanted false is asked again; the camera never starts", async () => {
    const h = linkHarness();
    h.link.start();
    await flush();
    expect(h.cloud.waits).toHaveLength(1);
    await h.clock.advance(1_500);
    h.cloud.lastWait().resolve(false);
    await flush();
    expect(h.cloud.waits).toHaveLength(2);
    expect(h.camera.starts).toBe(0);
    await h.link.stop();
  });

  it("CL3 + CL4: wanted starts the camera; each new frame posted once, one at a time, at most 10 a second; keep_sending false stops it", async () => {
    const h = linkHarness();
    h.link.start();
    await flush();
    h.cloud.lastWait().resolve(true);
    await flush();
    expect(h.camera.running).toBe(true);
    h.camera.emit();
    await flush();
    expect(h.cloud.frames).toHaveLength(1);
    // Frames arriving while one is in flight: not posted until it answers, then only the newest.
    h.camera.emit();
    h.camera.emit();
    await flush();
    expect(h.cloud.frames).toHaveLength(1);
    await h.clock.advance(30);
    h.cloud.lastFrame().resolve(true);
    await flush();
    // 30 ms after the first post: waits until 100 ms.
    expect(h.cloud.frames).toHaveLength(1);
    await h.clock.advance(70);
    expect(h.cloud.frames).toHaveLength(2);
    expect(h.cloud.lastFrame().jpeg).toEqual(Buffer.from([3]));
    expect(h.cloud.frames[1]!.at - h.cloud.frames[0]!.at).toBeGreaterThanOrEqual(FRAME_INTERVAL_MS);
    // No new frame: nothing is posted again.
    h.cloud.lastFrame().resolve(true);
    await h.clock.advance(1_000);
    expect(h.cloud.frames).toHaveLength(2);
    h.camera.emit();
    await flush();
    expect(h.cloud.frames).toHaveLength(3);
    h.cloud.lastFrame().resolve(false);
    await flush();
    expect(h.camera.running).toBe(false);
    expect(h.cloud.waits).toHaveLength(2);
    await h.link.stop();
  });

  it("CL10: a camera that gives no frame for 5 s is stopped and the link waits again", async () => {
    const h = linkHarness();
    h.link.start();
    await flush();
    h.cloud.lastWait().resolve(true);
    await flush();
    await h.clock.advance(NO_FRAME_MS);
    expect(h.camera.running).toBe(false);
    expect(h.cloud.waits).toHaveLength(2);
    await h.link.stop();
  });

  it("CL5: a 401 stops the camera and the credential; a new credential starts again", async () => {
    const h = linkHarness();
    h.link.start();
    await flush();
    h.cloud.lastWait().resolve(true);
    await flush();
    h.camera.emit();
    await flush();
    h.cloud.lastFrame().reject(new CloudError("unauthorized", "no", 401));
    await flush();
    expect(h.camera.running).toBe(false);
    await h.clock.advance(CREDENTIAL_RECHECK_MS * 4);
    expect(h.cloud.waits).toHaveLength(1);
    h.setCredential({ server_url: "https://sophi.example", device_id: "d", credential: "two" });
    await h.clock.advance(CREDENTIAL_RECHECK_MS);
    expect(h.cloud.waits).toHaveLength(2);
    expect(h.made).toEqual(["one", "two"]);
    // A 401 on the wait too.
    h.cloud.lastWait().reject(new CloudError("unauthorized", "no", 401));
    await h.clock.advance(CREDENTIAL_RECHECK_MS * 3);
    expect(h.cloud.waits).toHaveLength(2);
    expect(h.log.lines.join("\n")).not.toMatch(/"one"|"two"|=one|=two/);
    await h.link.stop();
  });

  it("CL6: a failed wait is retried after 2 s, doubling to 30 s, reset by a good answer", async () => {
    const h = linkHarness();
    h.link.start();
    await flush();
    const gaps: number[] = [];
    let last = h.clock.monotonic();
    for (let i = 0; i < 6; i += 1) {
      h.cloud.lastWait().reject(new CloudError("server_error", "500", 500));
      const before = h.cloud.waits.length;
      while (h.cloud.waits.length === before) await h.clock.advance(100);
      gaps.push(h.clock.monotonic() - last);
      last = h.clock.monotonic();
    }
    expect(gaps).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    h.cloud.lastWait().resolve(false);
    await flush();
    await h.clock.advance(1_000);
    h.cloud.lastWait().reject(new CloudError("unreachable", "down"));
    await h.clock.advance(WAIT_RETRY_MIN_MS);
    expect(h.cloud.waits.length).toBe(9);
    await h.link.stop();
  });

  it("CL7: failing frame posts are retried every 0.5 s, and after 10 s the camera stops and the link waits again", async () => {
    const h = linkHarness();
    h.link.start();
    await flush();
    h.cloud.lastWait().resolve(true);
    await flush();
    h.camera.emit();
    await flush();
    const waitsBefore = h.cloud.waits.length;
    let posts = 0;
    while (h.camera.running && posts < 100) {
      const pending = h.cloud.lastFrame();
      pending.reject(new CloudError("unreachable", "down"));
      posts += 1;
      await h.clock.advance(500);
    }
    expect(h.camera.running).toBe(false);
    // Retries every 0.5 s within the 10 s window (one post, then 20 retries).
    expect(posts).toBe(FAILING_MAX_MS / 500 + 1);
    expect(h.cloud.waits.length).toBe(waitsBefore + 1);
    await h.link.stop();
  });

  it("CL8: with no credential nothing is sent; checked again every 5 s", async () => {
    const h = linkHarness({ credential: null });
    h.link.start();
    await h.clock.advance(CREDENTIAL_RECHECK_MS * 3);
    expect(h.cloud.waits).toHaveLength(0);
    h.setCredential({ server_url: "https://sophi.example", device_id: "d", credential: "one" });
    await h.clock.advance(CREDENTIAL_RECHECK_MS);
    expect(h.cloud.waits).toHaveLength(1);
    await h.link.stop();
  });

  it("CL9: stop aborts the open request and closes the camera; nothing is sent afterwards", async () => {
    const h = linkHarness();
    h.link.start();
    await flush();
    h.cloud.lastWait().resolve(true);
    await flush();
    h.camera.emit();
    await flush();
    const inFlight = h.cloud.lastFrame();
    const stopped = h.link.stop();
    expect(inFlight.signal.aborted).toBe(true);
    await stopped;
    expect(h.camera.running).toBe(false);
    await h.clock.advance(60_000);
    expect(h.cloud.frames).toHaveLength(1);
    expect(h.cloud.waits).toHaveLength(1);
  });
});
