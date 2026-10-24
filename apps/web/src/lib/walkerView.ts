import {
  MAX_WALKERS_PER_OWNER,
  MODULE_CATALOG,
  SNAPSHOT_MAX_AGE_MS,
  getCatalogEntry,
  sameCues,
  type Cue,
  type ModuleId,
  type PartView,
  type ProposalView,
  type WalkerErrorCode,
  type WalkerEventView,
  type WalkerStatusView,
  type WalkerTurnView,
  type ZoneView,
} from "@walker/contracts";

/**
 * The "Your walker" page's view logic, kept free of React so it can be unit tested. Everything it says
 * comes from the status view the server built (`WalkerStatusViewSchema`); the page never decides on its
 * own that a part works, a zone is clear or a change was applied. Expected results:
 * `apps/web/test/walker-page.EXPECTED.md`.
 */

/** Shown above the text box before anyone types. */
export const TYPED_NOTICE =
  "Your words go to Google's Gemini, which may keep a copy, and the text of Sophi's spoken replies goes to Cartesia. Please don't type names or health details. Each message is deleted an hour after it's sent, or right away with Forget this walker.";

/** How often the page asks for the walker's status while the tab is visible. */
export const POLL_MS = 1_500;
/** With no successful poll for this long, what's on screen is no longer live. */
export const NOT_LIVE_AFTER_MS = 5_000;

// ---- Parts ----

const HEALTH_WORD: Record<PartView["health"], string> = {
  ok: "Healthy",
  degraded: "Degraded",
  fault: "Fault",
  unavailable: "Unavailable",
};

/**
 * How a part is drawn: solid green only for a real part that's healthy; dashed green for a simulated
 * one, whatever it reports; ink when degraded; red dashes for a fault; a faint dotted outline when
 * unavailable. The words beside it say the same, so nothing rests on colour or line style alone.
 */
export type DrawState = "on" | "simulated" | "degraded" | "fault" | "unavailable";

export interface PartRow {
  /** One row per part: two hand controls are two rows. */
  key: string;
  module_id: ModuleId;
  name: string;
  health: PartView["health"];
  /** "Healthy", "Unavailable", …: always shown. */
  healthWord: string;
  simulated: boolean;
  inConfiguration: boolean;
  draw: DrawState;
  /** The whole state in words, for the list and the drawing's caption. */
  words: string;
}

const CATALOG_ORDER = MODULE_CATALOG.modules.map((m) => m.id);
export const moduleName = (id: ModuleId) => getCatalogEntry(MODULE_CATALOG, id).name;

export function drawState(part: Pick<PartView, "health" | "simulated">): DrawState {
  if (part.health === "unavailable") return "unavailable";
  if (part.health === "fault") return "fault";
  if (part.simulated) return "simulated";
  return part.health === "degraded" ? "degraded" : "on";
}

export function partRows(parts: readonly PartView[]): PartRow[] {
  return [...parts]
    .sort((a, b) => CATALOG_ORDER.indexOf(a.module_id) - CATALOG_ORDER.indexOf(b.module_id))
    .map((p, i) => {
      const words = [HEALTH_WORD[p.health], p.simulated ? "Simulated" : null, p.in_configuration ? null : "Not in your setup"]
        .filter(Boolean)
        .join(", ");
      return {
        key: `${p.module_id}/${p.instance_id ?? `unreported-${i}`}`,
        module_id: p.module_id,
        name: moduleName(p.module_id),
        health: p.health,
        healthWord: HEALTH_WORD[p.health],
        simulated: p.simulated,
        inConfiguration: p.in_configuration,
        draw: drawState(p),
        words,
      };
    });
}

/** Worst first: a module with one faulty part and one healthy one is drawn as faulty. */
const WORST: readonly DrawState[] = ["fault", "unavailable", "degraded", "simulated", "on"];

export interface DrawnPart {
  draw: DrawState;
  name: string;
  /** Each part's state in words, "; " between parts of the same module. */
  words: string;
  simulated: boolean;
}

