import {
  OFFLINE_AFTER_MS,
  PAIRING_CODE_TTL_MS,
  PROPOSAL_TTL_MS,
  RECENT_TURNS,
  WALKER_ERROR_STATUS,
  WALKER_HISTORY_RETENTION_MS,
  WALKER_SETUP,
  WalkerActivityViewSchema,
  WalkerStatusViewSchema,
  checkCuesChange,
  type Cue,
  type PairingCodeResponse,
  type PartView,
  type ProposalView,
  type SpeechPace,
  type WalkerConfiguration,
  type WalkerErrorCode,
  type WalkerEventView,
  type WalkerActivityView,
  type WalkerStatusView,
  type WalkerTurnInFlight,
  type WalkerTurnTrace,
  type WalkerTurnView,
  type ZoneView,
} from "@walker/contracts";
import { WalkerApiError, type WalkerPageApi } from "./walkerApi";
import { cueList } from "./walkerView";

/**
 * A fake of the page API for development, so the page can be built and tested before the cloud routes
 * exist, with no server, Pi or model. It keeps one owner's walkers in memory and answers with
 * contract-valid shapes (each status is checked against `WalkerStatusViewSchema`). Its replies are
 * canned, not a model's: the page shows a "Fake walker" banner whenever it's in use, and it's only
 * reachable in development (`/walker?fake=1`). `controls` plays the walker's side: pairing, its own
 * lines, a Talk press, going offline, its Confirm button, and failures. Like the server, it reports each
 * turn's progress (`activity`: in flight, then a trace), with times measured from its own canned pauses.
 */

export type FakeFailure = WalkerErrorCode | "network";

export interface FakeWalkerControls {
  /** The walker runs `walker pair <code>` with the code on screen. False when there's no live code. */
  pairFromWalker(): boolean;
  /** The walker says a fixed line on its own; offline, the line waits for the next heartbeat. */
  walkerSays(text: string, kind: WalkerEventView["kind"]): void;
  setOnline(online: boolean): void;
  setSimulator(simulator: boolean): void;
  /** Unplugs (or plugs back) the obstacle sensors. */
  setSensorsPlugged(plugged: boolean): void;
  /**
   * A Talk press on the walker with these words (as if Cartesia heard them from a clip): in flight while
   * "hearing" and "voicing", then saved with a trace. False while the walker is offline (it answers on its own then).
   */
  walkerTalks(words: string): boolean;
  /** The walker's own Confirm button. */
  confirmOnWalker(): boolean;
  /** Brings the open proposal's expiry to a few seconds from now. */
  expireSoon(seconds: number): boolean;
  /** The browser loses its owner cookie. */
  clearCookie(): void;
  /** The next action (a code, a turn, an answer, a forget) fails with this. Polls don't take it. */
  failNext(failure: FakeFailure): void;
  /** Every request fails as if the network were down, until it's turned back on. */
  setServerDown(down: boolean): void;
  /** What the fake holds now, for the controls panel. */
  snapshot(): { paired: number; online: boolean; codeLive: boolean; proposalOpen: boolean; pendingFailure: FakeFailure | null };
}

interface FakeWalker {
  device_id: string;
  name: string;
  online: boolean;
  lastSeenMs: number;
  simulator: boolean;
  sensorsPlugged: boolean;
  configurations: WalkerConfiguration[];
  /** The walker applies a new version one heartbeat after it appears. */
  appliedVersion: number;
  appliesAtMs: number;
  turns: WalkerTurnView[];
  said: WalkerEventView[];
  /** Lines said while offline, delivered with the first heartbeat back. */
  queued: { event: WalkerEventView; saidAtMs: number }[];
  proposal: ProposalView | null;
  /** Proposals a newer one replaced, so answering one gets `409 proposal_closed` like the server. */
  replaced: ProposalView[];
  inFlight: WalkerTurnInFlight[];
  traces: WalkerTurnTrace[];
  /** Set only from the page here: the fake's typed turns don't change it. */
  pace: SpeechPace;
}

