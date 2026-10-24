import { z } from "zod";

/**
 * Module catalog, version 1.
 *
 * The catalog is curated by the team, not by a model. The onboarding engine (and later the
 * onboarding agent) may only recommend modules listed here. Estimates stay `not_measured`
 * until a bench measurement exists; never fill them with guesses.
 */

export const CATALOG_VERSION = 1;

export const ModuleIdSchema = z.enum([
  "base.walker",
  "controls.hand",
  "perception.tof",
  "voice",
  "manipulation.arm",
  "manipulation.lift",
  "location.gps",
]);
export type ModuleId = z.infer<typeof ModuleIdSchema>;

export const EstimateSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_measured") }),
  z.object({
    status: z.literal("measured"),
    value: z.number(),
    unit: z.string().min(1),
    /** Where the number came from: a bench record in hardware/, a datasheet, a receipt. */
    source: z.string().min(1),
  }),
]);
export type Estimate = z.infer<typeof EstimateSchema>;

export const ModuleCatalogEntrySchema = z.object({
  id: ModuleIdSchema,
  name: z.string().min(1),
  /** One sentence, plain language: what a person gets from it. */
  summary: z.string().min(1),
  /** Where it sits on the walker, for the walker diagram and screen readers. */
  placement: z.string().min(1),
  limitations: z.array(z.string().min(1)),
  prerequisites: z.array(z.string().min(1)),
  /** Every listed module must also be selected. */
  requires: z.array(ModuleIdSchema),
  /** At least one of the listed modules must also be selected (for example a way to deliver a cue). */
  requires_any_of: z.array(ModuleIdSchema),
  default: z.enum(["required", "optional", "deferred"]),
  /** `deferred` modules can be shown but not selected. Nothing in this prototype is installed yet. */
  availability: z.enum(["in_development", "deferred"]),
  lighter_alternative: z.string().min(1).nullable(),
  estimates: z.object({
    cost: EstimateSchema,
    weight: EstimateSchema,
    power: EstimateSchema,
  }),
});
export type ModuleCatalogEntry = z.infer<typeof ModuleCatalogEntrySchema>;

export const ModuleCatalogSchema = z.object({
  version: z.number().int().positive(),
  modules: z.array(ModuleCatalogEntrySchema).min(1),
});
export type ModuleCatalog = z.infer<typeof ModuleCatalogSchema>;

const notMeasured = { status: "not_measured" } as const;
const unmeasured = { cost: notMeasured, weight: notMeasured, power: notMeasured };

