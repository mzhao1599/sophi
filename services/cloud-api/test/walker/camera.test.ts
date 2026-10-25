import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAMERA_BOUNDARY,
  CAMERA_FRAME_MAX_BYTES,
  CAMERA_LINK_FRESH_MS,
  CAMERA_WATCH_MAX_MS,
  CIRCLE_ERROR_STATUS,
  type CameraSource,
  type CircleErrorCode,
  type WalkerErrorCode,
} from "@walker/contracts";
import { CAMERA_RECHECK_MS, CameraRelay, CameraService, CircleService, MemoryWalkerStore, WalkerService, isCircleError, isWalkerError, type MemberCaller, type OwnerCaller } from "../../src";
import { manifest, snapshot, type Clock } from "./support";

/**
 * The live camera's relay (camera.ts), against the in-memory store with fake timers and a fake Date.
 * Expected, written before the run:
 * - nothing is shared until her own phone turns sharing on; only her phone can change it; a caretaker still
 *   waiting for approval, an unknown cookie and her own phone (for watching) are refused;
 * - the walker's wait answers `wanted: false` after its time with nobody watching, and `true` at once when a
 *   caretaker starts watching; while its wait is fresh the phones see `walker_camera` and the source;
 * - a frame is kept only while someone watches; each newer frame goes out once as a multipart part with its
 *   seq, source and age; a non-JPEG or oversized body is never kept;
 * - her phone sees who is watching; the watch ends when sharing turns off, when the caretaker or her phone is
 *   removed (within CAMERA_RECHECK_MS), after CAMERA_WATCH_MAX_MS, or when the phone hangs up, and then
 *   the walker is told to stop and no frame is held;
 * - the log has one line per sharing change and per watch, with no frame bytes.
 */

const owner = (secret: string | undefined): OwnerCaller => ({ kind: "owner", secret });
const phone = (secret: string | undefined): MemberCaller => ({ kind: "member", secret });
const device = (credential: string | undefined) => ({ kind: "device" as const, credential });