const iso = (ms: number) => new Date(ms).toISOString();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const APPLY_DELAY_MS = 2_500;
/** A canned pause of about `ms`, a little different each time, as a real model's would be. */
const jitter = (ms: number) => Math.round(ms * (0.8 + 0.4 * Math.random()));

function fail(code: FakeFailure, proposal?: ProposalView): never {
  if (code === "network") throw new WalkerApiError("network", "Couldn't reach the server.", 0);
  throw new WalkerApiError(code, `Fake ${code}.`, WALKER_ERROR_STATUS[code], proposal);
}

export function createFakeWalker(now: () => number = Date.now, delays = true): { api: WalkerPageApi; controls: FakeWalkerControls } {
  let owner = false;
  let code: PairingCodeResponse | null = null;
  let pending: FakeFailure | null = null;
  let down = false;
  const walkers: FakeWalker[] = [];
  const pause = (ms: number) => (delays ? wait(ms) : Promise.resolve());

  function takeFailure() {
    if (down) fail("network");
    const f = pending;
    pending = null;
    if (f) fail(f);
  }

  function current(w: FakeWalker) {
    return w.configurations.at(-1)!;
  }

  /** Expiry happens on read, like the server: past its time, or with the walker offline. */
  function settle(w: FakeWalker, t: number) {
    if (w.online) w.lastSeenMs = t;
    if (w.proposal?.state === "open" && (t >= Date.parse(w.proposal.expires_at) || !w.online)) w.proposal = { ...w.proposal, state: "expired" };
    if (w.online && w.appliedVersion < current(w).version && t >= w.appliesAtMs) w.appliedVersion = current(w).version;
    const cutoff = t - 60 * 60_000;
    w.turns = w.turns.filter((turn) => Date.parse(turn.created_at) >= cutoff);
    w.said = w.said.filter((e) => Date.parse(e.at) >= cutoff);
    w.traces = w.traces.filter((tr) => Date.parse(tr.at) >= t - WALKER_HISTORY_RETENTION_MS).slice(-RECENT_TURNS);
  }

  function activity(w: FakeWalker): WalkerActivityView {
    return WalkerActivityViewSchema.parse({ device_id: w.device_id, in_flight: w.inFlight.slice(-4), traces: w.traces });
  }

  function parts(w: FakeWalker): PartView[] {
    const ids = current(w).selected_module_ids;
    const instance: Record<string, string> = {
      "base.walker": "pi-01",
      "controls.hand": "hand-left-01",
      "perception.tof": "tof-front-01",
      voice: "voice-01",
    };
    // The simulator stands in for the hand controls and the sensors; its microphone and speaker are the laptop's own.
    const simulated = (id: string) => w.simulator && (id === "controls.hand" || id === "perception.tof");
    return ids.map((id) => {
      const unplugged = id === "perception.tof" && !w.sensorsPlugged;
      return {
        module_id: id,
        instance_id: unplugged ? null : (instance[id] ?? null),
        health: !w.online || unplugged ? "unavailable" : "ok",
        simulated: simulated(id),
        in_configuration: true,
      } satisfies PartView;
    });
  }

  function zones(w: FakeWalker, t: number): ZoneView[] {
    if (!w.sensorsPlugged) return [];
    const simulated = w.simulator;
    if (!w.online) {
      return ["front", "front_left"].map((zone) => ({ zone, instance_id: "tof-front-01", simulated, reading: { status: "unknown", reason: "stale" } }));
    }
    // A slow sweep, as if something moved toward the walker and away again.
    const mm = Math.round(900 + 600 * Math.sin(t / 4000));
    return [
      { zone: "front", instance_id: "tof-front-01", simulated, reading: { status: "measured", mm, age_ms: 300 + (t % 900) } },
      { zone: "front_left", instance_id: "tof-front-01", simulated, reading: { status: "unknown", reason: "invalid" } },
    ];
  }

  function status(w: FakeWalker): WalkerStatusView {
    const t = now();
    settle(w, t);
    const open = w.proposal?.state === "open" ? w.proposal : null;
    return WalkerStatusViewSchema.parse({
      device_id: w.device_id,
      name: w.name,
      online: w.online,
      last_seen_at: iso(w.lastSeenMs),
      simulator: w.simulator,
      configuration: current(w),
      applied_configuration_version: w.appliedVersion,
      parts: parts(w),
      zones: zones(w, t),
      open_proposal: open,
      turns: w.turns.slice(-RECENT_TURNS),
      walker_said: w.said.slice(-RECENT_TURNS),
    });
  }

  function find(id: string): FakeWalker {
    const w = walkers.find((x) => x.device_id === id);
    if (!owner || !w) fail(owner ? "not_found" : "unauthenticated");
    return w;
  }

  function newConfiguration(w: FakeWalker, cues: Cue[]): WalkerConfiguration {
    const before = current(w);
    const next = { ...before, version: before.version + 1, cues, created_at: iso(now()) };
    w.configurations.push(next);
    w.appliesAtMs = now() + APPLY_DELAY_MS;
    return next;
  }

  function confirm(w: FakeWalker): ProposalView | null {
    const p = w.proposal;
    if (!p || p.state !== "open") return null;
    const next = newConfiguration(w, p.cues);
    w.proposal = { ...p, state: "confirmed", configuration_version: next.version };
    return w.proposal;
  }

  /** Canned replies by topic. Not a model: the banner says so. */
  function reply(w: FakeWalker, text: string): { reply: string; answered_by: "model" | "fixed"; rule: string | null; proposal: ProposalView | null } {
    const lower = text.toLowerCase();
    const cues = current(w).cues;
    if (/(turn|switch) off (all |the |my )?alerts|no alerts|silence/.test(lower)) {
      return {
        reply: "While the obstacle sensors are on, your alerts keep buzzing or short sounds, so I'll leave them as they are.",
        answered_by: "fixed",
        rule: "cues_alerts_off",
        proposal: null,
      };
    }
    if (/buzz|vibrat|short sound/.test(lower)) {
      const next: Cue[] = cues.includes("vibration") ? cues.map((c) => (c === "vibration" ? "sound" : c)) : cues.map((c) => (c === "sound" ? "vibration" : c));
      if (checkCuesChange(cues, next, current(w).selected_module_ids) === null) {
        const t = now();
        const proposal: ProposalView = {
          proposal_id: crypto.randomUUID(),
          client_turn_id: crypto.randomUUID(),
          kind: "cues_change",
          from_cues: cues,
          cues: next,
          base_configuration_version: current(w).version,
          summary: `Switch your alerts to ${cueList(next).toLowerCase()}.`,
          state: "open",
          created_at: iso(t),
          expires_at: iso(t + PROPOSAL_TTL_MS),
          configuration_version: null,
        };
        return {
          reply: `I can switch your alerts from ${cues.includes("vibration") ? "buzzing to short sounds" : "short sounds to buzzing"}. Press Confirm to do it.`,
          answered_by: "model",
          rule: null,
          proposal,
        };
      }
    }
    if (/arm|pick|keys/.test(lower)) return { reply: "The robot arms aren't on this walker, so I can't pick things up.", answered_by: "fixed", rule: "arms", proposal: null };
    if (/front|obstacle|anything|ahead/.test(lower)) {
      const front = zones(w, now()).find((z) => z.zone === "front");
      const measured = front?.reading.status === "measured" ? `about ${Math.round(front.reading.mm / 10)} centimetres, measured just now` : "unknown right now";
      const sim = front?.simulated ? " These readings are simulated." : "";
      return { reply: `Your front sensor reads ${measured}.${sim}`, answered_by: "model", rule: null, proposal: null };
    }
    return {
      reply: "I can tell you what's in front of you, which parts are working, and change how alerts reach you.",
      answered_by: "model",
      rule: null,
      proposal: null,
    };
  }

  /**
   * One turn as the server runs it: for a walker clip, in flight while Cartesia "transcribes" it; then while the
   * model "hears" (and, for a clip, while the voice is made); then saved with its trace. The times are the fake's
   * own pauses, measured.
   */
  async function runTurn(w: FakeWalker, clientTurnId: string, words: string, source: "walker" | "page") {
    const audio = source === "walker";
    const accepted = now();
    const clip_ms = audio ? Math.min(15_000, 900 + words.length * 45) : null;
    const flight: WalkerTurnInFlight = { client_turn_id: clientTurnId, input: audio ? "audio" : "text", since: iso(accepted), clip_ms, stage: audio ? "transcribing" : "hearing", model: "claude" };
    w.inFlight.push(flight);
    try {
      let transcribe_ms: number | null = null;
      if (audio) {
        await pause(jitter(500));
        transcribe_ms = now() - accepted;
        flight.stage = "hearing";
      }
      const asked = now();
      await pause(jitter(audio ? 1_100 : 800));
      const model_ms = now() - asked;
      const r = reply(w, words);
      let voice_ms: number | null = null;
      if (audio) {
        flight.stage = "voicing";
        const voicing = now();
        await pause(jitter(650));
        voice_ms = now() - voicing;
      }
      if (r.proposal) {
        if (w.proposal?.state === "open") w.replaced.push({ ...w.proposal, state: "superseded" });
        // Like the server, the offer names the turn that made it.
        w.proposal = { ...r.proposal, client_turn_id: clientTurnId, created_at: iso(now()), expires_at: iso(now() + PROPOSAL_TTL_MS) };
      }
      const turn: WalkerTurnView = {
        turn_id: crypto.randomUUID(),
        client_turn_id: clientTurnId,
        source,
        heard: words.trim(),
        heard_by: audio ? "cartesia" : "typed",
        reply: r.reply,
        answered_by: r.answered_by,
        voiced_by: audio ? "cartesia" : null,
        created_at: iso(now()),
      };
      w.turns.push(turn);
      w.traces.push({
        turn_id: turn.turn_id,
        client_turn_id: clientTurnId,
        at: turn.created_at,
        input: flight.input,
        clip_ms,
        model_ran: true,
        model: "claude",
        model_ms,
        transcribe_ms,
        rule: r.rule,
        answered_by: r.answered_by,
        proposal_opened: r.proposal !== null,
        voiced_by: turn.voiced_by,
        voice_ms,
        total_ms: now() - accepted,
      });
      return { turn, proposal: r.proposal ? w.proposal : null };
    } finally {
      w.inFlight = w.inFlight.filter((f) => f !== flight);
    }
  }

  const seen = new Map<string, { turn: WalkerTurnView; proposal: ProposalView | null }>();

  const api: WalkerPageApi = {
    async listWalkers() {
      await pause(120);
      if (down) fail("network");
      if (!owner) fail("unauthenticated");
      return { walkers: walkers.map(status), activity: walkers.map(activity), speech_paces: walkers.map((w) => ({ device_id: w.device_id, speech_pace: w.pace })) };
    },
    async createPairingCode() {
      await pause(300);
      takeFailure();
      owner = true;
      const t = now();
      code = { code: String(100_000 + Math.floor(Math.random() * 900_000)), expires_at: iso(t + PAIRING_CODE_TTL_MS) };
      return code;
    },
    async sendTurn(deviceId, clientTurnId, text) {
      await pause(100);
      takeFailure();
      const w = find(deviceId);
      const replay = seen.get(clientTurnId);
      if (replay) return { turn: replay.turn, proposal: replay.proposal, speech: null, status: status(w) };
      const done = await runTurn(w, clientTurnId, text, "page");
      seen.set(clientTurnId, done);
      return { ...done, speech: null, status: status(w) };
    },
    async answerProposal(deviceId, proposalId, answer) {
      await pause(300);
      takeFailure();
      const w = find(deviceId);
      settle(w, now());
      const p = w.proposal?.proposal_id === proposalId ? w.proposal : w.replaced.find((x) => x.proposal_id === proposalId);
      if (!p) fail("not_found");
      if (p.state !== "open") fail("proposal_closed", p);
      const done = answer === "confirm" ? confirm(w)! : (w.proposal = { ...p, state: "declined" });
      return { proposal: done, status: status(w) };
    },
    async setSpeechPace(deviceId, pace) {
      await pause(200);
      takeFailure();
      const w = find(deviceId);
      w.pace = pace;
      return { speech_pace: pace };
    },
    async forgetWalker(deviceId) {
      await pause(200);
      takeFailure();
      const w = find(deviceId);
      walkers.splice(walkers.indexOf(w), 1);
    },
    clockOffsetMs: () => 0,
  };

  const live = () => walkers[0];

  const controls: FakeWalkerControls = {
    pairFromWalker() {
      const t = now();
      if (!code || t >= Date.parse(code.expires_at)) return false;
      code = null;
      const configuration: WalkerConfiguration = { version: 1, ...WALKER_SETUP, cues: [...WALKER_SETUP.cues], selected_module_ids: [...WALKER_SETUP.selected_module_ids], created_at: iso(t) };
      walkers.unshift({
        device_id: crypto.randomUUID(),
        name: "Sophi walker",
        online: true,
        lastSeenMs: t,
        simulator: true,
        sensorsPlugged: true,
        configurations: [configuration],
        appliedVersion: 1,
        appliesAtMs: t,
        turns: [],
        said: [{ event_id: crypto.randomUUID(), kind: "notice", text: "Sophi is on.", at: iso(t) }],
        queued: [],
        proposal: null,
        replaced: [],
        inFlight: [],
        traces: [],
        pace: "normal",
      });
      return true;
    },
    walkerSays(text, kind) {
      const w = live();
      if (!w) return;
      const event: WalkerEventView = { event_id: crypto.randomUUID(), kind, text, at: iso(now()) };
      if (w.online) w.said.push(event);
      else w.queued.push({ event, saidAtMs: now() });
    },
    setOnline(online) {
      const w = live();
      if (!w || w.online === online) return;
      const t = now();
      settle(w, t);
      if (!online) {
        // The server notices only after OFFLINE_AFTER_MS without a heartbeat; the fake jumps straight there.
        w.lastSeenMs = t - OFFLINE_AFTER_MS;
        w.online = false;
        settle(w, t);
        return;
      }
      w.online = true;
      for (const q of w.queued) w.said.push({ ...q.event, at: iso(q.saidAtMs) });
      w.queued = [];
      w.said.push({ event_id: crypto.randomUUID(), kind: "notice", text: "I'm back online.", at: iso(t) });
      w.said.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    },
    setSimulator(simulator) {
      const w = live();
      if (w) w.simulator = simulator;
    },
    setSensorsPlugged(plugged) {
      const w = live();
      if (w) w.sensorsPlugged = plugged;
    },
    walkerTalks(words) {
      const w = live();
      if (!w || !w.online) return false;
      void runTurn(w, crypto.randomUUID(), words, "walker");
      return true;
    },
    confirmOnWalker() {
      const w = live();
      if (!w) return false;
      settle(w, now());
      return confirm(w) !== null;
    },
    expireSoon(seconds) {
      const w = live();
      if (!w) return false;
      settle(w, now());
      if (w.proposal?.state !== "open") return false;
      const at = Math.max(Date.parse(w.proposal.created_at) + 1, now() + seconds * 1000);
      w.proposal = { ...w.proposal, expires_at: iso(at) };
      return true;
    },
    clearCookie() {
      owner = false;
      walkers.splice(0);
    },
    failNext(failure) {
      pending = failure;
    },
    setServerDown(value) {
      down = value;
    },
    snapshot() {
      const w = live();
      if (w) settle(w, now());
      return {
        paired: walkers.length,
        online: w?.online ?? false,
        codeLive: Boolean(code && now() < Date.parse(code.expires_at)),
        proposalOpen: w?.proposal?.state === "open",
        pendingFailure: pending,
      };
    },
  };

  return { api, controls };
}
