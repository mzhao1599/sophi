import { HELP_COUNTDOWN_MS, HELP_RETENTION_MS, helpNames, type HelpSource, type HelpView, type WalkerTurnView } from "@walker/contracts";
import type { CircleStore, HelpAnswer, HelpAnswerResult, HelpAskResult, HelpPersonRecord, HelpRecord } from "./store";

/**
 * Asking for help (docs/subsystems/help.md): the projection every caller sees, the store steps with their log
 * line, the server's fixed voice lines and the model's one context line. Shared by WalkerService (the walker's
 * routes and turns, walker envelope) and CircleService (the phones' routes, circle envelope).
 */

const viewPerson = (p: HelpPersonRecord) => ({ member_id: p.member_id, name: p.name });

/** The request as the walker and every phone see it: no exact times, no location, no retry ids. */
export function helpView(h: HelpRecord, now: Date): HelpView {
  const age = Math.floor((now.getTime() - Date.parse(h.created_at)) / 1_000);
  return {
    help_id: h.help_id,
    source: h.source,
    age_seconds: Math.min(Math.max(0, Number.isFinite(age) ? age : 0), HELP_RETENTION_MS / 1_000),
    sent_to: h.sent_to.map(viewPerson),
    shown_to: h.shown_to.map(viewPerson),
    coming: h.coming.map(viewPerson),
    closed: h.closed ? { how: h.closed.how, by: h.closed.by ? viewPerson(h.closed.by) : null } : null,
  };
}

/** One line per ask or answer, for the log: ids, how, the outcome and timings. Never a name or a location. */
export interface HelpEvent {
  device_id: string;
  help_id: string | null;
  action: "ask" | "coming" | "okay";
  /** Where it came from: the ask's source, or who answered (the walker, her phone, a caretaker's phone). */
  via: HelpSource | "walker" | "walker_user" | "caregiver";
  outcome: HelpAskResult["outcome"] | HelpAnswerResult["outcome"];
  /** How many caretaker phones it was sent to (a count, never names). */
  sent_to: number | null;
  /** Time since she asked, by the server's clock. */
  age_ms: number | null;
  /** Time the store step took. */
  ms: number;
}

export function logHelp(e: HelpEvent) {
  console.info(
    `[circle] help action=${e.action} device=${e.device_id} help=${e.help_id ?? "-"} via=${e.via} outcome=${e.outcome} sent_to=${e.sent_to ?? "-"} age_ms=${e.age_ms ?? "-"} ms=${e.ms}`,
  );
}

function event(deviceId: string, action: HelpEvent["action"], via: HelpEvent["via"], result: HelpAskResult | HelpAnswerResult, now: Date, started: number): HelpEvent {
  const help = "help" in result ? result.help : null;
  return {
    device_id: deviceId,
    help_id: help?.help_id ?? null,
    action,
    via,
    outcome: result.outcome,
    sent_to: help?.sent_to.length ?? null,
    age_ms: help ? now.getTime() - Date.parse(help.created_at) : null,
    ms: Date.now() - started,
  };
}

/** She asks, from the walker (`askerId` null) or her phone. The caller has found the walker and checked the caller. */
export async function askForHelp(
  store: CircleStore,
  ask: { help_id: string; device_id: string; client_help_id: string; source: HelpSource; asked_by_member_id: string | null },
  now: Date,
  onHelp: (event: HelpEvent) => void,
): Promise<HelpAskResult> {
  const started = Date.now();
  const result = await store.askForHelp({ ...ask, created_at: now.toISOString() }, now);
  onHelp(event(ask.device_id, "ask", ask.source, result, now, started));
  return result;
}

/** "I'm on my way", or a close. */
export async function answerHelp(store: CircleStore, deviceId: string, helpId: string, answer: HelpAnswer, via: HelpEvent["via"], now: Date, onHelp: (event: HelpEvent) => void): Promise<HelpAnswerResult> {
  const started = Date.now();
  const result = await store.answerHelp(deviceId, helpId, answer, now);
  onHelp(event(deviceId, answer.kind === "coming" ? "coming" : "okay", via, result, now, started));
  return result;
}

/** The words for "nothing was sent": the walker's and her phone's `409 no_caretaker`. */
export const NO_CARETAKER_MESSAGE = "No caretaker's phone is linked to this walker, so nothing was sent.";
export const HELP_NOT_FOUND_MESSAGE = "That request for help wasn't found.";
export const HELP_CLOSED_MESSAGE = "That request for help has already closed.";

// ---- The voice path ----

/** The server's reply when the model chose ask_for_help: the Pi then counts down HELP_COUNTDOWN_MS and asks itself. */
export function helpCountdownLine(caretakers: readonly string[]): string {
  return `I'll ask ${helpNames(caretakers)} for help in ${HELP_COUNTDOWN_MS / 1_000} seconds. Press any button to stop.`;
}

const COUNTDOWN_LINE = new RegExp(`^I'll ask .+ for help in ${HELP_COUNTDOWN_MS / 1_000} seconds\\. Press any button to stop\\.$`);

/**
 * A stored turn that answered with the countdown line: only the server writes a `fixed` reply, and only this one
 * has these words, so a replayed turn can say `ask_for_help` again without storing a flag of its own.
 */
export function isHelpCountdownTurn(turn: WalkerTurnView): boolean {
  return turn.source === "walker" && turn.answered_by === "fixed" && COUNTDOWN_LINE.test(turn.reply);
}

/** The server's reply to a help request by voice with no approved caretaker. */
export const NO_CARETAKER_VOICE_LINE = "No caretaker's phone is linked to this walker, so I can't ask anyone. If you need help now, call 911 from your phone.";

/**
 * The model's one line about an open request, on her own walker turns only: sent to, showing on, coming. Worded
 * the way the walker says it, so the model can't turn "sent" into "told". Null once closed.
 */
export function helpContextLine(h: HelpRecord): string | null {
  if (h.closed) return null;
  const names = (list: HelpPersonRecord[]) => helpNames(list.map((p) => p.name));
  const phones = (list: HelpPersonRecord[]) => `${names(list)}'s ${list.length === 1 ? "phone" : "phones"}`;
  return [
    "Open: you asked for help",
    `sent to ${phones(h.sent_to)}`,
    h.shown_to.length > 0 ? `showing on ${phones(h.shown_to)}` : "not showing on any phone yet",
    h.coming.length > 0 ? `${names(h.coming)} ${h.coming.length === 1 ? "is" : "are"} on the way` : "nobody has said they're on the way yet",
  ].join("; ");
}
