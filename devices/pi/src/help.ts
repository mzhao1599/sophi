import {
  HELP_COUNTDOWN_MS,
  HELP_HOLD_MS,
  HELP_OKAY_ARMED_TTL_MS,
  HELP_POLL_MS,
  HELP_SEND_RETRY_MS,
  type HelpPerson,
  type HelpView,
} from "@walker/contracts";
import { HELP_WORDS } from "@walker/walker-screen/view";
import type { Bus, ButtonEvent, ButtonName, ButtonSourceKind, HelpScreen } from "./bus";
import { CancelledError, DeadlineError, withDeadline, type Cancel, type Clock } from "./clock";
import { CloudError, type CloudClient } from "./cloud/client";
import { HELP_CALL_DEADLINE_MS, HELP_RESULT_SHOWN_MS, HELP_SEND_RETRY_EVERY_MS, HELP_STATUS_RETRY_MS } from "./constants";
import type { Logger } from "./log";

/**
 * Asking for help on the walker (docs/subsystems/help.md, "The walker (Pi)"). The Pi decides everything here: the
 * server never pushes to it, and a model never creates a request (it only asks for the countdown).
 *
 * Two layers. Her gesture: the chord's hold (both handle buttons down, HELP_HOLD_MS), or a voice ask (the reply
 * playing, then the countdown). The request: sending (with retries), not sent, open, or closed. The screen shows
 * the gesture if there is one, else the request. While a gesture or an open request shows, help owns Confirm
 * (the service then declines proposals and drafts, and tells the motion coordinator).
 *
 * Words are the design's table (HELP_WORDS, shared with the screen). Logs carry ids, sources and outcomes, never
 * a name. Every timer is on the injected clock.
 */
export interface HelpDeps {
  clock: Clock;
  log: Logger;
  bus: Bus;
  /** The current cloud client, or null while unpaired. */
  cloud: () => CloudClient | null;
  /** Speaks one of the help lines (kind `help`: never a heartbeat event, logged by length on the Pi). */
  say: (text: string) => Promise<void>;
  cue: () => void;
  /** Both buttons went down: drop a recording that Talk press opened, stop what plays, drop a waiting Confirm. */
  chordStarted: () => void;
  stopVoice: () => void;
  /** A help call answered 401: the walker needs pairing again. */
  unauthorized: () => void;
  /** Help now owns Confirm, or no longer does. */
  ownsConfirmChanged: (owns: boolean) => void;
  /** Help no longer holds back her messages (the hold, countdown or sending ended). */
  quiet: () => void;
  newId: () => string;
}

type Gesture =
  | { kind: "hold"; cancel: Cancel }
  /** The server's "I'll ask Maya for help in 8 seconds" is playing; the countdown starts when it has played. */
  | { kind: "reply" }
  | { kind: "countdown"; left: number; cancel: Cancel };

type Request =
  | { kind: "idle" }
  | { kind: "sending"; clientHelpId: string; source: "handles" | "voice"; firstMono: number; retrying: boolean; cancel: Cancel | null }
  | { kind: "not_sent"; why: "no_caretaker" | "offline" | "failed"; cancel: Cancel }
  | { kind: "open"; view: HelpView; armedUntil: number | null; cancelArm: Cancel | null; okayInFlight: boolean }
  | { kind: "closed"; view: HelpView; cancel: Cancel };

const names = (people: readonly HelpPerson[]) => people.map((p) => p.name);

function failureKind(error: unknown): "network" | "cancelled" | "unauthorized" | "not_found" | "no_caretaker" | "help_closed" | "other" {
  if (error instanceof DeadlineError) return "network";
  if (error instanceof CancelledError) return "cancelled";
  if (!(error instanceof CloudError)) return "other";
  if (error.kind === "unreachable" || error.kind === "timeout" || error.kind === "server_error") return "network";
  if (error.kind === "cancelled") return "cancelled";
  if (error.kind === "unauthorized") return "unauthorized";
  if (error.kind === "help_closed") return "help_closed";
  if (error.status === 404) return "not_found";
  if (error.status === 409 && error.code === "no_caretaker") return "no_caretaker";
  return "other";
}

/** Phones remembered per request (to say each one once) and requests seen: bounded, oldest dropped first. */
const REMEMBERED = 64;
function remember(set: Set<string>, key: string): void {
  set.add(key);
  while (set.size > REMEMBERED) set.delete(set.values().next().value!);
}

