import {
  CAMERA_BOUNDARY,
  CAMERA_FRAME_MAX_BYTES,
  CAMERA_LINK_FRESH_MS,
  CAMERA_WAIT_MS,
  CAMERA_WATCH_MAX_MS,
  CameraFrameResponseSchema,
  CameraSharingResponseSchema,
  CameraStatusViewSchema,
  MAX_CIRCLE_MEMBERS,
  looksLikeJpeg,
  type CameraFrameResponse,
  type CameraSharingRequest,
  type CameraSource,
  type CameraStatusView,
  type CameraWaitResponse,
} from "@walker/contracts";
import { CircleError, type MemberCaller } from "./circle";
import { isOnline } from "./rules";
import type { DeviceCaller } from "./service";
import { SECRET_PATTERN, sha256, sweepCircleThrottled, type CircleMemberRecord, type DeviceRecord, type WalkerStore } from "./store";

/**
 * The walker's live camera on a caretaker's phone (camera.ts in the contracts). The server is only a relay:
 * the newest frame of each walker, in memory, while someone watches. Nothing here is written to the store
 * or a log; a restart forgets sharing, viewers and frames, so the camera fails closed.
 */

export interface CameraFrame {
  bytes: Uint8Array;
  /** The server's own number for this walker's frames, rising. */
  seq: number;
  source: CameraSource;
  received_at: number;
}

interface Viewer {
  member_id: string;
  name: string;
}

interface Channel {
  /** Her phone's member id while it has sharing on. */
  sharingBy: string | null;
  /** When the walker's camera link last asked or sent, and what it said it sends. */
  linkAt: number | null;
  linkSource: CameraSource | null;
  viewers: Map<symbol, Viewer>;
  frame: CameraFrame | null;
  seq: number;
  /** Woken on every change: a wait, a new frame, a viewer coming or going, sharing. */
  waiters: Set<() => void>;
}

/** How often a watch re-checks that the phone and her sharing are still in the circle. */
export const CAMERA_RECHECK_MS = 5_000;

/** The relay's state, one per server process (sharedCameraRelay); every method is synchronous apart from waits. */
export class CameraRelay {
  private readonly channels = new Map<string, Channel>();

  constructor(private readonly clock: () => number = Date.now) {}

  private channel(deviceId: string): Channel {
    let ch = this.channels.get(deviceId);
    if (!ch) {
      ch = { sharingBy: null, linkAt: null, linkSource: null, viewers: new Map(), frame: null, seq: 0, waiters: new Set() };
      this.channels.set(deviceId, ch);
    }
    return ch;
  }

  private wake(ch: Channel) {
    for (const w of [...ch.waiters]) w();
  }

  /** Resolves on the channel's next change, after `ms`, or when `signal` aborts; never rejects. */
  private changed(ch: Channel, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        ch.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      ch.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  }

  sharingBy(deviceId: string): string | null {
    return this.channels.get(deviceId)?.sharingBy ?? null;
  }

  /** Turning it off drops the frame and ends every watch. */
  setSharing(deviceId: string, memberId: string | null) {
    const ch = this.channel(deviceId);
    ch.sharingBy = memberId;
    if (memberId === null) {
      ch.viewers.clear();
      ch.frame = null;
    }
    this.wake(ch);
  }

  /** The walker should be sending: sharing is on and someone is watching. */
  wanted(deviceId: string): boolean {
    const ch = this.channels.get(deviceId);
    return !!ch && ch.sharingBy !== null && ch.viewers.size > 0;
  }

  /** The walker's camera link, if it asked or sent within CAMERA_LINK_FRESH_MS. */
  link(deviceId: string): CameraSource | null {
    const ch = this.channels.get(deviceId);
    if (!ch || ch.linkAt === null || this.clock() - ch.linkAt > CAMERA_LINK_FRESH_MS) return null;
    return ch.linkSource;
  }

  /** The walker's long wait: true as soon as someone watches, false after `ms` or when the walker hangs up. */
  async waitForViewer(deviceId: string, source: CameraSource, signal: AbortSignal, ms = CAMERA_WAIT_MS): Promise<boolean> {
    const ch = this.channel(deviceId);
    const until = this.clock() + ms;
    ch.linkAt = this.clock();
    ch.linkSource = source;
    this.wake(ch);
    while (!this.wanted(deviceId)) {
      const left = until - this.clock();
      if (left <= 0 || signal.aborted) return false;
      await this.changed(ch, left, signal);
    }
    return true;
  }

  /** Keeps the frame only while it is wanted; the answer is whether to keep sending. */
  putFrame(deviceId: string, bytes: Uint8Array, source: CameraSource): boolean {
    const ch = this.channel(deviceId);
    ch.linkAt = this.clock();
    ch.linkSource = source;
    if (!this.wanted(deviceId)) {
      ch.frame = null;
      return false;
    }
    ch.seq += 1;
    ch.frame = { bytes, seq: ch.seq, source, received_at: this.clock() };
    this.wake(ch);
    return true;
  }

