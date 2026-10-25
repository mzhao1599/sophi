import { CircleNameSchema, HELP_COUNTDOWN_MS, HELP_RETENTION_MS, MAX_CIRCLE_MEMBERS, helpNames, type HelpView } from "@walker/contracts";
import type { HelpRecord } from "./store";

/**
 * Asking for help (docs/subsystems/help.md): the projection every caller sees, the server's fixed voice lines, the
 * model's one context line, and the log event. Shared by CircleService (the routes) and WalkerService (the turn).
 */

/** The request as the walker and every phone see it: no exact times, no member ids, no location. */
export function helpView(h: HelpRecord, now: Date): HelpView {
  const age = Math.floor((now.getTime() - Date.parse(h.created_at)) / 1_000);
  return {
    help_id: h.help_id,
    source: h.source,
    age_seconds: Math.min(Math.max(0, Number.isFinite(age) ? age : 0), HELP_RETENTION_MS / 1_000),
    told: [...h.told],
    // Two caretakers may share a name; the view names each once (the contract's rule), first answer first.
    coming: [...new Set(h.coming.map((c) => c.name))].slice(0, MAX_CIRCLE_MEMBERS),
    closed: h.closed ? { how: h.closed.how, by_name: h.closed.by_name } : null,
  };
}

/**
 * Who closed it from the walker when her phone isn't in: the walker's name when it fits a circle name, otherwise
 * this fixed one (a walker's name may be up to 40 characters, `by_name` only 12).
 */
export const WALKER_FALLBACK_NAME = "The walker";

export function walkerCloserName(walkerName: string): string {
  const parsed = CircleNameSchema.safeParse(walkerName);
  return parsed.success ? parsed.data : WALKER_FALLBACK_NAME;
}

/** The server's reply when the model chose ask_for_help: the Pi then counts down HELP_COUNTDOWN_MS and asks itself. */
export function helpCountdownLine(caretakers: readonly string[]): string {
  return `I'll ask ${helpNames(caretakers)} for help in ${HELP_COUNTDOWN_MS / 1_000} seconds. Press any button to stop.`;
}

/** The server's reply to a help request by voice with no approved caretaker. */
export const NO_CARETAKER_VOICE_LINE = "No caretaker's phone is linked to this walker, so I can't ask anyone. If you need help now, call 911 from your phone.";

/** The model's one line about an open request, on her own walker turns only: state, told and coming. */
export function helpContextLine(h: HelpRecord): string | null {
  if (h.closed) return null;
  const coming = [...new Set(h.coming.map((c) => c.name))];
  const answer = coming.length === 0 ? "nobody has answered yet" : `${helpNames(coming)} ${coming.length === 1 ? "is" : "are"} coming`;
  return `open; told ${helpNames(h.told)}; ${answer}`;
}

/** One line per ask or answer, for the log: ids, how, the outcome and timings. Never a name or a location. */
export interface HelpEvent {
  device_id: string;
  help_id: string | null;
  action: "ask" | "coming" | "okay";
  /** Where it came from: the ask's source, or who answered (the walker, her phone, a caretaker's phone). */
  via: "handles" | "voice" | "phone" | "walker" | "walker_user" | "caregiver";
  outcome: "created" | "existing" | "no_caretaker" | "answered" | "unchanged" | "closed" | "not_found" | "not_member";
  /** How many caretakers were told (a count, never names). */
  told: number | null;
  /** Time since she asked, by the server's clock. */
  age_ms: number | null;
  /** Time the store step took. */
  ms: number;
}

export function logHelp(e: HelpEvent) {
  console.info(
    `[circle] help action=${e.action} device=${e.device_id} help=${e.help_id ?? "-"} via=${e.via} outcome=${e.outcome} told=${e.told ?? "-"} age_ms=${e.age_ms ?? "-"} ms=${e.ms}`,
  );
}