export class WalkerHelp {
  private gesture: Gesture | null = null;
  private request: Request = { kind: "idle" };
  /** Which button each source holds down: `source:detail`, from raw edges (the keyboard never holds). */
  private readonly held = new Map<ButtonName, string>();
  /** A GET /help answered 200 in this run: the server knows help, so turns may carry `can_ask_for_help`. */
  private supported = false;
  private statusRetryAt = 0;
  private pollInFlight = false;
  private cancelPoll: Cancel | null = null;
  /** Help ids seen open in this run (a close is announced only for these) and closes already announced. */
  private readonly seenOpen = new Set<string>();
  private readonly closedSaid = new Set<string>();
  /** `help_id:member_id` already said for "showing on" and "on the way". */
  private readonly shownSaid = new Set<string>();
  private readonly comingSaid = new Set<string>();
  private owns = false;
  private lastScreen = "null";
  private stopped = false;

  constructor(private readonly deps: HelpDeps) {}

  /** Whether turns may carry `can_ask_for_help` (a GET /help answered 200 in this run). */
  canAskForHelp(): boolean {
    return this.supported;
  }

  /** Whether help owns Confirm now: her hold or countdown, or an open request on screen. */
  ownsConfirm(): boolean {
    return this.gesture !== null || this.request.kind === "open";
  }

  /** Whether her messages should wait: during the hold, the countdown or sending. */
  busy(): boolean {
    return this.gesture !== null || this.request.kind === "sending";
  }

  // ---- Raw handle edges (before the motion coordinator's claim) ----

  /**
   * Every handle edge, first. Returns true when help used it (a chord, a press that stopped the countdown, an
   * edge during the hold): the service then does nothing else with it. The motion coordinator still sees it.
   */
  edge(event: ButtonEvent): boolean {
    if (this.stopped) return false;
    const pressed = event.edge === "pressed";
    // The simulator keyboard only presses (no release): it never holds, so it never makes a chord.
    if (event.source !== "keyboard") {
      const key = `${event.source}:${event.detail ?? ""}`;
      if (pressed) this.held.set(event.button, key);
      else if (this.held.get(event.button) === key) this.held.delete(event.button);
    }
    const gesture = this.gesture;
    if (gesture?.kind === "hold") {
      if (!this.held.has("talk") || !this.held.has("confirm")) this.endHold();
      return true;
    }
    if (pressed && (gesture?.kind === "countdown" || gesture?.kind === "reply")) {
      this.stopCountdown();
      return true;
    }
    if (pressed && this.held.has("talk") && this.held.has("confirm")) {
      this.startHold();
      return true;
    }
    return false;
  }

  /** A button source can't report releases now (a hand module lost, gpiomon exited): what it held is let go. */
  buttonsLost(source: ButtonSourceKind, detail?: string): void {
    for (const [button, key] of [...this.held]) {
      if (key.startsWith(`${source}:`) && (source !== "esp32" || key === `${source}:${detail ?? ""}`)) this.held.delete(button);
    }
    if (this.gesture?.kind === "hold" && (!this.held.has("talk") || !this.held.has("confirm"))) this.endHold();
  }

  private startHold(): void {
    this.deps.chordStarted();
    this.disarm();
    const cancel = this.deps.clock.setTimeout(() => this.holdComplete(), HELP_HOLD_MS);
    this.gesture = { kind: "hold", cancel };
    this.deps.cue();
    this.deps.log.info("help: both buttons down");
    this.changed();
  }

  /** Let go before HELP_HOLD_MS: nothing is sent, and the screen goes back to what was under the hold. */
  private endHold(): void {
    if (this.gesture?.kind !== "hold") return;
    this.gesture.cancel();
    this.gesture = null;
    this.deps.log.info("help: let go before the hold completed; nothing sent");
    this.changed();
    this.deps.quiet();
  }

  private holdComplete(): void {
    if (this.gesture?.kind !== "hold" || this.stopped) return;
    this.gesture = null;
    this.ask("handles");
  }

  // ---- Voice: the reply, then the countdown ----

  /** A turn answered `ask_for_help`: `spoken` settles when its reply has played (or was stopped). */
  voiceAsked(spoken: Promise<void>): void {
    if (this.stopped) return;
    this.endGesture();
    const gesture: Gesture = { kind: "reply" };
    this.gesture = gesture;
    this.deps.log.info("help: asked by voice; counting down after the reply");
    this.changed();
    void spoken.then(() => {
      if (this.gesture !== gesture || this.stopped) return;
      this.tick(Math.ceil(HELP_COUNTDOWN_MS / 1000));
    });
  }