/** A clock that follows the fake Date, for the shared fixtures. */
const clock = {
  get t() {
    return Date.now();
  },
  now: () => new Date(),
  advance() {},
  iso: (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString(),
} as unknown as Clock;

/** A small but real-looking JPEG: SOI, some bytes, EOI. */
function jpeg(fill: number, size = 2_000): Uint8Array {
  const b = new Uint8Array(size).fill(fill);
  b.set([0xff, 0xd8], 0);
  b.set([0xff, 0xd9], size - 2);
  return b;
}

async function rejects(promise: Promise<unknown>, code: CircleErrorCode) {
  try {
    await promise;
  } catch (error) {
    if (!isCircleError(error)) throw error;
    expect(error.code).toBe(code);
    expect(error.status).toBe(CIRCLE_ERROR_STATUS[code]);
    return;
  }
  throw new Error(`Expected ${code}, but it succeeded.`);
}

async function rejectsWalker(promise: Promise<unknown>, code: WalkerErrorCode) {
  try {
    await promise;
  } catch (error) {
    if (!isWalkerError(error)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}, but it succeeded.`);
}

/** Reads multipart parts off the watch's stream. */
function partReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let first = true;
  return {
    async next(): Promise<{ headers: Record<string, string>; body: Uint8Array } | null> {
      let { done, value } = await reader.read();
      if (done) return null;
      // The stream opens with a CRLF preamble so its headers go out before the first frame.
      if (first) {
        first = false;
        expect([...value!]).toEqual([0x0d, 0x0a]);
        ({ done, value } = await reader.read());
        if (done) return null;
      }
      value = value!;
      const text = new TextDecoder("latin1").decode(value);
      const end = text.indexOf("\r\n\r\n");
      const lines = text.slice(0, end).split("\r\n");
      expect(lines[0]).toBe(`--${CAMERA_BOUNDARY}`);
      const headers = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      const body = value.slice(end + 4, end + 4 + Number(headers["content-length"]));
      expect([...value.slice(-2)]).toEqual([0x0d, 0x0a]);
      return { headers, body };
    },
    cancel: () => reader.cancel(),
  };
}

describe("live camera relay", () => {
  let store: MemoryWalkerStore;
  let walkers: WalkerService;
  let circle: CircleService;
  let relay: CameraRelay;
  let camera: CameraService;
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-24T18:00:00.000Z"), toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    store = new MemoryWalkerStore();
    walkers = new WalkerService(store, { now: () => new Date() });
    circle = new CircleService(store, { now: () => new Date() });
    relay = new CameraRelay();
    camera = new CameraService(store, relay, { resolveDevice: (c, id) => walkers.resolve(c, id) });
    logs = [];
    vi.spyOn(console, "info").mockImplementation((line: string) => void logs.push(line));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function pairWalker(address = "203.0.113.10") {
    const { secret, response } = await walkers.createPairingCode(owner(undefined));
    const paired = await walkers.pair({ code: response.code, service_version: "pi-0.1.0", name: "Rose's walker" }, address);
    const w = { secret, deviceId: paired.device_id, credential: paired.credential };
    await heartbeat(w);
    return w;
  }

  async function heartbeat(w: { deviceId: string; credential: string }) {
    await walkers.heartbeat(device(w.credential), w.deviceId, {
      sent_at: clock.iso(-15),
      service_version: "pi-0.1.0",
      manifest: manifest(clock),
      snapshot: snapshot(clock),
      events: [],
    });
  }

  async function addAndJoin(w: { secret: string; deviceId: string }, role: "walker_user" | "caregiver", who: string) {
    const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: who, role });
    const joined = await circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, "198.51.100.7");
    return joined.secret;
  }

  async function memberId(secret: string) {
    const home = await circle.home(phone(secret));
    if (home.membership !== "member") throw new Error("not a member");
    return home.me.member_id;
  }

  /** Her phone and an approved caretaker. */
  async function twoPhones() {
    const w = await pairWalker();
    const rose = await addAndJoin(w, "walker_user", "Rose");
    const maya = await addAndJoin(w, "caregiver", "Maya");
    const waiting = await circle.ownerCircle(owner(w.secret), w.deviceId);
    await circle.approveJoin(owner(w.secret), w.deviceId, waiting.joins[0]!.member_id, { consent: { walker_user_agreed: true } });
    return { w, rose, maya };
  }

  const wait = (w: { deviceId: string; credential: string }, source: CameraSource = "camera", signal = new AbortController().signal) =>
    camera.deviceWait(device(w.credential), w.deviceId, source, signal);
  const send = (w: { deviceId: string; credential: string }, bytes: Uint8Array, source: CameraSource = "camera") =>
    camera.deviceFrame(device(w.credential), w.deviceId, bytes, source);

  it("shares nothing until her own phone turns it on, and only her phone can", async () => {
    const { rose, maya } = await twoPhones();
    expect(await camera.status(phone(rose))).toEqual({ sharing: false, can_change: true, can_watch: false, walker_camera: false, source: null, watching: [] });
    expect(await camera.status(phone(maya))).toEqual({ sharing: false, can_change: false, can_watch: false, walker_camera: false, source: null, watching: [] });
    await rejects(camera.setSharing(phone(maya), { enabled: true, consent: true }), "not_allowed");
    await rejects(camera.watch(phone(maya), new AbortController().signal), "not_allowed");
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    expect((await camera.status(phone(maya))).can_watch).toBe(true);
    await rejects(camera.watch(phone(rose), new AbortController().signal), "not_allowed");
  });

  it("refuses an unknown cookie and a caretaker still waiting for approval", async () => {
    const w = await pairWalker();
    const rose = await addAndJoin(w, "walker_user", "Rose");
    const waitingMaya = await addAndJoin(w, "caregiver", "Maya");
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    await rejects(camera.status(phone(undefined)), "unauthenticated");
    await rejects(camera.status(phone("A".repeat(43))), "unauthenticated");
    await rejects(camera.status(phone(waitingMaya)), "not_allowed");
    await rejects(camera.watch(phone(waitingMaya), new AbortController().signal), "not_allowed");
  });

  it("checks the walker's credential and its own id, as every device route", async () => {
    const w = await pairWalker();
    const other = await pairWalker("203.0.113.11");
    await rejectsWalker(camera.deviceWait(device(undefined), w.deviceId, "camera", new AbortController().signal), "unauthenticated");
    await rejectsWalker(camera.deviceWait(device(other.credential), w.deviceId, "camera", new AbortController().signal), "not_found");
    await rejectsWalker(camera.deviceFrame(device("B".repeat(43)), w.deviceId, jpeg(1), "camera"), "unauthenticated");
  });

  it("answers the walker's wait with false when nobody watches, and shows its camera while the wait is fresh", async () => {
    const { w, rose, maya } = await twoPhones();
    const waiting = wait(w, "test_pattern");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await waiting).toEqual({ wanted: false });
    // The walker heartbeats every 5 s; the status shows a camera only on an online walker.
    await heartbeat(w);
    expect(await camera.status(phone(rose))).toMatchObject({ walker_camera: true, source: "test_pattern" });
    expect(await send(w, jpeg(1))).toEqual({ keep_sending: false });
    await vi.advanceTimersByTimeAsync(CAMERA_LINK_FRESH_MS + 1);
    await heartbeat(w);
    expect(await camera.status(phone(maya))).toMatchObject({ walker_camera: false, source: null });
  });

  it("wakes the walker when a caretaker watches, relays each newer frame once, and shows her who is watching", async () => {
    const { w, rose, maya } = await twoPhones();
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    const waiting = wait(w);
    await vi.advanceTimersByTimeAsync(1_000);
    const parts = partReader(await camera.watch(phone(maya), new AbortController().signal));
    expect(await waiting).toEqual({ wanted: true });
    expect(await camera.status(phone(rose))).toMatchObject({ sharing: true, watching: [{ name: "Maya" }] });

    expect(await send(w, jpeg(7))).toEqual({ keep_sending: true });
    await vi.advanceTimersByTimeAsync(40);
    const first = await parts.next();
    expect(first!.headers).toMatchObject({ "content-type": "image/jpeg", "content-length": "2000", "x-frame-seq": "1", "x-frame-source": "camera", "x-frame-age-ms": "40" });
    expect(first!.body).toEqual(jpeg(7));

    // A body that isn't a whole JPEG, or is over the cap, is never kept or sent.
    expect(await send(w, new Uint8Array([1, 2, 3, 4]))).toEqual({ keep_sending: true });
    expect(await send(w, jpeg(8, CAMERA_FRAME_MAX_BYTES + 1))).toEqual({ keep_sending: true });
    expect(await send(w, jpeg(9), "test_pattern")).toEqual({ keep_sending: true });
    const second = await parts.next();
    expect(second!.headers).toMatchObject({ "x-frame-seq": "2", "x-frame-source": "test_pattern" });
    expect(second!.body).toEqual(jpeg(9));
    await parts.cancel();
  });

  it("ends the watch when she turns sharing off, and tells the walker to stop", async () => {
    const { w, rose, maya } = await twoPhones();
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    const parts = partReader(await camera.watch(phone(maya), new AbortController().signal));
    await send(w, jpeg(3));
    expect(await parts.next()).not.toBeNull();
    await camera.setSharing(phone(rose), { enabled: false });
    expect(await parts.next()).toBeNull();
    expect(await send(w, jpeg(4))).toEqual({ keep_sending: false });
    expect(await camera.status(phone(maya))).toMatchObject({ sharing: false, can_watch: false, watching: [] });
    expect(logs.filter((l) => l.startsWith("[camera]"))).toEqual([
      `[camera] sharing device=${w.deviceId} enabled=true`,
      `[camera] sharing device=${w.deviceId} enabled=false`,
      expect.stringMatching(new RegExp(`^\\[camera\\] watch device=${w.deviceId} frames=1 ms=\\d+ ended=sharing_off$`)),
    ]);
  });

  it("ends the watch within the re-check when the owner removes the caretaker", async () => {
    const { w, rose, maya } = await twoPhones();
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    const parts = partReader(await camera.watch(phone(maya), new AbortController().signal));
    const ended = parts.next();
    await circle.removeMember(owner(w.secret), w.deviceId, await memberIdOfCaretaker(w));
    await vi.advanceTimersByTimeAsync(CAMERA_RECHECK_MS + 10);
    expect(await ended).toBeNull();
    expect(await send(w, jpeg(5))).toEqual({ keep_sending: false });
  });

  it("turns sharing off when her phone leaves the circle", async () => {
    const { w, rose, maya } = await twoPhones();
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    const parts = partReader(await camera.watch(phone(maya), new AbortController().signal));
    const ended = parts.next();
    await circle.removeMember(owner(w.secret), w.deviceId, await memberId(rose));
    await vi.advanceTimersByTimeAsync(CAMERA_RECHECK_MS + 10);
    expect(await ended).toBeNull();
    expect(await camera.status(phone(maya))).toMatchObject({ sharing: false, can_watch: false });
    expect(relay.sharingBy(w.deviceId)).toBeNull();
  });

  it("stops a watch after its time limit, and when the phone hangs up", async () => {
    const { w, rose, maya } = await twoPhones();
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    const parts = partReader(await camera.watch(phone(maya), new AbortController().signal));
    const ended = parts.next();
    await vi.advanceTimersByTimeAsync(CAMERA_WATCH_MAX_MS + 10);
    expect(await ended).toBeNull();
    expect(relay.wanted(w.deviceId)).toBe(false);

    const hangUp = new AbortController();
    const again = partReader(await camera.watch(phone(maya), hangUp.signal));
    expect(relay.wanted(w.deviceId)).toBe(true);
    const next = again.next();
    hangUp.abort();
    expect(await next).toBeNull();
    expect(await send(w, jpeg(6))).toEqual({ keep_sending: false });
    expect(logs.some((l) => /ended=time_limit$/.test(l))).toBe(true);
    expect(logs.some((l) => /ended=phone$/.test(l))).toBe(true);
  });

  it("holds no frame while nobody watches", async () => {
    const { w, rose, maya } = await twoPhones();
    await camera.setSharing(phone(rose), { enabled: true, consent: true });
    expect(await send(w, jpeg(1))).toEqual({ keep_sending: false });
    const parts = partReader(await camera.watch(phone(maya), new AbortController().signal));
    const first = parts.next();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await send(w, jpeg(2))).toEqual({ keep_sending: true });
    // The frame sent before anyone watched never reaches the phone.
    expect((await first)!.body).toEqual(jpeg(2));
    await parts.cancel();
    expect(await send(w, jpeg(3))).toEqual({ keep_sending: false });
  });

  async function memberIdOfCaretaker(w: { secret: string; deviceId: string }) {
    const { members } = await circle.ownerCircle(owner(w.secret), w.deviceId);
    return members.find((m) => m.role === "caregiver")!.member_id;
  }
});
