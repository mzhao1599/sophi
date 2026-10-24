import { randomUUID } from "node:crypto";
import {
  SERIAL_PROTOCOL_VERSION,
  type CapabilityManifest,
  type HeartbeatRequest,
  type ProposalView,
  type SensorSnapshot,
  type WalkerConfiguration,
} from "@walker/contracts";
import type { AudioCapture, CaptureSession, Clip } from "./audio/capture";
import type { Speaker, Utterance } from "./audio/speech";
import { readWav } from "./audio/wav";
import type { Bus, ButtonEvent, ButtonSourceKind, CueName, LinkState, SpeechKind, TalkState } from "./bus";
import { CancelledError, DeadlineError, withDeadline, type Cancel, type Clock } from "./clock";
import { CloudError, type CloudClient, type CloudErrorKind } from "./cloud/client";
import {
  CLIP_MAX_MS,
  CLIP_MIN_MS,
  CONFIRM_PRESS_HAPTIC_MS,
  HEARTBEAT_BACKOFF_MS,
  HEARTBEAT_DEADLINE_MS,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_LINE_REPEAT_MS,
  OFFLINE_AFTER_FAILED_HEARTBEATS,
  SPEECH_LINE_MAX_MS,
  TALK_PRESS_HAPTIC_MS,
  TURN_DEADLINE_MS,
  ZONE_VALIDITY_MS,
} from "./constants";
import { CuePolicy } from "./cues";
import type { Logger } from "./log";
import { LINES, appliedLine, moduleDownLine, offlineLine } from "./notices";
import type { ModuleManager } from "./serial/modules";
import type { CredentialFile, StateStore } from "./store";
import { SERVICE_VERSION } from "./version";

export interface ServiceDeps {
  clock: Clock;
  log: Logger;
  bus: Bus;
  store: StateStore;
  modules: ModuleManager;
  capture: AudioCapture;
  speaker: Speaker;
  makeCloud: (credential: CredentialFile) => CloudClient;
  /** True when the whole walker runs on a laptop (`walker simulate`). */
  simulator: boolean;
  /** The Pi's own USB microphone and speaker, reported as the `voice` part. */
  audioInstanceId: string;
  /** The coordinator itself (the Pi, or the Mac under `walker simulate`), reported as the `base.walker` part. */
  coordinatorInstanceId: string;
  /** The Pi's own GPIO Talk and Confirm buttons, only when the installer declared them wired (never in the simulator). */
  gpioButtons?: { readonly instanceId: string; status(): { health: "ok" | "unavailable"; faults: string[] } };
  newId?: () => string;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** How many unheard turns (cancelled, timed out, failed) the Pi remembers, to decline a proposal one opened. */
const UNHEARD_TURNS_KEPT = 20;

export function classifyError(error: unknown): CloudErrorKind {
  if (error instanceof CloudError) return error.kind;
  if (error instanceof DeadlineError) return "timeout";
  if (error instanceof CancelledError) return "cancelled";
  return "server_error";
}

interface VoiceItem {
  text: string;
  /** The reply already voiced by the server (Cartesia); the walker's own voice says `text` if it can't play. */
  wav?: Buffer;
  cancelled: boolean;
  resolve: () => void;
}

/** Plays spoken lines one after another; `stopAll` silences the current one and drops the rest. */
class VoiceQueue {
  private queue: VoiceItem[] = [];
  private current: { item: VoiceItem; utterance: Utterance } | null = null;
  private running = false;

  constructor(
    private readonly speaker: Speaker,
    private readonly clock: Clock,
    private readonly onError: (error: Error) => void,
  ) {}

