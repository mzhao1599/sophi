import {
  sameCues,
  type ProposalView,
  type WalkerActivityView,
  type WalkerModel,
  type WalkerStatusView,
  type WalkerTurnInFlight,
  type WalkerTurnTrace,
  type WalkerTurnView,
} from "@walker/contracts";
import type { ProposalCard } from "./walkerView";

/**
 * "Behind the scenes": the steps of the walker's latest turn as the server saw them, for the /walker page.
 * Pure, so it can be unit tested. It reads only evidence: the activity view (what the server measured,
 * page only), the status view, and the offer card the page already holds. A station is listed only once
 * its evidence is here, and every time shown is the server's own measurement; the page never times
 * anything. The server only knows what it sent, so nothing here says a reply was spoken, heard or played.
 * Expected results: `apps/web/test/walker-page.EXPECTED.md` ("Behind the scenes").
 */

/** An in-flight turn this old (on the server's clock) is dropped as stale: the server should have ended it. */
export const IN_FLIGHT_STALE_MS = 10_000;
/** How often the page polls while a turn is in flight. */
export const FAST_POLL_MS = 700;
/** When several stations arrive in one poll, each inks this long after the one before. */
export const INK_STAGGER_MS = 180;

export const CAPTION = "Drawn as each step's evidence reaches this page. Times are measured.";
export const NO_TIMINGS = "No timings for this turn";
export const NOTHING_YET = "Nothing yet. Each turn is drawn here as it happens.";

export type StageId = "sent" | "transcribe" | "model" | "rules" | "reply" | "voice" | "offer" | "confirm" | "recorded" | "applied";

/** done: finished; live: what the server or the walker is waiting on now; end: the line stops here (an offer that changed nothing). */
export type StageState = "done" | "live" | "end";

export interface Stage {
  id: StageId;
  /** The short name on the drawing ("Cartesia", "Claude"). */
  label: string;
  /** The measured figure or fact under it ("2.1 s"). */
  figure: string;
  state: StageState;
  /** The whole station as one sentence, for screen readers. */
  sentence: string;
}

export interface BehindView {
  /** Which turn is drawn (its client_turn_id); a new key means a new turn, drawn from scratch. null with nothing to draw. */
  key: string | null;
  /** "Turn in progress", "Latest turn". */
  title: string;
  stages: Stage[];
  /** measured: a trace or an in-flight entry; pending: the trace is on its way; none: status only; empty: no turn. */
  timing: "measured" | "pending" | "none" | "empty";
  /** The server's measured time for the whole turn, when known. */
  totalMs: number | null;
}

export interface BehindInput {
  status: WalkerStatusView;
  /** This walker's activity from the last applied poll; undefined when the server sent none. */
  activity: WalkerActivityView | undefined;
  /** The page's offer card, which keeps a proposal after it closes. */
  card: ProposalCard | null;
  /** The client_turn_id of a question this page is sending now, if any. */
  ownTurnId: string | null;
  /** Now, on the server's clock. */
  nowMs: number;
}

// ---- Wording ----

/** 640 → "640 ms"; 2140 → "2.1 s". */
export function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The same, for a sentence read aloud: "640 milliseconds", "2.1 seconds". */
export function spokenMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  const s = (ms / 1000).toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s} seconds`;
}

/** A model call that didn't give a usable answer: the figure, and the same for a sentence. */
function modelFailed(rule: string, ms: number | null): { figure: string; spoken: string } | null {
  const after = (verb: string) => (ms === null ? { figure: verb, spoken: verb } : { figure: `${verb} after ${formatMs(ms)}`, spoken: `${verb} after ${spokenMs(ms)}` });
  switch (rule) {
    case "timeout":
      return after("timed out");
    case "model_error":
      return after("failed");
    case "refusal":
      return { figure: "declined to answer", spoken: "declined to answer" };
    case "invalid_reply":
      return { figure: "gave no usable reply", spoken: "gave no usable reply" };
  }
  return null;
}

const FIXED_REPLY_CODES = new Set(["timeout", "model_error", "refusal", "invalid_reply", "no_model", "not_heard", "cant_hear"]);

/**
 * The model's short name, from what the server said ran. Null (no model) or a missing field (a server
 * older than 2026-10-24) names none.
 */
export function modelName(model: WalkerModel | null | undefined): string {
  return model === "claude" ? "Claude" : "The model";
}

/** The rule that decided the reply, in plain words. `name` is the model that answered ("Claude"). */
export function ruleWords(rule: string | null, proposalOpened: boolean, name = "Claude"): string {
  if (rule === null) return proposalOpened ? "Change allowed" : `${name}'s own words`;
  switch (rule) {
    case "arms":
      return "Fixed line: no robot arms";
    case "cues_alerts_off":
      return "Refused: alerts keep a buzz or sound";
    case "cues_unchanged":
      return "Refused: alerts already set";
    case "cues_undeliverable":
      return "Refused: no part can give that alert";
    case "cues_empty":
    case "cues_duplicate":
      return "Refused: not a valid change";
    case "offline":
      return "Refused: walker offline";
    case "not_heard":
      return "Fixed line: no words heard";
    case "cant_hear":
      return "Fixed line: couldn't hear the clip";
  }
  return FIXED_REPLY_CODES.has(rule) ? "Fixed reply" : `Fixed reply (${rule})`;
}