  private tick(left: number): void {
    if (left <= 0) {
      this.gesture = null;
      this.ask("voice");
      return;
    }
    const cancel = this.deps.clock.setTimeout(() => {
      if (this.gesture?.kind === "countdown" && this.gesture.cancel === cancel) this.tick(left - 1);
    }, 1000);
    this.gesture = { kind: "countdown", left, cancel };
    this.changed();
  }

  /** Any handle press during the reply or the countdown: nothing is asked, and the press does nothing else. */
  private stopCountdown(): void {
    const gesture = this.gesture;
    if (gesture?.kind !== "countdown" && gesture?.kind !== "reply") return;
    if (gesture.kind === "reply") this.deps.stopVoice();
    else gesture.cancel();
    this.gesture = null;
    this.deps.log.info("help: countdown stopped by a press; nothing sent");
    void this.deps.say(HELP_WORDS.stopped);
    this.changed();
    this.deps.quiet();
  }

  private endGesture(): void {
    const gesture = this.gesture;
    if (gesture?.kind === "hold" || gesture?.kind === "countdown") gesture.cancel();
    this.gesture = null;
  }

  // ---- Sending ----

  private ask(source: "handles" | "voice"): void {
    if (this.request.kind === "sending") {
      this.deps.log.info("help: already sending; nothing new sent", { source });
      this.changed();
      return;
    }
    this.endRequest();
    const request: Extract<Request, { kind: "sending" }> = {
      kind: "sending",
      clientHelpId: this.deps.newId(),
      source,
      firstMono: this.deps.clock.monotonic(),
      retrying: false,
      cancel: null,
    };
    this.request = request;
    void this.deps.say(HELP_WORDS.asking);
    this.changed();
    this.schedulePoll();
    void this.attempt(request);
  }

  private async attempt(request: Extract<Request, { kind: "sending" }>): Promise<void> {
    request.cancel = null;
    const cloud = this.deps.cloud();
    if (!cloud) {
      this.notSent("failed");
      return;
    }
    try {
      const view = await withDeadline(this.deps.clock, HELP_CALL_DEADLINE_MS, (signal) =>
        cloud.askForHelp({ client_help_id: request.clientHelpId, source: request.source }, signal),
      );
      if (this.request !== request || this.stopped) return;
      this.supported = true;
      this.deps.log.info("help: sent", { help_id: view.help_id, source: request.source });
      this.adopt(view);
    } catch (error) {
      if (this.request !== request || this.stopped) return;
      const kind = failureKind(error);
      this.deps.log.warn("help: a try failed", { kind, source: request.source });
      if (kind === "cancelled") return;
      if (kind === "network") {
        if (!request.retrying) {
          request.retrying = true;
          void this.deps.say(HELP_WORDS.retrying);
          this.changed();
        }
        const next = this.deps.clock.monotonic() + HELP_SEND_RETRY_EVERY_MS;
        if (next - request.firstMono <= HELP_SEND_RETRY_MS) {
          request.cancel = this.deps.clock.setTimeout(() => {
            if (this.request === request) void this.attempt(request);
          }, HELP_SEND_RETRY_EVERY_MS);
        } else this.notSent("offline");
        return;
      }
      if (kind === "no_caretaker") return this.notSent("no_caretaker");
      if (kind === "not_found") {
        this.olderServer();
        return this.notSent("failed");
      }
      this.notSent("failed");
      if (kind === "unauthorized") this.deps.unauthorized();
    }
  }

  private notSent(why: "no_caretaker" | "offline" | "failed"): void {
    this.endRequest();
    const cancel = this.deps.clock.setTimeout(() => {
      if (this.request.kind === "not_sent" && this.request.cancel === cancel) this.toIdle();
    }, HELP_RESULT_SHOWN_MS);
    this.request = { kind: "not_sent", why, cancel };
    this.deps.log.info("help: not sent", { why });
    void this.deps.say(HELP_WORDS.notSent[why]);
    this.changed();
    this.deps.quiet();
  }

  // ---- Open ----

  /** The server has a request open (her ask's answer, a poll, or one made on her phone): show and say it. */
  private adopt(view: HelpView): void {
    if (view.closed) {
      // Her ask came back closed: a repeated id whose request has closed since. Nothing new to say if never seen open.
      if (this.seenOpen.has(view.help_id)) this.close(view);
      else if (this.request.kind === "sending") this.toIdle();
      return;
    }
    const wasSending = this.request.kind === "sending";
    this.endRequest();
    remember(this.seenOpen, view.help_id);
    this.request = { kind: "open", view, armedUntil: null, cancelArm: null, okayInFlight: false };
    void this.deps.say(HELP_WORDS.sent(names(view.sent_to)));
    this.newsFrom(view);
    this.changed();
    this.schedulePoll();
    if (wasSending) this.deps.quiet();
  }