  say(text: string, wav?: Buffer): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ text, wav, cancelled: false, resolve });
      if (!this.running) void this.drain();
    });
  }

  stopAll(): void {
    for (const item of this.queue.splice(0)) {
      item.cancelled = true;
      item.resolve();
    }
    if (this.current) {
      this.current.item.cancelled = true;
      this.current.utterance.stop();
    }
  }

  /** One loop plays everything, so two lines can never play at once. */
  private async drain(): Promise<void> {
    this.running = true;
    try {
      for (let item = this.queue.shift(); item; item = this.queue.shift()) {
        const { text, wav } = item;
        const played = await this.play(item, () => (wav ? this.speaker.playWav(wav) : this.speaker.speak(text)));
        if (!played && wav) await this.play(item, () => this.speaker.speak(text));
        item.resolve();
      }
    } finally {
      this.running = false;
    }
  }

  private async play(item: VoiceItem, start: () => Utterance): Promise<boolean> {
    if (item.cancelled) return true;
    let cancelLimit: Cancel = () => {};
    try {
      const utterance = start();
      this.current = { item, utterance };
      // A player that never finishes must not hold every later line: stop it and move on.
      const limit = new Promise<void>((resolve) => {
        cancelLimit = this.clock.setTimeout(() => {
          utterance.stop();
          this.onError(new Error(`a spoken line was still playing after ${SPEECH_LINE_MAX_MS} ms`));
          resolve();
        }, SPEECH_LINE_MAX_MS);
      });
      await Promise.race([utterance.done, limit]);
      return true;
    } catch (error) {
      this.onError(error as Error);
      return false;
    } finally {
      cancelLimit();
      this.current = null;
    }
  }
}

interface Recording {
  session: CaptureSession | null;
  openedAt: number;
  cancelMax: Cancel | null;
  /** Which button started it, so a lost release (unplug, reboot, gpiomon exit) can discard it. */
  source: ButtonSourceKind;
  detail: string | undefined;
}

/** Placeholder, not measured: the mic opens after the listening cue, or after this long if the player hangs. */
const LISTENING_CUE_MAX_MS = 1000;

interface PendingTurn {
  abort: AbortController;
  /** Set once the request is built; a cancelled turn's proposal is declined by it. */
  clientTurnId: string | null;
}

/**
 * The always-on walker service. It handles the two buttons, the microphone and speaker, the serial modules'
 * cues and the cloud link, and keeps working offline: buttons, obstacle cues and fixed local lines need no
 * network. Nothing records until a Talk press, the model never speaks unprompted, and every line the Pi says
 * on its own also goes to the walker page (as a heartbeat event).
 *
 * Talk (the design's button map): hold to talk, release to send; a press while waiting cancels; a press while
 * a reply is playing stops it and starts listening. The simulator keyboard only presses, so a second press
 * sends. Confirm answers the open proposal by id; with none it plays the "nothing to confirm" sound. The Pi
 * never judges a proposal's expiry by its own clock: the server says whether it is still open.
 */
export class WalkerService {
  talk: TalkState = "idle";
  link: LinkState = "unpaired";
  configuration: WalkerConfiguration | null = null;
  openProposal: ProposalView | null = null;

  private credential: CredentialFile | null = null;
  private cloud: CloudClient | null = null;
  private failures = 0;
  private recording: Recording | null = null;
  private turn: PendingTurn | null = null;
  private readonly unheardTurns: string[] = [];
  /** Bumped whenever a turn, Confirm, cancel or link change learns something newer about the open proposal. */
  private proposalEpoch = 0;
  private readonly declining = new Set<string>();
  private confirmInFlight = false;
  private heartbeatInFlight = false;
  /** A part changed while a heartbeat was in flight: send the next one right after it. */
  private reportAfterFlight = false;
  /** The last local line sent to the page, to skip an identical one said again moments later. */
  private lastRecorded: { text: string; mono: number } | null = null;
  private cancelHeartbeat: Cancel | null = null;
  private stopped = false;
  private readonly audioFaults = new Set<string>();
  private readonly voice: VoiceQueue;
  private readonly cues: CuePolicy;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly newId: () => string;

  constructor(private readonly deps: ServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.voice = new VoiceQueue(deps.speaker, deps.clock, (error) => this.audioFault("playback_failed", error));
    this.cues = new CuePolicy({
      clock: deps.clock,
      log: deps.log,
      modules: deps.modules,
      playObstacleSound: () => this.cue("obstacle"),
      cues: () => this.configuration?.cues ?? null,
    });
  }

  start(): void {
    const { bus, store } = this.deps;
    this.configuration = store.readConfiguration();
    this.unsubscribe.push(
      bus.on("button", (event) => this.onButton(event)),
      bus.on("zones", ({ zones }) => this.cues.evaluate(zones)),
      bus.on("moduleDown", ({ module }) => void this.say(moduleDownLine(module), "notice")),
      bus.on("buttonsLost", (lost) => this.buttonsLost(lost)),
    );
    void this.say(LINES.boot, "notice");
    this.refreshCredential();
    this.scheduleHeartbeat(0);
  }