/**
 * One entry per module for the drawing, which has one place per module. Several parts of the same module
 * (left and right hand controls) are drawn in the worst of their states, and the label lists each one, so
 * a fault on one side can't hide behind a healthy other side.
 */
export function drawnParts(rows: readonly PartRow[]): Map<ModuleId, DrawnPart> {
  const groups = new Map<ModuleId, PartRow[]>();
  for (const r of rows) groups.set(r.module_id, [...(groups.get(r.module_id) ?? []), r]);
  const own = (r: PartRow, many: boolean) =>
    [r.healthWord, many && r.simulated ? "Simulated" : null, r.inConfiguration ? null : "Not in your setup"].filter(Boolean).join(", ");
  return new Map(
    [...groups].map(([id, parts]) => [
      id,
      {
        draw: parts.map((p) => p.draw).reduce((a, b) => (WORST.indexOf(b) < WORST.indexOf(a) ? b : a)),
        name: parts[0]!.name,
        // One part: its chip says Simulated. Several: each says so itself, so it's clear which one.
        words: parts.map((p) => own(p, parts.length > 1)).join("; "),
        simulated: parts.some((p) => p.simulated),
      },
    ]),
  );
}

/** What the drawing shows, in words, for screen readers. */
export function drawingCaption(rows: readonly PartRow[]): string {
  if (rows.length === 0) return "The walker's frame. No parts reported yet.";
  return `The walker, with ${rows.map((r) => `${r.name}: ${r.words}`).join("; ")}.`;
}

// ---- Alerts ----

const CUE_WORD: Record<Cue, string> = {
  vibration: "Vibration in the handles",
  spoken: "Spoken messages",
  sound: "Short sounds",
  screen: "Screen",
};

export const cueWord = (cue: Cue) => CUE_WORD[cue];

export function cueList(cues: readonly Cue[]): string {
  const words = cues.map((c, i) => (i === 0 ? CUE_WORD[c] : CUE_WORD[c].toLowerCase()));
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** "Applied" only when the walker itself reports the current version; anything else is still waiting. */
export function appliedState(status: Pick<WalkerStatusView, "configuration" | "applied_configuration_version">): "applied" | "waiting" {
  return status.applied_configuration_version === status.configuration.version ? "applied" : "waiting";
}

export const APPLIED_WORD = { applied: "Applied", waiting: "Waiting for the walker" } as const;

// ---- Obstacles ----

const UNKNOWN_WHY: Record<Extract<ZoneView["reading"], { status: "unknown" }>["reason"], string> = {
  missing: "no reading",
  invalid: "the sensor couldn't measure",
  stale: "reading too old",
};

/** "front_left" → "Front left". */
export function zoneName(zone: string): string {
  const words = zone.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** 380 → "38 cm"; 1234 → "1.2 m". */
export function formatDistance(mm: number): string {
  if (mm < 1000) return `${Math.round(mm / 10)} cm`;
  return `${(mm / 1000).toFixed(1)} m`;
}

/** 640 → "0.6 s ago"; 12_300 → "12 s ago"; 150_000 → "2 min ago". */
export function formatAge(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)} s ago`;
  if (s < 60) return `${Math.floor(s)} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export interface ZoneRow {
  key: string;
  name: string;
  simulated: boolean;
  /** "38 cm", or "Unknown". Never "clear". */
  value: string;
  /** "measured 0.6 s ago", or why it's unknown. */
  detail: string;
  measured: boolean;
}

/**
 * The oldest reading the page shows as a distance: the contract's freshness limit plus one poll, so a
 * reading doesn't flicker to unknown between polls but can't sit on screen long after it went stale.
 */
export const ZONE_MAX_SHOWN_AGE_MS = SNAPSHOT_MAX_AGE_MS + POLL_MS;

/**
 * Each zone as the page shows it. A measured zone's age grows between polls: the server's `age_ms` plus
 * the time since that answer arrived (`sinceReceivedMs`); past ZONE_MAX_SHOWN_AGE_MS it's unknown. When
 * the page isn't live (`live` false), every zone is unknown: an old distance must not look current.
 */
export function zoneRows(zones: readonly ZoneView[], sinceReceivedMs: number, live: boolean): ZoneRow[] {
  return zones.map((z) => {
    const base = { key: `${z.instance_id}/${z.zone}`, name: zoneName(z.zone), simulated: z.simulated };
    if (!live) return { ...base, value: "Unknown", detail: "no update from the server", measured: false };
    if (z.reading.status === "unknown") return { ...base, value: "Unknown", detail: UNKNOWN_WHY[z.reading.reason], measured: false };
    const age = z.reading.age_ms + Math.max(0, sinceReceivedMs);
    if (age > ZONE_MAX_SHOWN_AGE_MS) return { ...base, value: "Unknown", detail: UNKNOWN_WHY.stale, measured: false };
    return { ...base, value: formatDistance(z.reading.mm), detail: `measured ${formatAge(age)}`, measured: true };
  });
}

// ---- Online and last seen ----

/** "just now", "3 s ago", "2 min ago", "1 h ago". */
export function relativeAgo(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 2) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

export interface Presence {
  /** "Online", "Offline" or "Status unknown". Always shown in words. */
  word: string;
  detail: string | null;
  tone: "online" | "offline" | "unknown";
}

export function presence(status: Pick<WalkerStatusView, "online" | "last_seen_at">, serverNowMs: number, live: boolean): Presence {
  if (!live) return { word: "Status unknown", detail: "no connection to Sophi's server", tone: "unknown" };
  const seen = status.last_seen_at ? `last seen ${relativeAgo(serverNowMs - Date.parse(status.last_seen_at))}` : "never seen";
  return status.online ? { word: "Online", detail: null, tone: "online" } : { word: "Offline", detail: seen, tone: "offline" };
}

// ---- Countdowns ----

/** Whole seconds left before `expiresAtMs`, never below 0. */
export function secondsLeft(expiresAtMs: number, serverNowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - serverNowMs) / 1000));
}