  /** Says each phone newly in `shown_to` (one line each) and everyone newly `coming` (one line), once. */
  private newsFrom(view: HelpView): void {
    for (const person of view.shown_to) {
      const key = `${view.help_id}:${person.member_id}`;
      if (this.shownSaid.has(key)) continue;
      remember(this.shownSaid, key);
      void this.deps.say(HELP_WORDS.shown(person.name));
    }
    const coming = view.coming.filter((person) => !this.comingSaid.has(`${view.help_id}:${person.member_id}`));
    for (const person of coming) remember(this.comingSaid, `${view.help_id}:${person.member_id}`);
    if (coming.length > 0) void this.deps.say(HELP_WORDS.coming(names(coming)));
  }

  /** A lone Confirm press while open (the service has waited out the chord window): arm, then close `okay`. */
  confirm(): void {
    const request = this.request;
    if (request.kind !== "open" || this.gesture || this.stopped || request.okayInFlight) return;
    if (request.armedUntil !== null && this.deps.clock.monotonic() < request.armedUntil) {
      void this.sendOkay(request);
      return;
    }
    request.cancelArm?.();
    request.armedUntil = this.deps.clock.monotonic() + HELP_OKAY_ARMED_TTL_MS;
    request.cancelArm = this.deps.clock.setTimeout(() => {
      if (this.request !== request) return;
      request.armedUntil = null;
      request.cancelArm = null;
      this.changed();
    }, HELP_OKAY_ARMED_TTL_MS);
    void this.deps.say(HELP_WORDS.armOkay(names(request.view.sent_to)));
    this.changed();
  }

  private disarm(): void {
    if (this.request.kind !== "open") return;
    this.request.cancelArm?.();
    this.request.cancelArm = null;
    this.request.armedUntil = null;
  }

  private async sendOkay(request: Extract<Request, { kind: "open" }>): Promise<void> {
    const cloud = this.deps.cloud();
    this.disarm();
    this.changed();
    if (!cloud) {
      void this.deps.say(HELP_WORDS.okayNotSent);
      return;
    }
    request.okayInFlight = true;
    try {
      const view = await withDeadline(this.deps.clock, HELP_CALL_DEADLINE_MS, (signal) => cloud.helpOkay(request.view.help_id, signal));
      if (this.request === request) this.close(view);
    } catch (error) {
      const kind = failureKind(error);
      this.deps.log.warn("help: okay not sent", { kind });
      if (this.request !== request) return;
      // Closed already: by a caretaker (with_her), or by an earlier try of hers that got through (okay).
      if (kind === "help_closed" && error instanceof CloudError && error.help?.closed) this.close(error.help);
      else if (kind !== "cancelled") void this.deps.say(HELP_WORDS.okayNotSent);
      if (kind === "unauthorized") this.deps.unauthorized();
    } finally {
      request.okayInFlight = false;
    }
  }

  /** Closed: its line once, `closed` for HELP_RESULT_SHOWN_MS, then back. Only for a request seen open in this run. */
  private close(view: HelpView): void {
    if (!view.closed || this.closedSaid.has(view.help_id) || !this.seenOpen.has(view.help_id)) return;
    remember(this.closedSaid, view.help_id);
    this.endRequest();
    const cancel = this.deps.clock.setTimeout(() => {
      if (this.request.kind === "closed" && this.request.cancel === cancel) this.toIdle();
    }, HELP_RESULT_SHOWN_MS);
    this.request = { kind: "closed", view, cancel };
    const closed = view.closed;
    this.deps.log.info("help: closed", { help_id: view.help_id, how: closed.how });
    const line =
      closed.how === "okay"
        ? HELP_WORDS.closedOkay(names(view.sent_to))
        : closed.how === "with_her" && closed.by
          ? HELP_WORDS.closedWithHer(closed.by.name)
          : HELP_WORDS.expired;
    void this.deps.say(line);
    this.changed();
  }

  // ---- Polling ----

  /** After each heartbeat that succeeded, and every HELP_POLL_MS while a request is open or sending. */
  poll(): void {
    const cloud = this.deps.cloud();
    const now = this.deps.clock.monotonic();
    if (!cloud || this.pollInFlight || this.stopped || now < this.statusRetryAt) return;
    this.pollInFlight = true;
    void (async () => {
      try {
        const view = await withDeadline(this.deps.clock, HELP_CALL_DEADLINE_MS, (signal) => cloud.helpStatus(signal));
        if (cloud !== this.deps.cloud() || this.stopped) return;
        this.supported = true;
        this.status(view);
      } catch (error) {
        const kind = failureKind(error);
        // The network is the heartbeat's business; anything else (an older server's 404) waits a minute.
        if (kind === "not_found") this.olderServer();
        else if (kind !== "network" && kind !== "cancelled") {
          this.statusRetryAt = this.deps.clock.monotonic() + HELP_STATUS_RETRY_MS;
          this.deps.log.warn("help: couldn't read the help status; trying again in a minute", { kind });
        }
      } finally {
        this.pollInFlight = false;
      }
    })();
  }