  stop(): void {
    this.stopped = true;
    this.cancelHeartbeat?.();
    this.recording?.session?.abort();
    this.recording?.cancelMax?.();
    this.recording = null;
    this.turn?.abort.abort(new CancelledError("Service stopped."));
    this.voice.stopAll();
    for (const off of this.unsubscribe) off();
  }

  // ---- Buttons ----

  private onButton(event: ButtonEvent): void {
    if (this.stopped) return;
    if (event.button === "talk") {
      if (event.edge === "pressed") {
        this.talkPressed(event);
        // After the press is handled, so the buzz never delays the listening sound or the mic.
        this.pressBuzz(event, "recording");
      } else if (this.talk === "recording") void this.finishRecording();
    } else if (event.edge === "pressed") {
      void this.confirmPressed(event);
    }
  }

  /**
   * Button feedback: a short buzz on the hand module that reported the press, so a click is felt, as well as
   * the sounds. It plays whatever the configuration's `cues` say, because that list chooses obstacle alerts,
   * not button feedback, and it is not an obstacle alert: the cue policy never sees it. Only an ESP32 hand
   * press buzzes (the Pi's GPIO buttons and the simulator keyboard have no motor). A hand that can't buzz
   * (see `canBuzz`) is skipped silently by `sendHaptic`, a busy port drops it, and it never throws.
   */
  private pressBuzz(event: ButtonEvent, pattern: "recording" | "confirmation" | "error"): void {
    if (this.stopped || event.source !== "esp32" || !event.detail) return;
    try {
      this.deps.modules.sendHaptic(event.detail, pattern, pattern === "recording" ? TALK_PRESS_HAPTIC_MS : CONFIRM_PRESS_HAPTIC_MS);
    } catch (error) {
      this.deps.log.warn("press buzz failed", { module: event.detail, pattern, error: (error as Error).message });
    }
  }

  private talkPressed(event: ButtonEvent): void {
    if (this.talk === "recording") {
      void this.finishRecording();
      return;
    }
    if (this.talk === "waiting") {
      this.cancelTurn();
      return;
    }
    this.voice.stopAll();
    const blocked = this.localLine();
    if (blocked) {
      void this.say(blocked, "local_reply");
      if (this.link === "offline" || this.link === "connecting") this.scheduleHeartbeat(0);
      return;
    }
    void this.startRecording(event);
  }

  /** The fixed line for a Talk press when the walker can't reach the assistant, or null when it can. */
  private localLine(): string | null {
    switch (this.link) {
      case "online":
        return null;
      case "unpaired":
        return LINES.notPaired;
      case "unauthorized":
        return LINES.pairAgain;
      case "connecting":
        return LINES.connecting;
      case "offline":
        return offlineLine(this.configuration?.cues ?? null, this.deps.modules.modules());
    }
  }

  private async startRecording(event: ButtonEvent): Promise<void> {
    this.lastRecorded = null; // something happened: the next local line is news, even if it's the same words
    const recording: Recording = { session: null, openedAt: 0, cancelMax: null, source: event.source, detail: event.detail };
    this.recording = recording;
    this.setTalk("recording");
    let cancelWait: Cancel = () => {};
    await Promise.race([
      this.playCue("listening"),
      new Promise<void>((resolve) => (cancelWait = this.deps.clock.setTimeout(resolve, LISTENING_CUE_MAX_MS))),
    ]);
    cancelWait();
    if (this.recording !== recording) return;
    try {
      recording.session = this.deps.capture.start();
    } catch (error) {
      this.recording = null;
      this.setTalk("idle");
      this.audioFault("capture_failed", error as Error);
      void this.say(LINES.micTrouble, "local_reply");
      return;
    }
    recording.openedAt = this.deps.clock.monotonic();
    this.deps.log.info("mic open", { mic: this.deps.capture.label.slice(0, 80) });
    this.deps.bus.emit("mic", { state: "open" });
    recording.cancelMax = this.deps.clock.setTimeout(() => void this.finishRecording(), CLIP_MAX_MS);
  }

