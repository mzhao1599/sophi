import { randomUUID } from "node:crypto";
import {
  MANIFEST_MAY_LIST_ARMS,
  SERIAL_PROTOCOL_VERSION,
  WALKER_MAX_TOOL_CALLS,
  type CapabilityManifest,
  type Cue,
  type LatLon,
  type HeartbeatRequest,
  type DeviceTurnRequest,
  type DeviceSendMessageRequest,
  type ProposalView,
  type SensorSnapshot,
  type WalkerConfiguration,
  type WalkerIncomingMessage,
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
  ESP32_TALK_RELEASE_GRACE_MS,
  HEARTBEAT_BACKOFF_MS,
  HEARTBEAT_DEADLINE_MS,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_LINE_REPEAT_MS,
  MESSAGES_RETRY_MS,
  OFFLINE_AFTER_FAILED_HEARTBEATS,
  ROUTE_TOOL_MS,
  SCREEN_MESSAGE_HOLD_MS,
  SPEECH_LINE_MAX_MS,
  TALK_PRESS_HAPTIC_MS,
  TURN_DEADLINE_MS,
  ZONE_VALIDITY_MS,
} from "./constants";
import { CuePolicy } from "./cues";
import { describeGpsLocation } from "./location";
import { describeCurrentWeather } from "./weather";
import type { Logger } from "./log";
import { NAV_LINES, Navigator, type GuidanceLine } from "./navigation/navigator";
import { defaultMapServices, type MapServices } from "./navigation/osm";
import { findPlace, type Place } from "./navigation/places";
import type { PositionSource } from "./navigation/position";
import { minutesWords, planRoute, roughDistanceWords, tooFarLine, walkingMinutes, type RouteOutcome } from "./navigation/route";
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
  /**
   * Optional position source: the USB GPS, or the SIMULATED position (`walker simulate`, WALKER_GPS_SIMULATED).
   * Sharing consent enables heartbeat sampling (never for a simulated one); a location question reads once; a
   * route keeps it tracking. With one, every device turn carries `navigation` and the route tools can run.
   */
  location?: PositionSource;
  /** The map services for places, routes and addresses (tests and the simulator inject recorded ones). */
  maps?: MapServices;
  /**
   * The motion coordinator, when arms are configured. It sees every press first: a press that stops motion or
   * accepts a pending motion item is its own, and Talk and Confirm then ignore it.
   */
  motion?: { handlePress(event: ButtonEvent): boolean; ownsConfirm(): boolean };
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
  /** Called once, just before the line starts playing (never for a line stopped before it started). */
  onStart?: () => void;
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

  say(text: string, wav?: Buffer, onStart?: () => void): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ text, wav, cancelled: false, resolve, ...(onStart ? { onStart } : {}) });
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
      const onStart = item.onStart;
      item.onStart = undefined;
      onStart?.();
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
 * Talk (the design's button map): hold to talk, release to send. The ESP32 handle waits briefly after a
 * release so a quick re-press continues the same recording; after the turn is sent, a press while waiting
 * cancels. A press while a reply is playing stops it and starts listening. The simulator keyboard only
 * presses, so a second press sends. Confirm answers the open proposal by id; with none it plays the
 * "nothing to confirm" sound, or reads her newest message again when she has one. The Pi
 * never judges a proposal's expiry by its own clock: the server says whether it is still open.
 *
 * Messages: after each heartbeat the walker asks for her newest messages from caretakers and reads each new one
 * aloud once in its own voice ("Message from Maya. …"), waiting while she talks or a message draft awaits Confirm.
 * What is there at the first answer after start or pairing is not read out (she can still hear the newest again).
 * They are never sent to the page, a model or the voice service, and never logged.
 */
export class WalkerService {
  talk: TalkState = "idle";
  link: LinkState = "unpaired";
  configuration: WalkerConfiguration | null = null;
  openProposal: ProposalView | null = null;
  private pendingMessage: { body: DeviceSendMessageRequest; toName: string; ready: boolean; expiresAt: number } | null = null;

  private credential: CredentialFile | null = null;
  private cloud: CloudClient | null = null;
  private failures = 0;
  private recording: Recording | null = null;
  private cancelTalkRelease: Cancel | null = null;
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
  private locationSharingEnabled = false;
  /** Message ids already read aloud or there at the first answer; null until that first answer. */
  private messagesSeen: Set<string> | null = null;
  private readonly unreadMessages: WalkerIncomingMessage[] = [];
  /** The newest message, which a Confirm press with nothing to confirm reads again; null once it is deleted. */
  private latestMessage: WalkerIncomingMessage | null = null;
  private readingMessage = false;
  private messagesInFlight = false;
  private messagesRetryAt = 0;
  private messageCount = 0;
  private readonly audioFaults = new Set<string>();
  /** A caretaker's message stays on the walker screen until then (monotonic) after it was read. */
  private messageHeldUntil = 0;
  /** Walking directions, when the walker has a position source. */
  private readonly navigator: Navigator | null = null;
  private readonly maps: MapServices;
  /** The route's first line, said once the turn that started it has finished speaking. */
  private introWaiting: GuidanceLine | null = null;
  /** The newest guidance line waiting its turn (a newer one replaces it). */
  private guidanceWaiting: GuidanceLine | null = null;
  private guidancePlaying = false;
  /** Answers to her Talk turns queued or playing: guidance waits for them. */
  private answersPlaying = 0;
  private readonly voice: VoiceQueue;
  private readonly cues: CuePolicy;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly newId: () => string;

  constructor(private readonly deps: ServiceDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.maps = deps.maps ?? defaultMapServices();
    const source = deps.location;
    if (source) {
      this.navigator = new Navigator({
        clock: deps.clock,
        log: deps.log,
        position: () => source.current(),
        simulated: source.simulated,
        replan: (from, place, signal) => planRoute(this.maps, from, place, signal),
        say: (line) => {
          this.guidanceWaiting = line;
          this.flushGuidance();
        },
        view: (view) => deps.bus.emit("navigation", { view }),
        routeChanged: (route) => {
          source.track(route !== null);
          source.follow?.(route ? route.line.points : null);
          if (!route) {
            this.introWaiting = null;
            this.guidanceWaiting = null;
          }
        },
      });
    }
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
      bus.on("screenPress", ({ action, state }) => this.screenPressed(action, state)),
    );
    void this.say(LINES.boot, "notice");
    this.refreshCredential();
    this.scheduleHeartbeat(0);
  }

  stop(): void {
    this.stopped = true;
    this.navigator?.stop("service stopped");
    this.deps.location?.stop();
    this.cancelHeartbeat?.();
    this.recording?.session?.abort();
    this.recording?.cancelMax?.();
    this.cancelTalkRelease?.();
    this.cancelTalkRelease = null;
    this.recording = null;
    this.turn?.abort.abort(new CancelledError("Service stopped."));
    this.voice.stopAll();
    this.pendingMessage = null;
    this.unreadMessages.length = 0;
    for (const off of this.unsubscribe) off();
  }

  // ---- Buttons ----

  private onButton(event: ButtonEvent): void {
    if (this.stopped) return;
    if (this.deps.motion?.handlePress(event)) {
      if (event.button === "confirm" && event.edge === "pressed") this.pendingMessage = null;
      return;
    }
    if (event.button === "talk") {
      if (event.edge === "pressed") {
        // A hand button briefly opening during a hold must not start another mic or cancel the turn.
        if (event.source === "esp32" && this.talk === "recording" &&
            this.recording?.source === event.source && this.recording.detail === event.detail) {
          this.cancelTalkRelease?.();
          this.cancelTalkRelease = null;
          return;
        }
        this.talkPressed(event);
        // After the press is handled, so the buzz never delays the listening sound or the mic.
        this.pressBuzz(event, "recording");
      } else if (this.talk === "recording" && this.recording?.source === event.source &&
                 this.recording.detail === event.detail) {
        if (event.source === "esp32") {
          if (!this.cancelTalkRelease) {
            this.cancelTalkRelease = this.deps.clock.setTimeout(() => {
              this.cancelTalkRelease = null;
              void this.finishRecording();
            }, ESP32_TALK_RELEASE_GRACE_MS);
          }
        } else void this.finishRecording();
      }
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
    this.pendingMessage = null;
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
      this.localAnswer(blocked);
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
    this.cancelTalkRelease?.();
    this.cancelTalkRelease = null;
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
    this.cancelTalkRelease?.();
    this.cancelTalkRelease = null;
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
      this.localAnswer(this.localLine() ?? LINES.connecting);
      return;
    }
    // The clip exists only in this request body: never written to disk, logged, queued or retried.
    const body: DeviceTurnRequest = {
      client_turn_id: this.newId(),
      input: { type: "audio" as const, mime: "audio/wav" as const, data_base64: clip.wav.toString("base64"), duration_ms: clip.durationMs },
      snapshot: this.snapshotIfSensors(),
      ...this.navigationField(),
    };
    clip.wav.fill(0);
    turn.clientTurnId = body.client_turn_id;
    const sentAt = this.deps.clock.monotonic();
    this.deps.log.info("turn sent", { seconds: Math.round(clip.durationMs / 100) / 10 });
    try {
      let request = body;
      let reply;
      let routeToolRan = false;
      for (let step = 0; step <= WALKER_MAX_TOOL_CALLS; step++) {
        reply = await withDeadline(this.deps.clock, TURN_DEADLINE_MS, (signal) => cloud.turn(request, signal), turn.abort.signal);
        if (this.turn !== turn) return;
        const tool = reply.tool_call?.name;
        if (!tool) break;
        const prior = reply.tool_results ?? [];
        if (step === WALKER_MAX_TOOL_CALLS) throw new Error("Tool loop limit reached.");
        if (step === 0) this.sayAnswer(reply.turn.heard, reply.turn.reply, "fixed", "reply", reply.speech ? this.readSpeech(reply.speech.data_base64) : undefined);
        const call = reply.tool_call!;
        let text: string | null;
        if (call.name === "get_distance") text = null;
        else if (call.name === "get_location" || call.name === "get_weather") text = await this.runLocationTool(call.name, turn.abort.signal);
        else if (routeToolRan) text = "Walking directions were already handled in this turn.";
        else {
          // At most one route tool in a turn (the server ends the loop after one; this is the Pi's own check).
          routeToolRan = true;
          text = call.name === "start_route" ? await this.runStartRoute(call.destination, turn.abort.signal) : this.runStopRoute();
        }
        if (this.turn !== turn) return;
        const heard = reply.turn.heard?.trim();
        if (!heard) throw new Error("Tool continuation needs a transcript.");
        request = {
          client_turn_id: body.client_turn_id,
          input: { type: "text", text: heard.slice(0, 500) },
          snapshot: this.snapshotIfSensors(),
          tool_results: text === null ? prior : [...prior, { name: tool, text }],
          original_audio: true,
          ...this.navigationField(),
        };
      }
      if (!reply) throw new Error("The agent did not answer.");
      if (this.turn !== turn) return;
      this.endTurn(turn);
      if (reply.proposal?.state === "open") {
        // A motion Confirm target shown first owns Confirm: this proposal is declined, never answered by that press.
        if (this.deps.motion?.ownsConfirm()) {
          this.deps.log.info("a proposal arrived while a motion Confirm target is pending; declining it");
          this.rememberUnheard(body.client_turn_id);
        } else this.setOpenProposal(reply.proposal);
      }
      this.deps.bus.emit("turn", { outcome: "answered" });
      const wav = reply.speech ? this.readSpeech(reply.speech.data_base64) : undefined;
      this.deps.log.info("turn answered", {
        ms: Math.round(this.deps.clock.monotonic() - sentAt),
        answered_by: reply.turn.answered_by,
        voice: wav ? "server" : "walker",
      });
      const message = reply.message_offer;
      if (message && !this.openProposal && !this.deps.motion?.ownsConfirm()) {
        const pending = { body: { client_message_id: message.client_message_id, to_member_id: message.to_member_id, text: message.text }, toName: message.to_name, ready: false, expiresAt: 0 };
        this.pendingMessage = pending;
        void this.sayAnswer(reply.turn.heard, reply.turn.reply, reply.turn.answered_by, "reply", wav).then(() => {
          if (this.pendingMessage !== pending || this.stopped || this.link !== "online") return;
          this.deps.clock.setTimeout(() => {
            if (this.pendingMessage !== pending) return;
            pending.ready = true;
            pending.expiresAt = this.deps.clock.monotonic() + 30_000;
          }, 1_500);
        });
      } else this.sayAnswer(reply.turn.heard, reply.turn.reply, reply.turn.answered_by, "reply", wav);
    } catch (error) {
      if (this.turn !== turn) return;
      this.endTurn(turn);
      // The server may still finish this turn and open a proposal the person never heard: decline it later.
      this.rememberUnheard(body.client_turn_id);
      this.turnFailed(classifyError(error));
    }
  }

  private async runLocationTool(tool: "get_location" | "get_weather", signal: AbortSignal): Promise<string> {
    let answer: string;
    try {
      const gps = this.deps.location;
      if (!gps?.connected()) answer = `I can't check ${tool === "get_weather" ? "weather near you" : "your location"} because the GPS receiver is not connected.`;
      else {
        const reading = await gps.onDemand(signal);
        answer = reading.status === "fix"
          ? tool === "get_weather"
            ? await describeCurrentWeather(reading.latitude, reading.longitude, signal)
            : await describeGpsLocation(reading.latitude, reading.longitude, signal, { services: this.maps, simulated: gps.simulated })
          : "The GPS receiver has no satellite fix yet. Try again outdoors with a view of the sky.";
      }
    } catch (error) {
      if (signal.aborted) throw error;
      this.deps.log.warn(`${tool} lookup failed`, { error: (error as Error).message });
      answer = tool === "get_weather" ? "I couldn't check the weather right now." : "I found the GPS receiver, but couldn't look up an address right now.";
    }
    return answer;
  }

  // ---- Walking directions ----

  /** `navigation` for a device turn: present whenever the walker has a position source, so the route tools are offered. */
  private navigationField(): Pick<DeviceTurnRequest, "navigation"> {
    return this.navigator ? { navigation: { route: this.navigator.summary() } } : {};
  }

  /**
   * `start_route`: her position, the place (Nominatim, near her) and a walking route, all within ROUTE_TOOL_MS.
   * On success guidance starts (replacing any route on) and the first line waits for the turn's reply. The
   * result for the model names the place and the distances; the coordinates stay here. Every failure is a
   * fixed line, and leaves no route on.
   */
  private async runStartRoute(destination: string, signal: AbortSignal): Promise<string> {
    const source = this.deps.location;
    const navigator = this.navigator;
    if (!source || !navigator) return "This walker has no GPS, so I can't give walking directions.";
    if (!source.connected()) return "I can't give walking directions because the GPS receiver is not connected.";
    type Planned = { kind: "no_fix" } | { kind: "not_found" } | (RouteOutcome & { from: LatLon; place: Place });
    let planned: Planned;
    try {
      planned = await withDeadline(this.deps.clock, ROUTE_TOOL_MS, async (deadline): Promise<Planned> => {
        const reading = await source.onDemand(deadline);
        if (reading.status !== "fix") return { kind: "no_fix" };
        const from: LatLon = [reading.latitude, reading.longitude];
        const place = await findPlace(this.maps, destination, from, deadline);
        if (!place) return { kind: "not_found" };
        return { ...(await planRoute(this.maps, from, place, deadline)), from, place };
      }, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // The message never carries a coordinate (map errors are this code's own words), but numbers go anyway.
      this.deps.log.warn("start_route failed", { error: String((error as Error).message ?? error).replace(/-?\d+\.\d+/g, "#").slice(0, 80) });
      return error instanceof DeadlineError ? "I couldn't plan a route in time. Please try again in a moment." : "I couldn't plan a route right now.";
    }
    switch (planned.kind) {
      case "no_fix":
        return "The GPS receiver has no satellite fix yet, so I can't plan a route. Try again outdoors with a view of the sky.";
      case "not_found":
        return `I couldn't find "${destination}" near you.`;
      case "none":
        return `I found ${planned.place.name}, but couldn't find a walking route there.`;
      case "too_far":
        return tooFarLine(planned.metres);
      case "ok": {
        const { route, from } = planned;
        navigator.start(route, from);
        this.introWaiting = navigator.introLine();
        return `Walking directions started to ${route.place.name}: about ${roughDistanceWords(route.length)}, around ${minutesWords(walkingMinutes(route.length))} on foot. First: ${route.steps[0]!.instruction} The walker says each turn itself. ${NAV_LINES.osm}`;
      }
    }
  }

  /** `stop_route`: ends the route, if one is on. */
  private runStopRoute(): string {
    const place = this.navigator?.stop("asked to stop");
    return place ? `Stopped the directions to ${place.spoken}.` : "There were no walking directions to stop.";
  }

  /** The next instruction again (Confirm with nothing else to confirm, the screen's Repeat). */
  private repeatDirection(): void {
    const line = this.navigator?.repeatLine();
    if (!line) return;
    this.guidanceWaiting = line;
    this.flushGuidance();
  }

  /** The walker screen's End route and Repeat, acted on only when they were drawn on the route's screen. */
  private screenPressed(action: string, state: string | null): void {
    if (this.stopped || state !== "navigating" || !this.navigator?.active()) return;
    if (action === "end_route") {
      this.navigator.stop("ended on the screen");
      void this.say("Directions stopped.", "guidance");
    } else if (action === "repeat_direction") this.repeatDirection();
  }

  /**
   * Says the waiting guidance line when nothing of hers is using the walker's voice: not while Talk is held or
   * her turn waits, nor while an answer, a message or another guidance line plays. The route's first line goes
   * first; a line that is no longer true (she passed that turn meanwhile) is dropped.
   */
  private flushGuidance(): void {
    const navigator = this.navigator;
    if (!navigator || this.stopped || this.guidancePlaying) return;
    if (this.talk !== "idle" || this.answersPlaying > 0 || this.readingMessage) return;
    const line = this.introWaiting ?? this.guidanceWaiting;
    if (!line) return;
    if (line === this.introWaiting) this.introWaiting = null;
    else this.guidanceWaiting = null;
    if (!navigator.due(line)) return this.flushGuidance();
    this.guidancePlaying = true;
    void this.say(line.text, "guidance").then(() => {
      this.guidancePlaying = false;
      this.flushGuidance();
    });
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
    // Nothing waits for Confirm (motion's claim came first, in onButton): a caretaker's message on screen is read
    // again; else a route's next instruction; else her newest message. All offline too: they are on the walker.
    if (!this.pendingMessage && !this.openProposal) {
      const messageOnScreen = this.latestMessage && (this.readingMessage || this.deps.clock.monotonic() < this.messageHeldUntil);
      if (!messageOnScreen && this.navigator?.active()) {
        confirmed();
        this.repeatDirection();
        return;
      }
      if (this.latestMessage) {
        confirmed();
        if (!this.readingMessage) {
          this.unreadMessages.unshift(this.latestMessage);
          this.readMessages();
        }
        return;
      }
    }
    if (this.link !== "online" || !this.cloud) {
      const line = this.link === "offline" ? LINES.offlineNoSettings : this.localLine();
      void this.say(line ?? LINES.connecting, "local_reply");
      return;
    }
    if (this.pendingMessage) {
      const message = this.pendingMessage;
      if (!message.ready) {
        void this.say("One moment. I'll finish reading the message first.", "local_reply");
        return;
      }
      this.pendingMessage = null;
      if (this.deps.clock.monotonic() >= message.expiresAt) {
        void this.say("That message draft expired. Ask me again to send it.", "local_reply");
        return;
      }
      this.confirmInFlight = true;
      try {
        await withDeadline(this.deps.clock, TURN_DEADLINE_MS, (signal) => this.cloud!.sendMessage(message.body, signal));
        confirmed();
        void this.say(`Message sent to ${message.toName}.`, "confirm_result");
      } catch (error) {
        this.deps.log.warn("message send failed", { kind: classifyError(error) });
        void this.say("I couldn't confirm whether that message was sent. Check your phone before trying again.", "local_reply");
      } finally {
        this.confirmInFlight = false;
      }
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
    this.deps.bus.emit("confirming", { phase: "started" });
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
          this.settled({ kind: "nothing_changed" });
          this.nothingToConfirm();
        }
      } else if (error instanceof CloudError && error.code === "not_found") {
        this.forgetProposal(proposal.proposal_id);
        this.settled({ kind: "nothing_changed" });
        this.nothingToConfirm();
      } else if (kind === "timeout" || kind === "unreachable") this.goOffline();
      else if (kind === "unauthorized") this.setUnauthorized();
      else void this.say(LINES.serverTrouble, "local_reply");
    } finally {
      this.confirmInFlight = false;
      this.deps.bus.emit("confirming", { phase: "ended" });
    }
  }

  private async afterConfirm(proposal: ProposalView, confirmed: () => void): Promise<void> {
    this.forgetProposal(proposal.proposal_id);
    if (proposal.state !== "confirmed" || proposal.configuration_version === null) {
      this.settled({ kind: "nothing_changed" });
      this.nothingToConfirm();
      return;
    }
    confirmed(); // felt at once, not after the configuration fetch
    const target = proposal.configuration_version;
    const applied = (this.configuration?.version ?? 0) >= target || ((await this.fetchConfiguration()) && (this.configuration?.version ?? 0) >= target);
    // The screen says "Done" only once the new configuration is in force on this walker, with its own cues. If
    // the fetch failed, it says nothing of the kind: the offer closes and the screen shows what is true now.
    if (applied && this.configuration) this.settled({ kind: "alerts", cues: [...this.configuration.cues] });
    void this.playCue("done");
    void this.say(applied && this.configuration ? appliedLine(this.configuration.cues) : LINES.confirmedPending, "confirm_result");
  }

  private forgetProposal(proposalId: string): void {
    if (this.openProposal?.proposal_id === proposalId) this.setOpenProposal(null);
  }

  private setOpenProposal(proposal: ProposalView | null): void {
    const changed = (this.openProposal?.proposal_id ?? null) !== (proposal?.proposal_id ?? null);
    this.openProposal = proposal;
    if (proposal?.state === "open") this.pendingMessage = null;
    this.proposalEpoch += 1;
    if (changed) this.deps.bus.emit("offer", { proposal });
  }

  // ---- Her messages ----

  /** Asks for her newest messages (after a heartbeat that succeeded) and queues the new ones to be read aloud. */
  private async fetchMessages(cloud: CloudClient): Promise<void> {
    const now = this.deps.clock.monotonic();
    if (this.messagesInFlight || now < this.messagesRetryAt) return;
    this.messagesInFlight = true;
    try {
      const { messages } = await withDeadline(this.deps.clock, HEARTBEAT_DEADLINE_MS, (signal) => cloud.incomingMessages(signal));
      if (cloud !== this.cloud || this.stopped) return;
      const first = this.messagesSeen === null;
      const live = new Set(messages.map((m) => m.message_id));
      // Ids the server no longer sends are forgotten; a deleted message never comes back.
      const seen = new Set([...(this.messagesSeen ?? [])].filter((id) => live.has(id)));
      for (const message of messages) {
        if (seen.has(message.message_id)) continue;
        seen.add(message.message_id);
        if (!first) this.unreadMessages.push(message);
      }
      this.messagesSeen = seen;
      // A message deleted on the server (24 hours, or a phone removed) is no longer read or heard again.
      for (let i = this.unreadMessages.length - 1; i >= 0; i -= 1) if (!live.has(this.unreadMessages[i]!.message_id)) this.unreadMessages.splice(i, 1);
      if (first) this.latestMessage = messages.at(-1) ?? null;
      else if (this.latestMessage && !live.has(this.latestMessage.message_id)) this.latestMessage = null;
      this.readMessages();
    } catch (error) {
      const kind = classifyError(error);
      // The network is the heartbeat's business; anything else (an older server answers 404) waits a minute.
      if (kind !== "timeout" && kind !== "unreachable" && kind !== "cancelled") {
        this.messagesRetryAt = now + MESSAGES_RETRY_MS;
        this.deps.log.warn("couldn't fetch messages; trying again in a minute", { kind });
      }
    } finally {
      this.messagesInFlight = false;
    }
  }

  /** Reads the next waiting message aloud, one at a time, only while nothing else of hers needs the walker. */
  private readMessages(): void {
    if (this.stopped || this.readingMessage || this.talk !== "idle" || this.deps.motion?.ownsConfirm()) return;
    if (this.pendingMessage && this.deps.clock.monotonic() < this.pendingMessage.expiresAt) return;
    const message = this.unreadMessages.shift();
    if (!message) return;
    this.readingMessage = true;
    this.latestMessage = message;
    const id = (this.messageCount += 1);
    const spoken = this.say(messageLine(message), "message", undefined, () =>
      this.deps.bus.emit("circleMessage", { id, message_id: message.message_id, from_name: message.from_name, text: message.text }),
    );
    void spoken.then(() => {
      this.deps.bus.emit("circleMessageSpoken", { id });
      this.messageHeldUntil = this.deps.clock.monotonic() + SCREEN_MESSAGE_HOLD_MS;
      this.readingMessage = false;
      this.readMessages();
      this.flushGuidance();
    });
  }

  /** Forgets every message (unpaired, or the credential changed): another walker's messages are never read. */
  private forgetMessages(): void {
    this.messagesSeen = null;
    this.unreadMessages.length = 0;
    this.latestMessage = null;
    this.messagesRetryAt = 0;
  }

  // ---- For the walker screen (the screen's listeners are wrapped: none of these can throw back here) ----

  private answerCount = 0;

  /**
   * Speaks a reply to her Talk turn and captions it on the screen: `answer` goes out as the line starts playing
   * (so the captions follow the voice), `answerSpoken` when it has played or was stopped.
   */
  private sayAnswer(heard: string | null, reply: string, source: "model" | "fixed" | "walker", kind: SpeechKind, wav?: Buffer): Promise<void> {
    const id = (this.answerCount += 1);
    this.answersPlaying += 1;
    const spoken = this.say(reply, kind, wav, () => this.deps.bus.emit("answer", { id, heard, reply, source }));
    void spoken.then(() => {
      this.answersPlaying -= 1;
      this.deps.bus.emit("answerSpoken", { id });
      this.flushGuidance();
    });
    return spoken;
  }

  /** The Pi's own line for a Talk press it can't send: spoken as before, and captioned as the walker's own reply. */
  private localAnswer(text: string): void {
    this.sayAnswer(null, text, "walker", "local_reply");
  }

  private settled(result: { kind: "alerts"; cues: Cue[] } | { kind: "nothing_changed" }): void {
    this.deps.bus.emit("settled", { result });
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

  /** One of the Pi's own fixed lines from another part (the motion coordinator's prompts and faults). */
  /** Whether the walker's own proposal is open (it owns Confirm, so the arms prepare no Confirm target). */
  hasOpenProposal(): boolean {
    return this.openProposal !== null;
  }

  announce(text: string): void {
    if (this.stopped) return;
    void this.say(text, "notice");
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
      // A simulated position never goes in a heartbeat: caretakers must never see a made-up position as hers.
      const source = this.deps.location;
      const location = this.locationSharingEnabled && source && !source.simulated ? source.current() : null;
      const body: HeartbeatRequest = {
        sent_at: iso(this.deps.clock.now()),
        service_version: SERVICE_VERSION,
        manifest: this.manifest(),
        snapshot: this.snapshotIfSensors(),
        ...(location ? { location } : {}),
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
        this.locationSharingEnabled = response.location_sharing_enabled === true;
        this.deps.location?.setEnabled(this.locationSharingEnabled);
        if (wasOffline) void this.say(LINES.backOnline, "notice");
        const open = response.open_proposal;
        if (open && this.unheardTurns.includes(open.client_turn_id)) {
          this.setOpenProposal(null);
          void this.declineCancelled(open, cloud);
        } else if (this.proposalEpoch === epoch && !(open && this.deps.motion?.ownsConfirm())) {
          // Only if nothing newer (a turn's proposal, a Confirm, a cancel) was learned while this was in flight,
          // and not while a motion Confirm target owns Confirm (it is adopted on a later heartbeat).
          this.setOpenProposal(open);
        }
        void this.fetchMessages(cloud);
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
    if (current?.device_id !== next.device_id || current?.server_url !== next.server_url) this.forgetMessages();
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
    this.pendingMessage = null;
    void this.say(offlineLine(this.configuration?.cues ?? null, this.deps.modules.modules()), "notice");
  }

  private setUnauthorized(): void {
    if (this.link === "unauthorized") return;
    this.setLink("unauthorized");
    this.setOpenProposal(null);
    this.pendingMessage = null;
    void this.say(LINES.pairAgain, "notice");
  }

  // ---- Reports ----

  /**
   * Every part the walker has, each once: the coordinator itself, each ESP32 module by its id, the Pi's GPIO
   * buttons when the installer declared them wired (the Pi can't sense a button), a connected USB GPS,
   * and the USB mic and speaker. GPS presence does not imply a satellite fix or location sharing.
   * Past 32, ESP32 modules are cut first, never the Pi's own parts.
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
    const gps = this.deps.location;
    const gpsPart: CapabilityManifest["modules"] = gps?.connected()
      ? [{
          module_id: "location.gps",
          instance_id: gps.simulated ? "simulated-gps" : "pi-usb-gps",
          firmware_version: null,
          protocol_version: null,
          health: "ok",
          faults: [],
          observed_at: iso(now),
          simulated: gps.simulated,
        }]
      : [];
    const room = 32 - 2 - gpioPart.length - gpsPart.length; // coordinator and voice always fit
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
    modules.push(...gpsPart);
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
      // The arms are never listed while MANIFEST_MAY_LIST_ARMS is false: listing them changes the server's fixed
      // arms reply, which demo beat 5 expects word for word (docs/subsystems/manipulation.md, "Manifest").
      modules: MANIFEST_MAY_LIST_ARMS ? modules : modules.filter((module) => module.module_id !== "manipulation.arm"),
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
  private say(text: string, kind: SpeechKind, wav?: Buffer, onStart?: () => void): Promise<void> {
    if (kind === "notice" || kind === "local_reply") this.record(text, kind);
    else this.lastRecorded = null; // a reply or a Confirm result in between makes the next local line new
    this.deps.bus.emit("spoke", { text, kind });
    return this.voice.say(text, wav, onStart);
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
    // After the code that set it idle has queued her reply (or a message draft), so a waiting message comes after.
    if (state === "idle") queueMicrotask(() => {
      this.readMessages();
      this.flushGuidance();
    });
  }

  private setLink(state: LinkState): void {
    if (this.link === state) return;
    this.link = state;
    if (state !== "online") {
      this.locationSharingEnabled = false;
      this.deps.location?.setEnabled(false);
    }
    if (state === "unpaired" || state === "unauthorized") {
      this.forgetMessages();
      // Forgotten or unpaired: this walker's route ends with its pairing (offline, it keeps going).
      this.navigator?.stop(state);
    }
    this.deps.bus.emit("link", { state });
  }
}

/** How the walker reads a caretaker's message: who it is from, then the words exactly as sent. */
export function messageLine(message: Pick<WalkerIncomingMessage, "from_name" | "text">): string {
  return `Message from ${message.from_name}. ${message.text}`;
}