  private olderServer(): void {
    this.supported = false;
    this.statusRetryAt = this.deps.clock.monotonic() + HELP_STATUS_RETRY_MS;
    this.deps.log.warn("help: this server has no help route (404); asking again in a minute");
  }

  /** What GET /help said. */
  private status(view: HelpView | null): void {
    const request = this.request;
    if (!view) {
      if (request.kind === "open") {
        this.deps.log.info("help: the open request is gone from the server");
        this.toIdle();
      }
      return;
    }
    if (!view.closed) {
      if (request.kind === "open" && request.view.help_id === view.help_id) {
        request.view = view;
        this.newsFrom(view);
        this.changed();
        return;
      }
      // Sending (its answer was lost), nothing, a result showing, or another request: this one is open now.
      this.adopt(view);
      return;
    }
    if (this.seenOpen.has(view.help_id)) {
      this.close(view);
      return;
    }
    // The newest is closed and isn't one this walker saw open: whatever was open here is gone.
    if (request.kind === "open") this.toIdle();
  }

  private schedulePoll(): void {
    if (this.cancelPoll || this.stopped) return;
    this.cancelPoll = this.deps.clock.setTimeout(() => {
      this.cancelPoll = null;
      if (this.request.kind !== "open" && this.request.kind !== "sending") return;
      this.poll();
      this.schedulePoll();
    }, HELP_POLL_MS);
  }

  // ---- State ----

  private endRequest(): void {
    const request = this.request;
    if (request.kind === "sending" || request.kind === "not_sent" || request.kind === "closed") request.cancel?.();
    if (request.kind === "open") request.cancelArm?.();
    this.request = { kind: "idle" };
  }

  private toIdle(): void {
    this.endRequest();
    this.cancelPoll?.();
    this.cancelPoll = null;
    this.changed();
    this.deps.quiet();
  }

  /**
   * Unpaired, a 401, or another walker's credential: help leaves the screen and polling stops. With `server`
   * (a different server or walker), what was learned about the server is forgotten too.
   */
  reset(server: boolean): void {
    this.endGesture();
    this.toIdle();
    if (server) {
      this.supported = false;
      this.statusRetryAt = 0;
      this.seenOpen.clear();
      this.closedSaid.clear();
      this.shownSaid.clear();
      this.comingSaid.clear();
    }
  }

  stop(): void {
    this.endGesture();
    this.endRequest();
    this.cancelPoll?.();
    this.cancelPoll = null;
    this.stopped = true;
  }

  /** What the help layer shows now. */
  screen(): HelpScreen | null {
    const gesture = this.gesture;
    if (gesture?.kind === "hold") return { state: "help_hold" };
    if (gesture?.kind === "countdown") return { state: "help_countdown", seconds_left: gesture.left };
    const request = this.request;
    switch (request.kind) {
      case "idle":
        return null;
      case "sending":
        return { state: "help", help: { phase: "sending", retrying: request.retrying } };
      case "not_sent":
        return { state: "help", help: { phase: "not_sent", why: request.why } };
      case "open": {
        const view = request.view;
        const armed = request.armedUntil !== null && this.deps.clock.monotonic() < request.armedUntil;
        return { state: "help", help: { phase: "open", sent_to: names(view.sent_to), shown_to: names(view.shown_to), coming: names(view.coming), confirm_okay: armed } };
      }
      case "closed":
        return { state: "help", help: { phase: "closed", how: request.view.closed!.how, by_name: request.view.closed!.by?.name ?? null, sent_to: request.view.sent_to.map((p) => p.name) } };
    }
  }

  /** Sends the screen when it changed, and tells the service when Confirm's owner changed. */
  private changed(): void {
    if (this.stopped) return;
    const screen = this.screen();
    const key = JSON.stringify(screen);
    if (key !== this.lastScreen) {
      this.lastScreen = key;
      this.deps.bus.emit("help", { screen });
    }
    const owns = this.ownsConfirm();
    if (owns !== this.owns) {
      this.owns = owns;
      this.deps.ownsConfirmChanged(owns);
    }
  }
}
