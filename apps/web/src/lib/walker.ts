import {
  MODULE_CATALOG,
  checkSelection,
  getCatalogEntry,
  type ModuleCatalogEntry,
  type ModuleId,
  type ProfileFact,
  type Recommendation,
  type SelectionProblem,
} from "@walker/contracts";

/**
 * The walker view's selection logic, kept free of React so it can be unit tested. The rules come from
 * the catalog (`checkSelection` in packages/contracts): the frame is always on, a module that isn't
 * built yet can't be turned on, `requires` is kept true automatically, and `requires_any_of` (a choice
 * the person has to make) is reported as a problem rather than decided for them.
 */

/** What the person switched themselves. A module they haven't touched follows the current suggestions. */
export type Choices = Partial<Record<ModuleId, boolean>>;

/**
 * How a module is drawn: on the walker, suggested but off, off because the person said no to it, off,
 * or not built yet.
 */
export type PartState = "on" | "suggested" | "declined" | "off" | "unavailable";

const ORDER = MODULE_CATALOG.modules.map((m) => m.id);
const entryOf = (id: ModuleId) => getCatalogEntry(MODULE_CATALOG, id);
export const nameOf = (id: ModuleId) => entryOf(id).name;

/** Why a module's switch can't move, or null when it can. */
export function lockReason(entry: ModuleCatalogEntry): string | null {
  if (entry.default === "required") return "Always on.";
  if (entry.availability === "deferred") return "Not available yet.";
  return null;
}

/** On before the person touches anything: what's required plus what's recommended (the same rule as the engine). */
export function isDefaultOn(rec: Recommendation | undefined): boolean {
  return rec?.status === "required" || rec?.status === "recommended";
}

/** The modules on the walker, in catalog order. Locked modules ignore choices. */
export function selectedModules(recs: readonly Recommendation[], choices: Choices): ModuleId[] {
  const byId = new Map(recs.map((r) => [r.module_id, r]));
  return ORDER.filter((id) => {
    const entry = entryOf(id);
    if (entry.default === "required") return true;
    if (entry.availability === "deferred") return false;
    return choices[id] ?? isDefaultOn(byId.get(id));
  });
}

/**
 * The fact a module is off because of: the person's own answer that declined what it does ("I'd rather
 * not talk to it"), or null. The engine marks it as a not-suggested reason that points at a fact with
 * declined tags.
 */
export function declinedBy(rec: Recommendation | undefined, facts: readonly ProfileFact[]): ProfileFact | null {
  if (rec?.status !== "not_suggested") return null;
  for (const reason of rec.reasons) {
    const fact = reason.fact_id ? facts.find((f) => f.id === reason.fact_id) : undefined;
    if (fact && fact.declined_tags.length > 0) return fact;
  }
  return null;
}

export function partStates(
  recs: readonly Recommendation[],
  selected: readonly ModuleId[],
  facts: readonly ProfileFact[] = [],
): Record<ModuleId, PartState> {
  const byId = new Map(recs.map((r) => [r.module_id, r]));
  return Object.fromEntries(
    ORDER.map((id) => {
      const rec = byId.get(id);
      const state: PartState = selected.includes(id)
        ? "on"
        : entryOf(id).availability === "deferred"
          ? "unavailable"
          : rec?.status === "recommended" || rec?.status === "consider"
            ? "suggested"
            : declinedBy(rec, facts)
              ? "declined"
              : "off";
      return [id, state];
    }),
  ) as Record<ModuleId, PartState>;
}

/** Everything `id` needs through `requires`, transitively, nearest first. */
function needs(id: ModuleId, seen = new Set<ModuleId>()): ModuleId[] {
  const out: ModuleId[] = [];
  for (const dep of entryOf(id).requires) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    out.push(dep, ...needs(dep, seen));
  }
  return out;
}

/** Every module that needs `id` through `requires`, transitively. */
function neededBy(id: ModuleId): ModuleId[] {
  return ORDER.filter((other) => other !== id && needs(other).includes(id));
}