/** 42 → "0:42"; 599 → "9:59". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ---- Pairing ----

/** "482913" → "482 913", read aloud in two halves. */
export const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

export const pairCommand = (code: string, origin: string) => `walker pair ${code} --server ${origin}`;

// ---- Conversation ----

export type ConversationEntry =
  | {
      kind: "turn";
      key: string;
      at: number;
      turn: WalkerTurnView;
      /** "You said (as heard by Gemini)", "You typed", "Typed on the walker". */
      heardLabel: string;
      /** Her words, or null when nothing was heard ("Sophi didn't catch that"). */
      heard: string | null;
      /** A quiet line under the reply when the fixed replies answered; null when the model did. */
      engineNote: string | null;
      /** Which voice the server offered for the reply; null for page turns, which aren't spoken. */
      voiceNote: string | null;
    }
  | { kind: "line"; key: string; at: number; event: WalkerEventView; label: string };

export const NOT_CAUGHT = "Sophi didn't catch that";

export function heardLabel(turn: WalkerTurnView): string {
  if (turn.heard_by === "gemini") return "You said (as heard by Gemini)";
  if (turn.heard_by === "typed") return turn.source === "page" ? "You typed" : "Typed on the walker";
  return "You said";
}

/**
 * Turns and the walker's own lines, oldest first, merged by when they happened. Two at the same moment
 * keep the server's order, turns first.
 */
export function conversation(status: Pick<WalkerStatusView, "turns" | "walker_said">): ConversationEntry[] {
  const turns: ConversationEntry[] = status.turns.map((turn) => ({
    kind: "turn",
    key: `t-${turn.turn_id}`,
    at: Date.parse(turn.created_at),
    turn,
    heardLabel: heardLabel(turn),
    heard: turn.heard,
    engineNote: turn.answered_by === "fixed" ? "Answered by the fixed replies" : null,
    voiceNote: turn.voiced_by === "cartesia" ? "In Cartesia's voice" : turn.voiced_by === "walker" ? "In the walker's own voice" : null,
  }));
  const lines: ConversationEntry[] = status.walker_said.map((event) => ({
    kind: "line",
    key: `e-${event.event_id}`,
    at: Date.parse(event.at),
    event,
    label: event.kind === "local_reply" ? "On the walker, offline reply" : "On the walker",
  }));
  return [...turns, ...lines].map((e, i) => ({ e, i })).sort((a, b) => a.e.at - b.e.at || a.i - b.i).map(({ e }) => e);
}

