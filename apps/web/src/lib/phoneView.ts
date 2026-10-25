import { CIRCLE_MESSAGE_MAX, type Cue } from "@walker/contracts";
import type { PhoneFailure, PhoneMember, PhoneMessage, PhonePerson, PhoneWalker } from "./phoneApi";
import { cueList } from "./walkerView";

/**
 * The two-phone app's words and small rules, as pure functions so the tests can pin them. The app shows only
 * what the server said: Online or Offline, the alerts in force, part health, the messages. Nothing here
 * guesses a state the server didn't send.
 */

/** How often the app asks the server for news while it's on screen. */
export const PHONE_POLL_MS = 2_000;

/** A random v4 UUID. `crypto.randomUUID` exists only on https pages, and a phone on the venue's LAN may be on plain http. */
export function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    try {
      return crypto.randomUUID();
    } catch {
      // Not a secure context: fall through.
    }
  }
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- Joining ----

/** What the code box keeps of what was typed or pasted: digits only, at most six. */
export const codeDigits = (typed: string) => typed.replace(/\D/g, "").slice(0, 6);

export const JOIN_NOTICE =
  "Joining links this phone to the walker. Messages between the phones are deleted after 24 hours, and the walker reads a caretaker's messages aloud. GPS sharing starts off and only the walker user's phone can turn it on for approved caretakers.";

export function joinError(code: PhoneFailure): string {
  switch (code) {
    case "invite_code_invalid":
    case "invalid_request":
      return "That code didn't work. Check the code on the walker page and type it again.";
    case "invite_locked":
    case "rate_limited":
      return "Too many wrong codes. Wait a few minutes, then try again.";
    case "circle_full":
      return "This walker has all the phones it can take.";
    case "network":
      return "Can't reach Sophi's server. Check the phone's connection and try again.";
    case "not_offered":
      return "This server doesn't have the phone app yet.";
    default:
      return "Sophi's server couldn't add this phone just now. Try again.";
  }
}

export function sendError(code: PhoneFailure): string {
  switch (code) {
    case "network":
      return "Not sent: can't reach Sophi's server. Try again.";
    case "message_limit":
      return "Not sent: there are too many messages waiting. Try again later.";
    case "not_found":
      return "Not sent: that person isn't on this walker any more.";
    case "invalid_request":
      return `Not sent: a message is one line of up to ${CIRCLE_MESSAGE_MAX} characters.`;
    default:
      return "Not sent. Try again.";
  }
}

export const NOT_IN_CIRCLE = "This phone isn't linked to the walker any more. Type a new code to link it again.";
export const CANT_REACH = "Can't reach Sophi's server. This shows what it said last, and keeps trying.";

// ---- The walker ----

/** Her phone's one sentence about the walker. */
export function statusSentence(walker: Pick<PhoneWalker, "online">): string {
  return walker.online ? "Your walker is on." : "Your walker isn't connected right now.";
}

/** "Alerts: short sounds and spoken messages." */
export function alertsSentence(alerts: readonly Cue[]): string {
  const list = cueList(alerts);
  return `Alerts: ${list.charAt(0).toLowerCase()}${list.slice(1)}.`;
}

export const presenceWord = (online: boolean) => (online ? "Online" : "Offline");

export const BATTERY_LINE = "Battery: not measured on this walker";

// ---- People ----

/** The person who walks with it: her own phone, if it's linked. */
export const walkerUserOf = (home: PhoneMember): PhonePerson | undefined => home.people.find((p) => p.role === "walker_user");

/** The caretaker her phone replies to: the first one linked. */
export const caregiverOf = (home: PhoneMember): PhonePerson | undefined =>
  home.people.find((p) => p.role === "caregiver" && p.member_id !== home.me.member_id);

/** "Rose's walker" on the caretaker's phone, or the walker's own name when her phone isn't linked. */
export function walkerTitle(home: PhoneMember): string {
  const her = walkerUserOf(home);
  return her ? `${her.name}'s walker` : home.walker.walker_name;
}

// ---- Messages ----

/** Characters as the server counts them (code points), so the counter and the server agree. */
export const charCount = (text: string) => [...text.trim()].length;

export function counterLine(text: string): { line: string; over: boolean } {
  const n = charCount(text);
  if (n > CIRCLE_MESSAGE_MAX) return { line: `${n - CIRCLE_MESSAGE_MAX} over the ${CIRCLE_MESSAGE_MAX}-character limit`, over: true };
  return { line: `${n} of ${CIRCLE_MESSAGE_MAX} characters`, over: false };
}

/** Messages the other phone sent, newest first. */
export const incoming = (messages: readonly PhoneMessage[]) => messages.filter((m) => !m.mine).reverse();

/** Incoming messages this phone hasn't shown yet (kept on the phone only; the server has no read state). */
export const unseen = (messages: readonly PhoneMessage[], seen: ReadonlySet<string>) => incoming(messages).filter((m) => !seen.has(m.message_id));

/** What the phone says aloud when she taps a message. */
export const spokenMessage = (m: Pick<PhoneMessage, "from_name" | "text">) => `${m.from_name} says: ${m.text}`;

export function newCountLine(n: number): string | null {
  if (n === 0) return null;
  return n === 1 ? "1 new message" : `${n} new messages`;
}

// ---- The owner's "Phones" panel on /walker ----

export const phoneRoleWord = (role: "walker_user" | "caregiver") => (role === "walker_user" ? "Their own phone" : "Caretaker");

export function ownerError(code: PhoneFailure): string {
  switch (code) {
    case "circle_full":
      return "This walker has all the phones and codes it can hold. Remove one first.";
    case "invalid_request":
      return "Names are 1 to 12 characters, on one line.";
    case "not_found":
      return "That phone isn't waiting any more.";
    case "network":
      return "Can't reach Sophi's server. Try again.";
    case "not_offered":
      return "Sophi's server doesn't have phones yet.";
    default:
      return "Sophi's server couldn't do that just now. Try again.";
  }
}