function list(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "Robot arms" → "them", "Arm lift" → "it": every catalog name that ends in "s" is a plural. */
const pronoun = (id: ModuleId) => (nameOf(id).endsWith("s") ? "them" : "it");

export interface ToggleResult {
  choices: Choices;
  selected: ModuleId[];
  /** Other modules switched to keep a `requires` rule true. */
  alsoChanged: ModuleId[];
  /** What happened, in a sentence, for the polite status announcement. */
  message: string;
  /** False when the switch is locked and nothing changed. */
  changed: boolean;
}

/**
 * Switches one module. Turning a module on also turns on what it `requires` (the arm lift brings the
 * arms); turning one off also turns off what can't work without it. The message says so, because the
 * person didn't press those switches themselves.
 */
export function toggleModule(recs: readonly Recommendation[], choices: Choices, id: ModuleId, on: boolean): ToggleResult {
  const before = selectedModules(recs, choices);
  const name = nameOf(id);
  const locked = lockReason(entryOf(id));
  if (locked) return { choices, selected: before, alsoChanged: [], message: `${name}: ${locked}`, changed: false };

  const next: Choices = { ...choices, [id]: on };
  const related = on ? needs(id) : neededBy(id);
  const alsoChanged = related.filter((other) => before.includes(other) !== on);
  for (const other of alsoChanged) next[other] = on;
  const selected = selectedModules(recs, next);

  const [first] = alsoChanged;
  const names = list(alsoChanged.map(nameOf));
  const message = on
    ? `Added ${name}.${first ? ` ${names} added too, because ${name.toLowerCase()} needs ${pronoun(first)}.` : ""}`
    : `Removed ${name}.${first ? ` ${names} removed too, because ${alsoChanged.length > 1 ? "they need" : "it needs"} ${name.toLowerCase()}.` : ""}`;
  return { choices: next, selected, alsoChanged, message, changed: selected.join() !== before.join() };
}

export function selectionProblems(selected: readonly ModuleId[]): SelectionProblem[] {
  return checkSelection(MODULE_CATALOG, selected);
}

/** "4 modules on your walker". */
export function countLine(selected: readonly ModuleId[]): string {
  return `${selected.length} ${selected.length === 1 ? "module" : "modules"} on your walker`;
}

/** What the person said that a module's state rests on: their own words, quoted, or the answer they picked. */
export interface Said {
  /** "You said" for typed words, "You picked" for a tapped answer. */
  lead: "You said" | "You picked";
  /** Typed words in curly quotes; a picked answer as it was shown. */
  text: string;
}

function said(fact: ProfileFact): Said {
  return fact.source === "chosen" ? { lead: "You picked", text: fact.text } : { lead: "You said", text: `“${fact.text}”` };
}

/**
 * Why a module is suggested, or why it's off because the person said no: the person's words first,
 * then the rule's reason. Null when nothing they said bears on it.
 */
export function whySuggested(
  rec: Recommendation | undefined,
  facts: readonly ProfileFact[],
): { said: Said | null; reason: string; declined: boolean } | null {
  if (!rec) return null;
  const no = declinedBy(rec, facts);
  if (no) return { said: said(no), reason: rec.reasons.find((r) => r.fact_id === no.id)?.text ?? "", declined: true };
  if (rec.status === "not_suggested") return null;
  const reason = rec.reasons.find((r) => r.fact_id) ?? rec.reasons[0];
  if (!reason) return null;
  const fact = reason.fact_id ? facts.find((f) => f.id === reason.fact_id) : undefined;
  return { said: fact ? said(fact) : null, reason: reason.text, declined: false };
}

/** The short status under a module's name. `review`: the person is choosing, so on/off is theirs. */
export function stateLabel(id: ModuleId, state: PartState, review: boolean): string {
  if (state === "unavailable") return "Not Available Yet";
  if (state === "declined") return "You Said No";
  if (entryOf(id).default === "required") return "Always Included";
  if (review) return state === "on" ? "On" : state === "suggested" ? "Suggested" : "Off";
  if (state === "on") return "Suggested";
  return state === "suggested" ? "Worth Considering" : "Not Yet";
}

/**
 * What changed between two selections, for one polite sentence while the conversation runs, or null
 * when nothing did. The frame is always there, so it never counts as news.
 */
export function suggestionNews(before: readonly ModuleId[], after: readonly ModuleId[]): string | null {
  const added = after.filter((id) => !before.includes(id)).map(nameOf);
  const removed = before.filter((id) => !after.includes(id)).map(nameOf);
  const parts = [added.length ? `Lit up on your walker: ${list(added)}.` : "", removed.length ? `No longer suggested: ${list(removed)}.` : ""];
  return parts.filter(Boolean).join(" ") || null;
}