// ---- Proposals ----

/** Said once the page's countdown reaches 0, until the next status says how the offer ended. */
export const OUT_OF_TIME = "Time's up: this offer can't be answered here any more.";

/** "Confirmed" says what was asked for; the Alerts card says when the walker has applied it. */
const confirmedLine = (cues: readonly Cue[]) => `Confirmed. Switching your alerts to ${cueList(cues).toLowerCase()}.`;

/** The line that replaces a proposal's buttons once it's closed, from the state the server reports. */
export function proposalOutcome(p: Pick<ProposalView, "state" | "cues">): string | null {
  switch (p.state) {
    case "open":
      return null;
    case "confirmed":
      return confirmedLine(p.cues);
    case "declined":
      return "Declined. Nothing changed.";
    case "expired":
      return "Expired. Nothing changed.";
    case "superseded":
      return "Replaced by a newer offer.";
  }
}

/**
 * A proposal the page last saw open, gone from the status without the page answering it. The page can't
 * ask which way it closed, so it says only what the status shows: a confirm is the only way the
 * configuration moves to `base + 1` with the proposal's cues; another open proposal replaced it; past
 * its expiry, or with the walker offline, it expired, and "nothing changed" only while the configuration
 * is still the one it was based on; anything else is just no longer open.
 */
export function closedOutcome(
  p: ProposalView,
  status: Pick<WalkerStatusView, "configuration" | "online" | "open_proposal">,
  serverNowMs: number,
): string {
  if (status.configuration.version === p.base_configuration_version + 1 && sameCues(status.configuration.cues, p.cues)) {
    return confirmedLine(p.cues);
  }
  if (status.open_proposal && status.open_proposal.proposal_id !== p.proposal_id) return "Replaced by a newer offer.";
  const unchanged = status.configuration.version === p.base_configuration_version;
  if (unchanged && (serverNowMs >= Date.parse(p.expires_at) || !status.online)) return "Expired. Nothing changed.";
  return "No longer open.";
}

/** The proposal card: open with its buttons, or closed with the line that replaced them. */
export interface ProposalCard {
  proposal: ProposalView;
  /** null while open. */
  outcome: string | null;
  /** The newest turn when it closed: the outcome stays until a newer turn arrives. */
  closedAfter: string | null;
}

const newestTurn = (status: Pick<WalkerStatusView, "turns">) => status.turns.at(-1)?.turn_id ?? null;

/** The card after the page answered, or after the server said the proposal was already closed. */
export function answeredCard(p: ProposalView, status: Pick<WalkerStatusView, "turns">): ProposalCard {
  return { proposal: p, outcome: proposalOutcome(p), closedAfter: newestTurn(status) };
}

/** The card after a new status: the open proposal if there is one, or what became of the last one seen. */
export function nextCard(prev: ProposalCard | null, status: WalkerStatusView, serverNowMs: number): ProposalCard | null {
  const open = status.open_proposal;
  if (open) return { proposal: open, outcome: null, closedAfter: null };
  if (!prev) return null;
  if (prev.outcome === null) return { proposal: prev.proposal, outcome: closedOutcome(prev.proposal, status, serverNowMs), closedAfter: newestTurn(status) };
  return newestTurn(status) === prev.closedAfter ? prev : null;
}

// ---- Errors ----

/** A walker that went away under the page (forgotten in another tab, or never this browser's). */
export const goneMessage = (name: string) => `${name} isn't connected to this browser any more.`;

export const CONNECTION_LOST = "Lost the connection to Sophi's server. What's on screen may be out of date.";
export const CONNECTION_BACK = "Connected to Sophi's server again.";