export const MODULE_CATALOG: ModuleCatalog = ModuleCatalogSchema.parse({
  version: CATALOG_VERSION,
  modules: [
    {
      id: "base.walker",
      name: "Walker and coordinator",
      summary: "The walker frame with a Raspberry Pi that connects whichever modules you choose.",
      placement: "Frame, with the coordinator under the seat",
      limitations: [
        "A prototype for testing, not a certified mobility aid.",
        "It does not replace a caregiver or a clinician's advice.",
      ],
      prerequisites: ["A bench-tested frame, battery and stop switch"],
      requires: [],
      requires_any_of: [],
      default: "required",
      availability: "in_development",
      lighter_alternative: null,
      estimates: unmeasured,
    },
    {
      id: "controls.hand",
      name: "Hand controls",
      summary: "Large buttons and a trigger on the handles, with vibration cues you can feel.",
      placement: "Left and right handles",
      limitations: [
        "Vibration patterns are a short fixed set, so they need a moment to learn.",
        "A stop button on a handle also needs its own wired stop path before it can stop the arms.",
      ],
      prerequisites: ["At least one handle you can reach and press comfortably"],
      requires: [],
      requires_any_of: [],
      default: "optional",
      availability: "in_development",
      lighter_alternative: "If you only want spoken replies, voice alone may be enough.",
      estimates: unmeasured,
    },
    {
      id: "perception.tof",
      name: "Obstacle sensors",
      summary: "Distance sensors at the front that warn you when something is close.",
      placement: "Front of the frame, below the handles",
      limitations: [
        "Gives proximity cues only. It does not steer, brake or stop the walker.",
        "The sensors have blind spots and can miss some surfaces.",
        "Range outdoors and in bright light has not been measured yet.",
      ],
      prerequisites: ["Calibrated sensors", "A way to reach you: handle vibration or a spoken cue"],
      requires: [],
      requires_any_of: ["controls.hand", "voice"],
      default: "optional",
      availability: "in_development",
      lighter_alternative: null,
      estimates: unmeasured,
    },
    {
      id: "voice",
      name: "Voice",
      summary: "Press a button and speak to ask a question; replies are spoken and shown as text.",
      placement: "Microphone and speaker between the handles",
      limitations: [
        "It listens only after you press a button. It is not always listening.",
        "Noisy places can make speech harder to recognise.",
        "It needs an internet connection to answer.",
      ],
      prerequisites: ["Your permission to record short clips", "A microphone and speaker"],
      requires: [],
      requires_any_of: [],
      default: "optional",
      availability: "in_development",
      lighter_alternative: "If typing on a phone is comfortable, the app can do the same without voice.",
      estimates: unmeasured,
    },
    {
      id: "manipulation.arm",
      name: "Robot arms",
      summary: "Two small arms with cameras that can pick up a light object in a tested area.",
      placement: "Mounted on the lift, at the front of the frame",
      limitations: [
        "Experimental. It moves only after you press start, and you can stop it at any time.",
        "Light objects only, in an area that has been tested. Heavier lifting has not been tested.",
        "The walker has to be parked while the arms move.",
      ],
      prerequisites: ["Cameras", "Separate motor power", "A physical stop switch", "Your start signal for each task"],
      requires: [],
      requires_any_of: [],
      default: "optional",
      availability: "in_development",
      lighter_alternative:
        "If you mostly need things from one spot, a long-handled reacher or moving that spot may be enough.",
      estimates: unmeasured,
    },
    {
      id: "manipulation.lift",
      name: "Arm lift",
      summary: "Raises and lowers the arms so they can reach higher shelves or lower surfaces.",
      placement: "Upright column at the front of the frame",
      limitations: [
        "Moves only between tested heights, with hard stops at each end.",
        "The arms fold away while the lift moves.",
      ],
      prerequisites: ["Robot arms", "Limit switches and a homing sensor"],
      requires: ["manipulation.arm"],
      requires_any_of: [],
      default: "optional",
      availability: "in_development",
      lighter_alternative: null,
      estimates: unmeasured,
    },
    {
      id: "location.gps",
      name: "Location sharing",
      summary: "Lets someone you choose see where the walker is.",
      placement: "Inside the frame",
      limitations: [
        "Not built yet. It needs its own consent and privacy design first.",
        "GPS is often inaccurate indoors.",
      ],
      prerequisites: ["A GPS receiver", "A connection", "Consent from you for each person who can see it"],
      requires: [],
      requires_any_of: [],
      default: "deferred",
      availability: "deferred",
      lighter_alternative: null,
      estimates: unmeasured,
    },
  ],
});

export function getCatalogEntry(catalog: ModuleCatalog, id: ModuleId): ModuleCatalogEntry {
  const entry = catalog.modules.find((m) => m.id === id);
  if (!entry) throw new Error(`Module ${id} is not in catalog v${catalog.version}`);
  return entry;
}

export type SelectionProblem =
  | { code: "required_missing"; module_id: ModuleId; message: string }
  | { code: "not_selectable"; module_id: ModuleId; message: string }
  | { code: "requires"; module_id: ModuleId; needs: ModuleId[]; message: string }
  | { code: "requires_any_of"; module_id: ModuleId; needs: ModuleId[]; message: string };

/**
 * Checks a module selection against the catalog's dependency rules. Shared by the web app (to explain
 * the problem next to the checkbox) and the API (to reject the confirmation).
 */
export function checkSelection(catalog: ModuleCatalog, selected: readonly ModuleId[]): SelectionProblem[] {
  const chosen = new Set(selected);
  const problems: SelectionProblem[] = [];
  const nameOf = (id: ModuleId) => getCatalogEntry(catalog, id).name;
  const list = (ids: ModuleId[]) => ids.map((id) => nameOf(id).toLowerCase()).join(" or ");

  for (const entry of catalog.modules) {
    if (entry.default === "required" && !chosen.has(entry.id)) {
      problems.push({
        code: "required_missing",
        module_id: entry.id,
        message: `${entry.name} is part of every setup.`,
      });
    }
    if (!chosen.has(entry.id)) continue;
    if (entry.availability === "deferred") {
      problems.push({
        code: "not_selectable",
        module_id: entry.id,
        message: `${entry.name} isn't available yet.`,
      });
    }
    const missing = entry.requires.filter((id) => !chosen.has(id));
    if (missing.length > 0) {
      problems.push({
        code: "requires",
        module_id: entry.id,
        needs: missing,
        message: `${entry.name} needs ${list(missing)}.`,
      });
    }
    if (entry.requires_any_of.length > 0 && !entry.requires_any_of.some((id) => chosen.has(id))) {
      problems.push({
        code: "requires_any_of",
        module_id: entry.id,
        needs: entry.requires_any_of,
        message: `${entry.name} needs a way to reach you: add ${list(entry.requires_any_of)}.`,
      });
    }
  }
  return problems;
}
