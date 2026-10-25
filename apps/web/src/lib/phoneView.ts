import { CIRCLE_MESSAGE_MAX, helpNames, type Cue, type HelpPerson, type HelpSource, type HelpView } from "@walker/contracts";
import type { PhoneFailure, PhoneMember, PhoneMessage, PhonePerson, PhoneWalker } from "./phoneApi";
import { cueList } from "./walkerView";

/**
 * The two-phone app's words and small rules, as pure functions so the tests can pin them. The app shows only
 * what the server said: Online or Offline, the alerts in force, part health, the messages. Nothing here
 * guesses a state the server didn't send.
 */

/** How often the app asks the server for news while it's on screen. */
export const PHONE_POLL_MS = 2_000;
/**
 * With live updates from SpacetimeDB, the circle comes pushed; this is only for the walker's status (online, alerts,
 * parts, GPS). Only when the live rows include help requests (`my_help`): otherwise a request for help could reach
 * a caretaker's open app 10 s late, so the phone keeps polling every PHONE_POLL_MS.
 */
export const PHONE_LIVE_POLL_MS = 10_000;

export const pollEvery = (live: boolean, helpLive: boolean) => (live && helpLive ? PHONE_LIVE_POLL_MS : PHONE_POLL_MS);

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

// ---- Asking for help (docs/subsystems/help.md; expected results in test/help-phones.EXPECTED.md) ----
//
// The phones say "asked for help", never "SOS", "emergency" or "alarm"; the only 911 is the "Call 911" link. With no
// push notifications, nothing says anyone "has been told": a request is sent to the caretakers' phones, and shows
// on one once its app has received it (`shown_to`). "You" is decided by member id, never by name.

export { helpNames };

type People = readonly HelpPerson[];
const nameList = (people: People) => helpNames(people.map((p) => p.name));
const one = <T,>(list: readonly T[], single: string, many: string) => (list.length === 1 ? single : many);

/** "Maya's phone" / "Maya and Ana's phones": the walker's words. */
const phonesOf = (people: People) => `${nameList(people)}'s ${one(people, "phone", "phones")}`;

/** The approved caretakers' names, in joining order: who her phone would ask now. */
export const caretakerNames = (home: PhoneMember) => home.people.filter((p) => p.role === "caregiver").map((p) => p.name);

/** "Sent to Maya's phone." */
export const sentLine = (sentTo: People) => `Sent to ${phonesOf(sentTo)}.`;
/** "It's showing on Maya's phone." */
export const shownLine = (shownTo: People) => `It's showing on ${phonesOf(shownTo)}.`;
/** "Maya is on the way." / "Maya and Ana are on the way." */
export const comingLine = (coming: People) => `${nameList(coming)} ${one(coming, "is", "are")} on the way.`;

/** How long ago she asked, from the server's age: "just now", "1 minute ago", "5 minutes ago", "1 hour ago". */
export function agoWords(ageSeconds: number): string {
  if (ageSeconds < 60) return "just now";
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

export const HOW_WORDS: Readonly<Record<HelpSource, string>> = {
  handles: "from her walker",
  voice: "by asking Sophi",
  phone: "from her phone",
  camera: "when its camera saw a possible fall",
};

/**
 * Who asked, for a heading: her, or her walker when its fall check asked (`camera`: the walker's guess after a
 * countdown she didn't stop, never her words, so it never says she asked).
 */
export const askedWho = (h: Pick<HelpView, "source">, her: string) => (h.source === "camera" ? `${her}'s walker asked for help` : `${her} asked for help`);
/** The same on her own phone. */
export const youAsked = (h: Pick<HelpView, "source">) => (h.source === "camera" ? "Your walker asked for help" : "You asked for help");

export const NO_CARETAKER = "No caretaker is linked to your walker.";

// Her phone.

/** The Get help tile's second line. */
export function helpTileLine(home: PhoneMember): string {
  if (home.help && !home.help.closed) return "Open: see who's coming";
  const names = caretakerNames(home);
  return names.length ? `Ask ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`}` : "No caretaker linked";
}

/** The furthest step so far, for her banner: on the way, else showing, else sent. */
export const herOpenLine = (h: HelpView) => (h.coming.length ? comingLine(h.coming) : h.shown_to.length ? shownLine(h.shown_to) : sentLine(h.sent_to));

/** How it closed, on her phone. */
export function herClosedLine(h: HelpView): string {
  if (!h.closed) return "";
  if (h.closed.how === "okay") return `You said you're okay. ${phonesOf(h.sent_to)} will show it.`;
  if (h.closed.how === "with_her") return `${h.closed.by?.name ?? "A caretaker"} says they're with you.`;
  return "Your request for help has ended.";
}

/** "It goes to Maya's phone." / "It goes to Maya and Ana's phones." */
export const goesToLine = (names: readonly string[]) => `It goes to ${helpNames(names)}'s ${names.length === 1 ? "phone" : "phones"}. Sophi doesn't call 911.`;

