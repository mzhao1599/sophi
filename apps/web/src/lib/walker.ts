import {
  MODULE_CATALOG,
  checkSelection,
  getCatalogEntry,
  type ModuleCatalogEntry,
  type ModuleId,
  type ProfileFact,
  type Recommendation,
  type SelectionProblem,
  type Turn,
} from "@walker/contracts";

/**
 * The walker view's selection logic, kept free of React so it can be unit tested. The rules come from
 * the catalog (`checkSelection` in packages/contracts): the frame is always on, a module that isn't
 * built yet can't be turned on, `requires` is kept true automatically, and `requires_any_of` (a choice
 * the person has to make) is reported as a problem rather than decided for them.
 */

/** What the person switched themselves. A module they haven't touched follows the current suggestions. */
export type Choices = Partial<Record<ModuleId, boolean>>;

/** How a module is drawn: on the walker, suggested but off, off, or not built yet. */
export type PartState = "on" | "suggested" | "off" | "unavailable";

const ORDER = MODULE_CATALOG.modules.map((m) => m.id);
const entryOf = (id: ModuleId) => getCatalogEntry(MODULE_CATALOG, id);
export const nameOf = (id: ModuleId) => entryOf(id).name;

/** Why a module's switch can't move, or null when it can. */
export function lockReason(entry: ModuleCatalogEntry): string | null {
  if (entry.default === "required") return "Part of every walker, so it stays on.";
  if (entry.availability === "deferred") return "Not available yet, so it can't be turned on.";
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

export function partStates(recs: readonly Recommendation[], selected: readonly ModuleId[]): Record<ModuleId, PartState> {
  const byId = new Map(recs.map((r) => [r.module_id, r]));
  return Object.fromEntries(
    ORDER.map((id) => {
      const status = byId.get(id)?.status;
      const state: PartState = selected.includes(id)
        ? "on"
        : entryOf(id).availability === "deferred"
          ? "unavailable"
          : status === "recommended" || status === "consider"
            ? "suggested"
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

/** One plain line on why a module was suggested, from the recommendation's reasons; null when it wasn't. */
export function whySuggested(rec: Recommendation | undefined, facts: readonly ProfileFact[]): { reason: string; because: string | null } | null {
  if (!rec || rec.status === "not_suggested") return null;
  const reason = rec.reasons.find((r) => r.fact_id) ?? rec.reasons[0];
  if (!reason) return null;
  const fact = reason.fact_id ? facts.find((f) => f.id === reason.fact_id) : undefined;
  const because = fact ? (fact.source === "chosen" ? fact.text : `“${fact.text}”`) : null;
  return { reason: reason.text, because };
}

/** The short status under a module's name. `review`: the person is choosing, so on/off is theirs. */
export function stateLabel(id: ModuleId, state: PartState, review: boolean): string {
  if (state === "unavailable") return "Not available yet";
  if (entryOf(id).default === "required") return "Always included";
  if (review) return state === "on" ? "On your walker" : state === "suggested" ? "Suggested, off" : "Off";
  if (state === "on") return "Suggested";
  return state === "suggested" ? "Worth considering" : "Not yet";
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

export interface HeardGroup {
  questionId: ProfileFact["question_id"];
  /** The question as it was asked (the agent may have reworded it). */
  prompt: string;
  items: string[];
}

/** "Here's what I heard": the facts, grouped under the question each answered, in the order they came up. */
export function heardSummary(facts: readonly ProfileFact[], turns: readonly Turn[]): HeardGroup[] {
  const groups: HeardGroup[] = [];
  for (const fact of facts) {
    let group = groups.find((g) => g.questionId === fact.question_id);
    if (!group) {
      const asked = turns.filter((t) => t.role === "assistant" && t.question_id === fact.question_id).at(-1);
      group = { questionId: fact.question_id, prompt: asked?.text ?? "Your answer", items: [] };
      groups.push(group);
    }
    group.items.push(fact.source === "chosen" ? fact.text : `“${fact.text}”`);
  }
  return groups;
}