  viewers(deviceId: string): Viewer[] {
    const seen = new Map<string, Viewer>();
    for (const v of this.channels.get(deviceId)?.viewers.values() ?? []) seen.set(v.member_id, v);
    return [...seen.values()];
  }

  /** False when the walker already has as many open watches as it has room for. */
  addViewer(deviceId: string, key: symbol, viewer: Viewer): boolean {
    const ch = this.channel(deviceId);
    if (ch.viewers.size >= MAX_CIRCLE_MEMBERS) return false;
    ch.viewers.set(key, viewer);
    this.wake(ch);
    return true;
  }

  /** The last viewer leaving drops the frame, so nothing is held while nobody watches. */
  removeViewer(deviceId: string, key: symbol) {
    const ch = this.channels.get(deviceId);
    if (!ch) return;
    ch.viewers.delete(key);
    if (ch.viewers.size === 0) ch.frame = null;
    this.wake(ch);
  }

  /** Each newer frame while this viewer is in, until it is removed or `signal` aborts. */
  async *frames(deviceId: string, key: symbol, signal: AbortSignal): AsyncGenerator<CameraFrame> {
    const ch = this.channel(deviceId);
    let last = 0;
    while (!signal.aborted && ch.viewers.has(key)) {
      const frame = ch.frame;
      if (frame && frame.seq > last) {
        last = frame.seq;
        yield frame;
      } else {
        await this.changed(ch, CAMERA_RECHECK_MS, signal);
      }
    }
  }

  now(): number {
    return this.clock();
  }
}

const globalForCamera = globalThis as unknown as { __walkerCamera?: CameraRelay };

/** One relay per server process: the walker's routes write where the phones' routes read. */
export function sharedCameraRelay(): CameraRelay {
  return (globalForCamera.__walkerCamera ??= new CameraRelay());
}

export interface CameraServiceOptions {
  /** The walker's credential check (WalkerService.resolve): WalkerError on failure, as every device route. */
  resolveDevice: (caller: DeviceCaller, deviceId: string) => Promise<DeviceRecord>;
  blocked?: string | null;
  now?: () => Date;
}

/** One line per watch, for the log: who (by role) and how many frames, never a frame. */
function logWatch(deviceId: string, frames: number, ms: number, why: string) {
  console.info(`[camera] watch device=${deviceId} frames=${frames} ms=${ms} ended=${why}`);
}

export class CameraService {
  private readonly resolveDevice: CameraServiceOptions["resolveDevice"];
  private readonly blocked: string | null;
  private readonly now: () => Date;

  constructor(
    private readonly store: WalkerStore,
    private readonly relay: CameraRelay,
    options: CameraServiceOptions,
  ) {
    this.resolveDevice = options.resolveDevice;
    this.blocked = options.blocked ?? null;
    this.now = options.now ?? (() => new Date(relay.now()));
  }

  // ---- The walker ----

  async deviceWait(caller: DeviceCaller, deviceId: string, source: CameraSource, signal: AbortSignal): Promise<CameraWaitResponse> {
    const device = await this.resolveDevice(caller, deviceId);
    return { wanted: await this.relay.waitForViewer(device.device_id, source, signal) };
  }

  /** The frame is checked to be a whole JPEG under the cap by the caller before it gets here. */
  async deviceFrame(caller: DeviceCaller, deviceId: string, bytes: Uint8Array, source: CameraSource): Promise<CameraFrameResponse> {
    const device = await this.resolveDevice(caller, deviceId);
    if (bytes.length > CAMERA_FRAME_MAX_BYTES || !looksLikeJpeg(bytes)) return CameraFrameResponseSchema.parse({ keep_sending: this.relay.wanted(device.device_id) });
    return CameraFrameResponseSchema.parse({ keep_sending: this.relay.putFrame(device.device_id, bytes, source) });
  }

  // ---- The phones ----

  async status(caller: MemberCaller): Promise<CameraStatusView> {
    const member = await this.member(caller);
    const device = await this.store.circleDevice(member.device_id);
    if (!device) throw unauthenticated();
    const sharing = await this.sharingHolds(member.device_id);
    const online = isOnline(device.last_heartbeat_at, this.now());
    const source = online ? this.relay.link(member.device_id) : null;
    return CameraStatusViewSchema.parse({
      sharing,
      can_change: member.role === "walker_user",
      can_watch: member.role === "caregiver" && sharing,
      walker_camera: source !== null,
      source,
      watching: sharing ? this.relay.viewers(member.device_id).map((v) => ({ name: v.name })) : [],
    });
  }

  /** Her own phone alone turns it on (with her consent tap) or off. */
  async setSharing(caller: MemberCaller, request: CameraSharingRequest): Promise<{ enabled: boolean }> {
    const member = await this.member(caller);
    if (member.role !== "walker_user") throw new CircleError("not_allowed", "Only her own phone can change camera sharing.");
    this.relay.setSharing(member.device_id, request.enabled ? member.member_id : null);
    console.info(`[camera] sharing device=${member.device_id} enabled=${request.enabled}`);
    return CameraSharingResponseSchema.parse({ enabled: request.enabled });
  }