type Source = "walker" | "page" | "unknown";

function sentStage(source: Source, input: "audio" | "text", clipMs: number | null): Stage {
  const label = source === "walker" ? "Walker sent" : source === "page" ? "Page sent" : "Sent";
  if (input === "audio") {
    return {
      id: "sent",
      label,
      figure: clipMs === null ? "audio" : `${formatMs(clipMs)} of audio`,
      state: "done",
      sentence: clipMs === null ? "The walker sent an audio clip." : `The walker sent ${spokenMs(clipMs)} of audio.`,
    };
  }
  const who = source === "walker" ? "The walker sent" : source === "page" ? "This page sent" : "Someone sent";
  return { id: "sent", label, figure: "typed", state: "done", sentence: `${who} a typed question.` };
}

/**
 * Cartesia writing down a clip: `ms` is its measured time, null when the server doesn't say. `rule`
 * not_heard: it made out no words; cant_hear: it answered with nothing usable (an error or its time limit).
 */
function transcribeStage(rule: string | null, ms: number | null): Stage {
  const took = ms === null ? null : { figure: formatMs(ms), spoken: spokenMs(ms) };
  if (rule === "not_heard") {
    return { id: "transcribe", label: "Cartesia", figure: took ? `No words, ${took.figure}` : "No words", state: "done", sentence: took ? `Cartesia made out no words in ${took.spoken}.` : "Cartesia made out no words." };
  }
  if (rule === "cant_hear") {
    return { id: "transcribe", label: "Cartesia", figure: took ? `No transcript after ${took.figure}` : "No transcript", state: "done", sentence: took ? `Cartesia gave no transcript after ${took.spoken}.` : "Cartesia gave no transcript." };
  }
  return { id: "transcribe", label: "Cartesia", figure: took ? took.figure : "Wrote down the clip", state: "done", sentence: took ? `Cartesia wrote down the clip in ${took.spoken}.` : "Cartesia wrote down the clip." };
}

function modelStage(input: "audio" | "text", rule: string | null, modelMs: number | null, name: string): Stage {
  const failed = rule !== null ? modelFailed(rule, modelMs) : null;
  if (failed) return { id: "model", label: name, figure: failed.figure, state: "done", sentence: `${name} ${failed.spoken}.` };
  const how = input === "audio" ? "read what was said and wrote an answer" : "read the question and wrote an answer";
  if (modelMs === null) return { id: "model", label: name, figure: "ran", state: "done", sentence: `${name} ${how}.` };
  return { id: "model", label: name, figure: formatMs(modelMs), state: "done", sentence: `${name} ${how} in ${spokenMs(modelMs)}.` };
}

function rulesStage(words: string): Stage {
  return { id: "rules", label: "Rules", figure: words, state: "done", sentence: `Rules: ${words}.` };
}

function replyStage(proposalOpened: boolean, source: Source): Stage {
  const figure = proposalOpened ? "Offer written by the server" : source === "page" ? "Text sent to this page" : "Text sent to the walker";
  return { id: "reply", label: "Reply", figure, state: "done", sentence: `Reply: ${figure}.` };
}