  /**
   * The button that started a recording can no longer report its release (its hand module went away or
   * rebooted, or gpiomon exited). Sending would record up to 15 s nobody meant to send, so the clip is dropped.
   */
  private buttonsLost(lost: { source: ButtonSourceKind; detail?: string }): void {
    const recording = this.recording;
    if (!recording || this.talk !== "recording" || recording.source !== lost.source) return;
    if (lost.source === "esp32" && recording.detail !== lost.detail) return;
    this.recording = null;
    recording.cancelMax?.();
    recording.session?.abort();
    this.setTalk("idle");
    this.deps.bus.emit("turn", { outcome: "discarded" });
    void this.say(LINES.stoppedListening, "local_reply");
  }

  private async finishRecording(): Promise<void> {
    const recording = this.recording;
    if (!recording || this.talk !== "recording") return;
    this.recording = null;
    recording.cancelMax?.();
    const heldMs = this.deps.clock.monotonic() - recording.openedAt;
    if (!recording.session || heldMs < CLIP_MIN_MS) {
      this.deps.log.info("press too short", { held_ms: recording.session ? Math.round(heldMs) : null });
      recording.session?.abort();
      this.setTalk("idle");
      this.deps.bus.emit("turn", { outcome: "too_short" });
      void this.say(LINES.tooShort, "local_reply");
      return;
    }
    const turn: PendingTurn = { abort: new AbortController(), clientTurnId: null };
    this.turn = turn;
    this.setTalk("waiting");
    let clip: Clip;
    try {
      clip = await recording.session.stop();
      this.audioFaults.delete("capture_failed");
    } catch (error) {
      this.audioFault("capture_failed", error as Error);
      if (this.turn === turn) {
        this.endTurn(turn);
        void this.say(LINES.micTrouble, "local_reply");
      }
      return;
    }
    if (turn.abort.signal.aborted) {
      clip.wav.fill(0);
      return;
    }
    void this.playCue("done");
    await this.sendTurn(clip, turn);
  }

  private async sendTurn(clip: Clip, turn: PendingTurn): Promise<void> {
    const cloud = this.cloud;
    if (!cloud || this.link !== "online") {
      clip.wav.fill(0);
      this.endTurn(turn);
      void this.say(this.localLine() ?? LINES.connecting, "local_reply");
      return;
    }
    // The clip exists only in this request body: never written to disk, logged, queued or retried.
    const body = {
      client_turn_id: this.newId(),
      input: { type: "audio" as const, mime: "audio/wav" as const, data_base64: clip.wav.toString("base64"), duration_ms: clip.durationMs },
      snapshot: this.snapshotIfSensors(),
    };
    clip.wav.fill(0);
    turn.clientTurnId = body.client_turn_id;
    const sentAt = this.deps.clock.monotonic();
    this.deps.log.info("turn sent", { seconds: Math.round(clip.durationMs / 100) / 10 });
    try {
      const reply = await withDeadline(this.deps.clock, TURN_DEADLINE_MS, (signal) => cloud.turn(body, signal), turn.abort.signal);
      if (this.turn !== turn) return;
      this.endTurn(turn);
      if (reply.proposal?.state === "open") this.setOpenProposal(reply.proposal);
      this.deps.bus.emit("turn", { outcome: "answered" });
      const wav = reply.speech ? this.readSpeech(reply.speech.data_base64) : undefined;
      this.deps.log.info("turn answered", {
        ms: Math.round(this.deps.clock.monotonic() - sentAt),
        answered_by: reply.turn.answered_by,
        voice: wav ? "server" : "walker",
      });
      void this.say(reply.turn.reply, "reply", wav);
    } catch (error) {
      if (this.turn !== turn) return;
      this.endTurn(turn);
      // The server may still finish this turn and open a proposal the person never heard: decline it later.
      this.rememberUnheard(body.client_turn_id);
      this.turnFailed(classifyError(error));
    }
  }

  /** The server's voiced reply, if it is a readable 16-bit PCM WAV; otherwise the walker speaks the text itself. */
  private readSpeech(base64: string): Buffer | undefined {
    try {
      const wav = Buffer.from(base64, "base64");
      const info = readWav(wav);
      if (info.format === 1 && info.bitsPerSample === 16 && info.pcm.length > 0) return wav;
    } catch {
      // Fall through to the walker's own voice.
    }
    this.deps.log.warn("the server's speech couldn't be read; using the walker's voice");
    return undefined;
  }