  /**
   * A caretaker's watch, as the multipart body of GET /api/v1/circle/camera/live. Refused before it starts
   * unless this is an approved caretaker and her sharing is on; ends on `signal`, when sharing turns off or
   * either phone leaves (re-checked every CAMERA_RECHECK_MS), and after CAMERA_WATCH_MAX_MS.
   */
  async watch(caller: MemberCaller, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const member = await this.member(caller);
    if (member.role !== "caregiver") throw new CircleError("not_allowed", "Only a caretaker's phone watches the camera.");
    if (!(await this.sharingHolds(member.device_id))) throw new CircleError("not_allowed", "Camera sharing is off on her phone.");
    const deviceId = member.device_id;
    const key = Symbol("viewer");
    if (!this.relay.addViewer(deviceId, key, { member_id: member.member_id, name: member.name })) {
      throw new CircleError("rate_limited", "Too many phones are watching this walker. Try again in a moment.");
    }
    const stop = new AbortController();
    let why = "phone";
    const end = (reason: string) => {
      if (stop.signal.aborted) return;
      why = reason;
      stop.abort();
    };
    signal.addEventListener("abort", () => end("phone"), { once: true });
    const cap = setTimeout(() => end("time_limit"), CAMERA_WATCH_MAX_MS);
    const recheck = setInterval(() => {
      void this.stillAllowed(member).then((ok) => ok || end("not_allowed"), () => end("error"));
    }, CAMERA_RECHECK_MS);
    const started = this.relay.now();
    let count = 0;
    const encoder = new TextEncoder();
    const frames = this.relay.frames(deviceId, key, stop.signal);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(cap);
      clearInterval(recheck);
      this.relay.removeViewer(deviceId, key);
      if (!stop.signal.aborted) end(this.relay.sharingBy(deviceId) === null ? "sharing_off" : "ended");
      logWatch(deviceId, count, Math.round(this.relay.now() - started), why);
    };
    return new ReadableStream<Uint8Array>({
      // A preamble before the first boundary (allowed in multipart, ignored by readers), so the response
      // and its headers go out now instead of waiting for the walker's first frame.
      start: (controller) => controller.enqueue(encoder.encode("\r\n")),
      pull: async (controller) => {
        try {
          const next = await frames.next();
          if (next.done) {
            finish();
            controller.close();
            return;
          }
          count += 1;
          controller.enqueue(cameraPart(next.value, Math.max(0, this.relay.now() - next.value.received_at), encoder));
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      cancel: () => {
        end("phone");
        void frames.return(undefined);
        finish();
      },
    });
  }

  /** Sharing counts only while the phone that turned it on is still her phone in the circle. */
  private async sharingHolds(deviceId: string): Promise<boolean> {
    const by = this.relay.sharingBy(deviceId);
    if (by === null) return false;
    const { members } = await this.store.circleOf(deviceId, this.now());
    if (members.some((m) => m.member_id === by && m.role === "walker_user" && m.state === "member")) return true;
    this.relay.setSharing(deviceId, null);
    return false;
  }

  private async stillAllowed(viewer: CircleMemberRecord): Promise<boolean> {
    const { members } = await this.store.circleOf(viewer.device_id, this.now());
    if (!members.some((m) => m.member_id === viewer.member_id && m.state === "member")) return false;
    return this.sharingHolds(viewer.device_id);
  }

  /** An approved phone; a caretaker still waiting for the owner can do nothing here. */
  private async member(caller: MemberCaller): Promise<CircleMemberRecord> {
    if (this.blocked) throw new CircleError("unavailable", this.blocked);
    await this.store.ready();
    if (!caller.secret || !SECRET_PATTERN.test(caller.secret)) throw unauthenticated();
    const member = await this.store.memberBySecret(sha256(caller.secret));
    if (!member) throw unauthenticated();
    await sweepCircleThrottled(this.store, this.now());
    if (member.state !== "member") throw new CircleError("not_allowed", "The owner hasn't let this phone in yet.");
    return member;
  }
}

/** One multipart part (CAMERA_BOUNDARY in the contract): headers, the JPEG, CRLF. */
export function cameraPart(frame: CameraFrame, ageMs: number, encoder = new TextEncoder()): Uint8Array {
  const head = encoder.encode(
    `--${CAMERA_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.bytes.length}\r\nX-Frame-Seq: ${frame.seq}\r\nX-Frame-Source: ${frame.source}\r\nX-Frame-Age-Ms: ${Math.round(ageMs)}\r\n\r\n`,
  );
  const part = new Uint8Array(head.length + frame.bytes.length + 2);
  part.set(head, 0);
  part.set(frame.bytes, head.length);
  part.set([0x0d, 0x0a], head.length + frame.bytes.length);
  return part;
}

function unauthenticated() {
  return new CircleError("unauthenticated", "This phone isn't in a walker's circle. Ask the owner for a code.");
}