/** Whether her location is shared, from her own walker view. */
export function herLocationLine(home: PhoneMember): string {
  const names = helpNames(caretakerNames(home));
  return home.walker.location_sharing_enabled
    ? `Location sharing is on, so ${names} can see your walker's latest GPS position.`
    : `Location sharing is off, so ${names} won't see where you are.`;
}

export function helpSendError(code: PhoneFailure): string {
  switch (code) {
    case "no_caretaker":
      return `${NO_CARETAKER.slice(0, -1)}, so nothing was sent.`;
    case "network":
      return "Not sent: can't reach Sophi's server. Try again.";
    default:
      return "Not sent. Try again.";
  }
}

// A caretaker's phone.

/** Her name for the caretaker's card: her phone's name, or the walker's own when her phone isn't linked. */
export const herName = (home: PhoneMember) => walkerUserOf(home)?.name ?? home.walker.walker_name;

/** "From her walker, just now." */
export const askedHowLine = (h: HelpView) => {
  const how = HOW_WORDS[h.source];
  return `${how.charAt(0).toUpperCase()}${how.slice(1)}, ${agoWords(h.age_seconds)}.`;
};

const isMe = (meId: string) => (p: HelpPerson) => p.member_id === meId;

/** Who else it went to, as this caretaker's phone sees it. */
export function sentOthersLine(h: HelpView, meId: string): string {
  const others = h.sent_to.filter((p) => !isMe(meId)(p));
  if (others.length === h.sent_to.length) return `It went to ${phonesOf(h.sent_to)}.`;
  return others.length ? `It also went to ${phonesOf(others)}.` : "It went only to your phone.";
}

/** Who is coming, this phone as "You". */
export function comingForLine(h: HelpView, meId: string): string {
  if (h.coming.length === 0) return "Nobody has said they're on the way yet.";
  const names = h.coming.map((p) => (isMe(meId)(p) ? "You" : p.name));
  if (names.length === 1 && names[0] === "You") return "You're on the way.";
  return `${helpNames(names)} ${one(names, "is", "are")} on the way.`;
}

/** How it closed, on a caretaker's phone. */
export function closedForLine(h: HelpView, meId: string, her: string, herKnown = true): string {
  if (!h.closed) return "";
  const by = h.closed.by;
  // With no phone of hers in, `her` is the walker's own name, which can't say she.
  if (h.closed.how === "okay") return by ? `${her} says she's okay.` : herKnown ? `${her} said she's okay on her walker.` : "She said she's okay on the walker.";
  if (h.closed.how === "with_her") return by && isMe(meId)(by) ? `You're with ${her}.` : `${by?.name ?? "A caretaker"} is with ${her}.`;
  return `${her}'s request for help has ended.`;
}

/** The tab title while a request is open on a caretaker's phone. */
export const helpTitle = (her: string, h: Pick<HelpView, "source"> = { source: "phone" }) => `${askedWho(h, her)} · Sophi`;

const added = (prev: People, next: People) => next.filter((p) => !prev.some((q) => q.member_id === p.member_id));

/**
 * The one line the live region says when the help request changed since the last home: a new request, on her phone
 * a phone newly showing it, a new phone coming, a close. Null when nothing it announces changed, and on the first
 * home (`prev` undefined): never on load.
 */
export function helpChange(prev: HelpView | null | undefined, next: HelpView | null, home: PhoneMember): string | null {
  if (prev === undefined || !next) return null;
  const meId = home.me.member_id;
  const mine = home.me.role === "walker_user";
  const her = herName(home);
  const fresh = !prev || prev.help_id !== next.help_id;
  if (next.closed) {
    if (!fresh && prev.closed) return null;
    return mine ? herClosedLine(next) : closedForLine(next, meId, her, !!walkerUserOf(home));
  }
  // Her phone: the furthest step already (a caretaker's app may have it before her first home after asking).
  if (fresh) return mine ? `${youAsked(next)}. ${herOpenLine(next)}` : `${askedWho(next, her)} ${HOW_WORDS[next.source]}.`;
  const coming = added(prev.coming, next.coming);
  if (coming.length) {
    if (mine) return comingLine(coming);
    const names = coming.map((p) => (isMe(meId)(p) ? "You" : p.name));
    return names.length === 1 && names[0] === "You" ? "You're on the way." : `${helpNames(names)} ${one(names, "is", "are")} on the way.`;
  }
  const shown = added(prev.shown_to, next.shown_to);
  if (mine && shown.length) return shownLine(shown);
  return null;
}

/** A new open request arrived since the last home (not on load): the caretaker's phone plays its tone. */
export const helpArrived = (prev: HelpView | null | undefined, next: HelpView | null) =>
  prev !== undefined && !!next && !next.closed && (!prev || prev.help_id !== next.help_id);