function voiceStage(by: "cartesia" | "walker", voiceMs: number | null): Stage {
  if (by === "cartesia") {
    return {
      id: "voice",
      label: "Voice",
      figure: voiceMs === null ? "Sent in Cartesia's voice" : `Sent in Cartesia's voice, ${formatMs(voiceMs)}`,
      state: "done",
      sentence: voiceMs === null ? "The reply was sent in Cartesia's voice." : `The reply was sent in Cartesia's voice, made in ${spokenMs(voiceMs)}.`,
    };
  }
  return { id: "voice", label: "Voice", figure: "Walker's own voice", state: "done", sentence: "No audio was sent: the walker reads the reply in its own voice." };
}

// ---- The offer a turn opened ----

type OfferState = "open" | "confirmed" | "declined" | "expired" | "superseded" | "closed";

/** The offer this turn opened and how it stands, from the status and the page's card; null when the page doesn't know it. */
export function offerOf(clientTurnId: string, status: WalkerStatusView, card: ProposalCard | null, nowMs: number): { proposal: ProposalView; state: OfferState } | null {
  const open = status.open_proposal;
  if (open?.client_turn_id === clientTurnId) return { proposal: open, state: "open" };
  const p = card?.proposal;
  if (!p || p.client_turn_id !== clientTurnId) return null;
  if (p.state !== "open") return { proposal: p, state: p.state };
  // Closed without this page answering: the same reading as walkerView's closedOutcome.
  if (status.configuration.version === p.base_configuration_version + 1 && sameCues(status.configuration.cues, p.cues)) return { proposal: p, state: "confirmed" };
  if (open && open.proposal_id !== p.proposal_id) return { proposal: p, state: "superseded" };
  const unchanged = status.configuration.version === p.base_configuration_version;
  if (unchanged && (nowMs >= Date.parse(p.expires_at) || !status.online)) return { proposal: p, state: "expired" };
  return { proposal: p, state: "closed" };
}

const OFFER_END: Record<Exclude<OfferState, "open" | "confirmed">, string> = {
  declined: "Declined: nothing changed",
  expired: "Expired: nothing changed",
  superseded: "Replaced by a newer offer",
  closed: "No longer open",
};

function offerStages(offer: { proposal: ProposalView; state: OfferState }, status: WalkerStatusView): Stage[] {
  const { proposal: p, state } = offer;
  if (state === "open") return [{ id: "offer", label: "Offer", figure: "Waiting for Confirm", state: "live", sentence: "The offer is waiting for someone to press Confirm." }];
  if (state !== "confirmed") return [{ id: "offer", label: "Offer", figure: OFFER_END[state], state: "end", sentence: `The offer closed: ${OFFER_END[state]}.` }];
  const stages: Stage[] = [
    { id: "offer", label: "Offer", figure: "Confirmed", state: "done", sentence: "The offer was confirmed." },
    { id: "confirm", label: "Confirm", figure: "Button press, not voice", state: "done", sentence: "Confirmed by a button press, not by voice." },
  ];
  const version = p.configuration_version ?? p.base_configuration_version + 1;
  if (status.configuration.version < version) return stages;
  stages.push({ id: "recorded", label: `Recorded v${version}`, figure: "Saved on the server", state: "done", sentence: `The server saved it as alert settings version ${version}.` });
  const applied = status.applied_configuration_version !== null && status.applied_configuration_version >= version;
  stages.push(
    applied
      ? { id: "applied", label: "Applied", figure: "Reported by the walker", state: "done", sentence: `The walker reports it applied version ${version}.` }
      : { id: "applied", label: "Walker", figure: "Waiting for the walker", state: "live", sentence: "Waiting for the walker to apply it." },
  );
  return stages;
}

// ---- The turn ----