/** Every error the page can get, in plain words. */
export function errorMessage(code: WalkerErrorCode | "network" | "not_offered"): string {
  switch (code) {
    case "not_offered":
      return "Sophi's server can't do that yet.";
    case "unauthenticated":
      return "This browser isn't connected to a walker any more. Connect one again.";
    case "not_found":
      return "That walker isn't connected to this browser any more.";
    case "proposal_closed":
      return "That offer is already closed.";
    case "walker_limit":
      return `You already have ${MAX_WALKERS_PER_OWNER} walkers. Forget one before connecting another.`;
    case "pairing_locked":
      return "Too many wrong codes were tried from this network. Wait 10 minutes, then get a new code.";
    case "pairing_code_invalid":
      return "That pairing code isn't valid. Get a new code and try again.";
    case "rate_limited":
      return "Too many requests. Wait a moment and try again.";
    case "invalid_request":
      return "The server didn't accept that. Try again.";
    case "unavailable":
      return "Sophi's server isn't available right now. Try again in a moment.";
    case "network":
      return "Can't reach Sophi's server. Check the connection.";
  }
}

// ---- Announcements ----

/** Ends with a full stop unless it already ends a sentence, so the next one reads as its own. */
export const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);

/** What the page has already announced (or found already there on load) for one walker. */
export interface Heard {
  turns: Set<string>;
  lines: Set<string>;
  proposals: Set<string>;
  online: boolean;
  /** Seen online at least once since the page loaded, so coming online again is "back online". */
  everOnline: boolean;
  applied: boolean;
  version: number;
}

function heardFrom(status: WalkerStatusView, before?: Heard): Heard {
  return {
    turns: new Set([...(before?.turns ?? []), ...status.turns.map((t) => t.turn_id)]),
    lines: new Set([...(before?.lines ?? []), ...status.walker_said.map((e) => e.event_id)]),
    proposals: new Set([...(before?.proposals ?? []), ...(status.open_proposal ? [status.open_proposal.proposal_id] : [])]),
    online: status.online,
    everOnline: (before?.everOnline ?? false) || status.online,
    applied: appliedState(status) === "applied",
    version: status.configuration.version,
  };
}

/**
 * What to read out politely after a new status, once each: new replies, new walker lines, a new open
 * proposal, going offline or online, and a new configuration applied. With no `before` (the first status
 * after loading), nothing: what was already there isn't news.
 */
export function announcements(before: Heard | undefined, status: WalkerStatusView): { lines: string[]; heard: Heard } {
  const heard = heardFrom(status, before);
  if (!before) return { lines: [], heard };
  const lines: string[] = [];
  if (before.online && !status.online) lines.push("Your walker went offline.");
  if (!before.online && status.online) lines.push(before.everOnline ? "Your walker is back online." : "Your walker is online.");
  for (const entry of conversation(status)) {
    if (entry.kind === "turn" && !before.turns.has(entry.turn.turn_id)) lines.push(`Sophi: ${entry.turn.reply}`);
    if (entry.kind === "line" && !before.lines.has(entry.event.event_id)) lines.push(`On the walker: ${entry.event.text}`);
  }
  const p = status.open_proposal;
  if (p && !before.proposals.has(p.proposal_id)) lines.push(`Sophi offers: ${sentence(p.summary)} Confirm or decline within a minute.`);
  if (heard.applied && (!before.applied || before.version !== heard.version) && heard.version > 1) lines.push("Your walker applied the new alerts.");
  return { lines, heard };
}

/**
 * The live region's lines for one status, in reading order: `first` (a connection line, or an action's
 * own line), then how the shown offer closed, then the walker's other news. A closing comes before the
 * news it caused, so a confirm reads "Confirmed. Switching your alerts to … Your walker applied the new
 * alerts." even when both arrive in one poll.
 */
export const readingOrder = (first: readonly string[], closing: string | null | undefined, news: readonly string[]): string[] => [
  ...first,
  ...(closing ? [closing] : []),
  ...news,
];