  private turnFailed(kind: CloudErrorKind): void {
    if (kind === "timeout" || kind === "unreachable") {
      this.deps.bus.emit("turn", { outcome: kind === "timeout" ? "timeout" : "offline" });
      if (this.link === "offline") void this.say(this.localLine() ?? LINES.connecting, "local_reply");
      else this.goOffline();
    } else if (kind === "unauthorized") {
      this.deps.bus.emit("turn", { outcome: "unauthorized" });
      this.setUnauthorized();
    } else if (kind !== "cancelled") {
      this.deps.bus.emit("turn", { outcome: "failed" });
      void this.say(LINES.serverTrouble, "local_reply");
    }
  }

  private endTurn(turn: PendingTurn): void {
    if (this.turn === turn) this.turn = null;
    this.setTalk("idle");
  }

  private cancelTurn(): void {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.clientTurnId) this.rememberUnheard(turn.clientTurnId);
    turn.abort.abort(new CancelledError("Cancelled by a Talk press."));
    this.setTalk("idle");
    this.deps.bus.emit("turn", { outcome: "cancelled" });
    void this.say(LINES.cancelled, "local_reply");
  }

  private rememberUnheard(clientTurnId: string): void {
    this.unheardTurns.push(clientTurnId);
    if (this.unheardTurns.length > UNHEARD_TURNS_KEPT) this.unheardTurns.shift();
  }

  /** Each Confirm press buzzes its hand once: `confirmation` the moment it confirms, otherwise `error` when it ends. */
  private async confirmPressed(event: ButtonEvent): Promise<void> {
    let felt = false;
    const feel = (pattern: "confirmation" | "error") => {
      if (felt) return;
      felt = true;
      this.pressBuzz(event, pattern);
    };
    try {
      await this.answerConfirm(() => feel("confirmation"));
    } finally {
      feel("error");
    }
  }

  private async answerConfirm(confirmed: () => void): Promise<void> {
    if (this.talk === "recording") {
      this.deps.log.info("Confirm ignored while recording");
      return;
    }
    if (this.confirmInFlight) return;
    if (this.link !== "online" || !this.cloud) {
      const line = this.link === "offline" ? LINES.offlineNoSettings : this.localLine();
      void this.say(line ?? LINES.connecting, "local_reply");
      return;
    }
    const proposal = this.openProposal;
    if (!proposal) {
      this.nothingToConfirm();
      return;
    }
    const cloud = this.cloud;
    this.confirmInFlight = true;
    this.proposalEpoch += 1;
    try {
      const answer = await withDeadline(this.deps.clock, TURN_DEADLINE_MS, (signal) =>
        cloud.answerProposal(proposal.proposal_id, "confirm", signal),
      );
      await this.afterConfirm(answer.proposal, confirmed);
    } catch (error) {
      const kind = classifyError(error);
      if (kind === "proposal_closed" && error instanceof CloudError) {
        // A 409 carrying "confirmed" means an earlier Confirm (here or on the page) already won.
        if (error.proposal?.state === "confirmed") await this.afterConfirm(error.proposal, confirmed);
        else {
          this.forgetProposal(proposal.proposal_id);
          this.nothingToConfirm();
        }
      } else if (error instanceof CloudError && error.code === "not_found") {
        this.forgetProposal(proposal.proposal_id);
        this.nothingToConfirm();
      } else if (kind === "timeout" || kind === "unreachable") this.goOffline();
      else if (kind === "unauthorized") this.setUnauthorized();
      else void this.say(LINES.serverTrouble, "local_reply");
    } finally {
      this.confirmInFlight = false;
    }
  }

  private async afterConfirm(proposal: ProposalView, confirmed: () => void): Promise<void> {
    this.forgetProposal(proposal.proposal_id);
    if (proposal.state !== "confirmed" || proposal.configuration_version === null) {
      this.nothingToConfirm();
      return;
    }
    confirmed(); // felt at once, not after the configuration fetch
    const target = proposal.configuration_version;
    const applied = (this.configuration?.version ?? 0) >= target || ((await this.fetchConfiguration()) && (this.configuration?.version ?? 0) >= target);
    void this.playCue("done");
    void this.say(applied && this.configuration ? appliedLine(this.configuration.cues) : LINES.confirmedPending, "confirm_result");
  }

  private forgetProposal(proposalId: string): void {
    if (this.openProposal?.proposal_id === proposalId) this.setOpenProposal(null);
  }

  private setOpenProposal(proposal: ProposalView | null): void {
    this.openProposal = proposal;
    this.proposalEpoch += 1;
  }

  private nothingToConfirm(): void {
    void this.playCue("nothing_to_confirm");
    this.record(LINES.nothingToConfirm, "local_reply");
  }

  /** A proposal opened by a turn whose reply the person never heard (cancelled, timed out, failed) is declined. */
  private async declineCancelled(proposal: ProposalView, cloud: CloudClient): Promise<void> {
    if (this.declining.has(proposal.proposal_id)) return;
    this.declining.add(proposal.proposal_id);
    try {
      await withDeadline(this.deps.clock, TURN_DEADLINE_MS, (signal) => cloud.answerProposal(proposal.proposal_id, "decline", signal));
      this.deps.log.info("declined the proposal from a cancelled turn");
    } catch (error) {
      if (classifyError(error) !== "proposal_closed") {
        this.declining.delete(proposal.proposal_id);
        this.deps.log.warn("couldn't decline the proposal from a cancelled turn; retrying on the next heartbeat", {
          kind: classifyError(error),
        });
      }
    }
  }

  // ---- Cloud link ----

  /**
   * Sends a heartbeat now rather than at the next tick, when the page should see a change at once (a new
   * configuration applied, the GPIO buttons settled). During a heartbeat, the next one goes right after it.
   */
  reportSoon(): void {
    if (this.heartbeatInFlight) this.reportAfterFlight = true;
    else this.scheduleHeartbeat(0);
  }

  private scheduleHeartbeat(delayMs: number): void {
    if (this.stopped) return;
    this.cancelHeartbeat?.();
    this.cancelHeartbeat = this.deps.clock.setTimeout(() => {
      this.cancelHeartbeat = null;
      void this.heartbeat();
    }, delayMs);
  }

  private async heartbeat(): Promise<void> {
    if (this.stopped || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    let nextDelay = HEARTBEAT_INTERVAL_MS;
    let failed = false;
    try {
      this.refreshCredential();
      const cloud = this.cloud;
      if (!cloud) return;
      const events = this.deps.store.pendingEvents(this.deps.clock.monotonic());
      const epoch = this.proposalEpoch;
      const body: HeartbeatRequest = {
        sent_at: iso(this.deps.clock.now()),
        service_version: SERVICE_VERSION,
        manifest: this.manifest(),
        snapshot: this.snapshotIfSensors(),
        events,
      };
      try {
        const response = await withDeadline(this.deps.clock, HEARTBEAT_DEADLINE_MS, (signal) => cloud.heartbeat(body, signal));
        if (cloud !== this.cloud || this.stopped) return;
        this.deps.store.acknowledgeEvents(events.map((event) => event.event_id));
        this.deps.bus.emit("heartbeat", { ok: true });
        const wasOffline = this.link === "offline";
        this.failures = 0;
        this.setLink("online");
        if (wasOffline) void this.say(LINES.backOnline, "notice");
        const open = response.open_proposal;
        if (open && this.unheardTurns.includes(open.client_turn_id)) {
          this.setOpenProposal(null);
          void this.declineCancelled(open, cloud);
        } else if (this.proposalEpoch === epoch) {
          // Only if nothing newer (a turn's proposal, a Confirm, a cancel) was learned while this was in flight.
          this.setOpenProposal(open);
        }
        // Newer is the usual case; a different version (even a lower one) means what is held belongs elsewhere.
        if (response.configuration_version !== this.configuration?.version) await this.fetchConfiguration();
      } catch (error) {
        if (cloud !== this.cloud || this.stopped) return;
        failed = true;
        this.deps.bus.emit("heartbeat", { ok: false });
        const kind = classifyError(error);
        if (kind === "unauthorized") {
          this.setUnauthorized();
          return;
        }
        this.failures += 1;
        this.deps.log.warn("heartbeat failed", { kind, failures: this.failures });
        nextDelay = HEARTBEAT_BACKOFF_MS[Math.min(this.failures, HEARTBEAT_BACKOFF_MS.length) - 1] ?? HEARTBEAT_INTERVAL_MS;
        if (this.failures >= OFFLINE_AFTER_FAILED_HEARTBEATS) this.goOffline();
      }
    } finally {
      this.heartbeatInFlight = false;
      // A change learned during this heartbeat goes out at once, unless it failed (then the backoff holds).
      const soon = this.reportAfterFlight && !failed;
      this.reportAfterFlight = false;
      this.scheduleHeartbeat(soon ? 0 : nextDelay);
    }
  }

  private async fetchConfiguration(): Promise<boolean> {
    const cloud = this.cloud;
    if (!cloud) return false;
    try {
      const configuration = await withDeadline(this.deps.clock, HEARTBEAT_DEADLINE_MS, (signal) => cloud.configuration(signal));
      if (cloud !== this.cloud) return false;
      const changed = configuration.version !== this.configuration?.version;
      // Applied in memory first, so a failed save (a read-only SD card) can't block the person's change.
      this.configuration = configuration;
      try {
        this.deps.store.writeConfiguration(configuration);
      } catch (error) {
        this.deps.log.error("couldn't save the configuration; it applies until the next restart", { error: (error as Error).message });
      }
      this.deps.log.info("configuration applied", { version: configuration.version, cues: configuration.cues.join(",") });
      this.deps.bus.emit("config", { version: configuration.version });
      // Tell the server now, so the page shows "Applied" within about a second, not at the next tick. Only
      // on a real change, so a server whose heartbeat and configuration answers disagree can't make a loop.
      if (changed) this.reportSoon();
      return true;
    } catch (error) {
      const kind = classifyError(error);
      this.deps.log.warn("configuration fetch failed; retrying on the next heartbeat", { kind });
      if (kind === "unauthorized") this.setUnauthorized();
      return false;
    }
  }

  /** Reads the credential file on every tick, so a `walker pair` while running takes effect without a restart. */
  private refreshCredential(): void {
    const next = this.deps.store.readCredential();
    const current = this.credential;
    if (
      next &&
      current &&
      next.device_id === current.device_id &&
      next.credential === current.credential &&
      next.server_url === current.server_url
    ) {
      return;
    }
    let cloud: CloudClient | null = null;
    if (next) {
      try {
        cloud = this.deps.makeCloud(next);
      } catch (error) {
        this.deps.log.error("the saved credential can't be used; pair the walker again", { error: (error as Error).message });
      }
    }
    if (!next || !cloud) {
      if (current || this.link !== "unpaired") {
        this.credential = null;
        this.cloud = null;
        this.setOpenProposal(null);
        this.setLink("unpaired");
      }
      return;
    }
    // A new pairing writes its own configuration 1; take that one rather than an older device's.
    if (current?.device_id !== next.device_id) this.configuration = this.deps.store.readConfiguration();
    this.credential = next;
    this.cloud = cloud;
    this.failures = 0;
    this.setOpenProposal(null);
    this.deps.log.info("using device credential", { device: next.device_id, server: new URL(next.server_url).host });
    this.setLink("connecting");
  }

  private goOffline(): void {
    if (this.link === "offline" || this.link === "unauthorized" || this.link === "unpaired") return;
    this.setLink("offline");
    this.setOpenProposal(null);
    void this.say(offlineLine(this.configuration?.cues ?? null, this.deps.modules.modules()), "notice");
  }

  private setUnauthorized(): void {
    if (this.link === "unauthorized") return;
    this.setLink("unauthorized");
    this.setOpenProposal(null);
    void this.say(LINES.pairAgain, "notice");
  }

  // ---- Reports ----

  /**
   * Every part the walker has, each once: the coordinator itself, each ESP32 module by its id, the Pi's GPIO
   * buttons when the installer declared them wired (the Pi can't sense a button), and the USB mic and
   * speaker. Nothing it doesn't have. Past 32, ESP32 modules are cut first, never the Pi's own parts.
   */
  manifest(): CapabilityManifest {
    const now = this.deps.clock.now();
    const serial = this.deps.modules.modules();
    const coordinator: CapabilityManifest["modules"][number] = {
      module_id: "base.walker",
      instance_id: this.deps.coordinatorInstanceId,
      firmware_version: SERVICE_VERSION,
      protocol_version: null,
      health: "ok",
      faults: [],
      observed_at: iso(now),
      simulated: this.deps.simulator,
    };
    const gpio = this.deps.gpioButtons;
    const gpioPart: CapabilityManifest["modules"] = gpio
      ? [
            {
              module_id: "controls.hand",
              instance_id: gpio.instanceId,
              firmware_version: null,
              protocol_version: null,
              ...gpio.status(),
              observed_at: iso(now),
              simulated: false,
            },
          ]
      : [];
    const room = 32 - 2 - gpioPart.length; // the coordinator, voice and the GPIO buttons always fit
    // Available modules first (in hello order), so a cut drops an old unavailable board before a live one.
    const ranked = [...serial.filter((m) => m.health !== "unavailable"), ...serial.filter((m) => m.health === "unavailable")];
    const modules: CapabilityManifest["modules"] = ranked.slice(0, room).map((module) => ({
      module_id: module.catalogId,
      instance_id: module.instanceId,
      firmware_version: module.firmwareVersion,
      protocol_version: SERIAL_PROTOCOL_VERSION,
      health: module.health,
      faults: module.faults.slice(0, 8),
      observed_at: iso(module.observedAt),
      simulated: module.simulated,
    }));
    modules.unshift(coordinator);
    modules.push(...gpioPart);
    modules.push({
      module_id: "voice",
      instance_id: this.deps.audioInstanceId,
      firmware_version: null,
      protocol_version: null,
      health: this.audioFaults.size > 0 ? "degraded" : "ok",
      faults: [...this.audioFaults],
      observed_at: iso(now),
      simulated: this.deps.capture.simulated || this.deps.speaker.simulated,
    });
    return {
      device_configuration_version: this.configuration?.version ?? null,
      generated_at: iso(now),
      simulator: this.deps.simulator,
      modules,
    };
  }

  /** Only fresh zones from available modules; a zone left out is unknown, never clear. */
  snapshot(): SensorSnapshot {
    return {
      generated_at: iso(this.deps.clock.now()),
      zones: this.deps.modules
        .currentZones()
        .slice(0, 32)
        .map((zone) => ({
          zone: zone.zone,
          instance_id: zone.instanceId,
          mm: zone.mm,
          quality: zone.quality,
          captured_at: iso(zone.receivedWall),
          expires_at: iso(zone.receivedWall + ZONE_VALIDITY_MS),
        })),
    };
  }

  /** The contract sends null when the walker has no obstacle sensor attached. */
  private snapshotIfSensors(): SensorSnapshot | null {
    return this.deps.modules.modules().some((module) => module.type === "perception") ? this.snapshot() : null;
  }

  // ---- Output ----

  /**
   * Speaks a line. The Pi's own lines (notices and local replies) also become heartbeat events for the page;
   * replies and Confirm results are already on the page as the turn and the proposal's state.
   */
  private say(text: string, kind: SpeechKind, wav?: Buffer): Promise<void> {
    if (kind === "notice" || kind === "local_reply") this.record(text, kind);
    else this.lastRecorded = null; // a reply or a Confirm result in between makes the next local line new
    this.deps.bus.emit("spoke", { text, kind });
    return this.voice.say(text, wav);
  }

  /** Queues a local line for the page; the same line again within LOCAL_LINE_REPEAT_MS is spoken but sent once. */
  private record(text: string, kind: "notice" | "local_reply"): void {
    const now = this.deps.clock.monotonic();
    const last = this.lastRecorded;
    if (last && last.text === text && now - last.mono < LOCAL_LINE_REPEAT_MS) return;
    this.lastRecorded = { text, mono: now };
    this.deps.store.pushEvent({ event_id: this.newId(), kind, text: text.slice(0, 200), saidMono: now });
  }

  private async playCue(name: CueName): Promise<void> {
    this.deps.bus.emit("cue", { name });
    try {
      await this.deps.speaker.playCue(name);
      this.audioFaults.delete("playback_failed");
    } catch (error) {
      this.audioFault("playback_failed", error as Error);
    }
  }

  private cue(name: CueName): void {
    void this.playCue(name);
  }

  private audioFault(fault: "capture_failed" | "playback_failed", error: Error): void {
    this.audioFaults.add(fault);
    this.deps.log.warn(fault === "capture_failed" ? "microphone failed" : "speaker failed", { error: error.message });
  }

  private setTalk(state: TalkState): void {
    if (this.talk === state) return;
    this.talk = state;
    this.deps.bus.emit("talk", { state });
  }

  private setLink(state: LinkState): void {
    if (this.link === state) return;
    this.link = state;
    this.deps.bus.emit("link", { state });
  }
}