function inFlightStages(f: WalkerTurnInFlight, ownTurnId: string | null): Stage[] {
  const source: Source = f.client_turn_id === ownTurnId ? "page" : f.input === "audio" ? "walker" : "unknown";
  const sent = sentStage(source, f.input, f.clip_ms);
  if (f.stage === "transcribing") {
    return [sent, { id: "transcribe", label: "Hearing", figure: "Waiting for Cartesia…", state: "live", sentence: "The server is waiting for Cartesia to write down the clip." }];
  }
  if (f.stage === "hearing") {
    // A clip has been written down by now (when the server can hear at all); the model reads the words either way.
    const name = modelName(f.model);
    const who = name === "The model" ? "the model" : name;
    return [sent, { id: "model", label: "Reading", figure: `Waiting for ${who}…`, state: "live", sentence: `The server is waiting for ${who}.` }];
  }
  return [
    sent,
    { id: "model", label: "Reading", figure: "Done", state: "done", sentence: "The server has its answer." },
    { id: "voice", label: "Voice", figure: "Waiting for Cartesia…", state: "live", sentence: "The server is waiting for Cartesia's audio." },
  ];
}

function tracedStages(turn: WalkerTurnView, t: WalkerTurnTrace): Stage[] {
  const stages: Stage[] = [sentStage(turn.source, t.input, t.clip_ms)];
  // Only a trace that measured Cartesia's step draws it (null: not asked; missing: a server from before 2026-10-25).
  if (t.input === "audio" && t.transcribe_ms !== null && t.transcribe_ms !== undefined) stages.push(transcribeStage(t.rule, t.transcribe_ms));
  const name = modelName(t.model);
  if (t.model_ran) stages.push(modelStage(t.input, t.rule, t.model_ms, name));
  stages.push(rulesStage(ruleWords(t.rule, t.proposal_opened, name)), replyStage(t.proposal_opened, turn.source));
  if (t.voiced_by) stages.push(voiceStage(t.voiced_by, t.voice_ms));
  return stages;
}

/** Only what the status view proves: no clip length, no times, no rule code. */
function statusStages(turn: WalkerTurnView, offerKnown: boolean): Stage[] {
  const input = turn.heard_by === "typed" ? "text" : "audio";
  // Without a trace the page can't tell whether a model ran for a fixed reply, so it names one only for the model's own answer.
  const name = "Claude";
  const stages: Stage[] = [sentStage(turn.source, input, null)];
  if (turn.heard_by === "cartesia") stages.push(transcribeStage(null, null));
  if (turn.answered_by === "model") stages.push(modelStage(input, null, null, name));
  stages.push(rulesStage(turn.answered_by === "fixed" ? "Fixed reply" : offerKnown ? "Change allowed" : `${name}'s own words`), replyStage(offerKnown, turn.source));
  if (turn.voiced_by) stages.push(voiceStage(turn.voiced_by, null));
  return stages;
}

/** In-flight entries that are still fresh, newest first. */
export function freshInFlight(activity: WalkerActivityView | undefined, nowMs: number): WalkerTurnInFlight[] {
  return (activity?.in_flight ?? [])
    .filter((f) => nowMs - Date.parse(f.since) < IN_FLIGHT_STALE_MS)
    .sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
}

/** Whether any walker has a fresh in-flight turn: the page then polls faster. */
export function anyInFlight(activity: readonly WalkerActivityView[], nowMs: number): boolean {
  return activity.some((a) => freshInFlight(a, nowMs).length > 0);
}

export function buildStages({ status, activity, card, ownTurnId, nowMs }: BehindInput): BehindView {
  const latest = status.turns.at(-1) ?? null;
  const flying = freshInFlight(activity, nowMs).find((f) => f.client_turn_id !== latest?.client_turn_id);
  if (flying) return { key: flying.client_turn_id, title: "Turn in progress", stages: inFlightStages(flying, ownTurnId), timing: "measured", totalMs: null };
  if (!latest) return { key: null, title: "Latest turn", stages: [], timing: "empty", totalMs: null };

  const trace = activity?.traces.find((t) => t.turn_id === latest.turn_id) ?? null;
  const offer = offerOf(latest.client_turn_id, status, card, nowMs);
  const after = offer ? offerStages(offer, status) : [];
  if (trace) return { key: latest.client_turn_id, title: "Latest turn", stages: [...tracedStages(latest, trace), ...after], timing: "measured", totalMs: trace.total_ms };
  // The poll that brought this activity still had the turn in flight: its trace is on the way.
  const pending = activity?.in_flight.some((f) => f.client_turn_id === latest.client_turn_id) ?? false;
  return { key: latest.client_turn_id, title: "Latest turn", stages: [...statusStages(latest, offer !== null), ...after], timing: pending ? "pending" : "none", totalMs: null };
}
