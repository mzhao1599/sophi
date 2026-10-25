// The demo rehearsal from docs/demo/script.md: Wren's scripted lines through the real onboarding
// service, in memory, on each of the script's three paths. The fixed questions run on every test run
// (no network), so a change that breaks the demo path fails CI. A live run on a model happens only
// when asked for:
//
//   REHEARSE_PROVIDER=anthropic pnpm --filter @walker/cloud-api rehearse
//
// It reads the key from the environment, or else from apps/web/.env.local (the demo laptop's own
// settings; REHEARSE_ENV_FILE names another file, such as the main checkout's from a worktree), and
// never prints it. Wren is made up, so only her scripted lines reach the model. REHEARSE_RUNS sets the
// number of runs (3).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModuleId, QuestionId, SessionView, TurnInput } from "@walker/contracts";
import {
  MemorySessionStore,
  OnboardingService,
  createAgentEngine,
  createAnthropicModel,
  deterministicEngine,
  type AgentEvent,
  type TurnEngine,
} from "../src";

// The persona's lines, keyed by the topic the question is about (the script tells the presenter to read the topic).
const LINES: Record<QuestionId, string> = {
  tasks: "I keep bumping into things, small buttons are hard, and I'd like help picking things up.",
  places: "Around my apartment, and at the corner shop.",
  feedback: "A buzz in the handles works best.",
  start_request: "A button on my left handle. I'd rather not talk to it.",
  reach_detail: "Mostly things I drop on the floor.",
  location: "Yes, so my family can see where the walker is.",
  anything_else: "No, that's everything.",
};

// Expected results, from the script's "What each line does" table.
const FULL_ORDER: QuestionId[] = ["tasks", "places", "feedback", "start_request", "reach_detail", "location", "anything_else"];
const BEFORE_REACH: ModuleId[] = ["controls.hand", "perception.tof", "manipulation.arm"];
const AFTER_REACH: ModuleId[] = [...BEFORE_REACH, "manipulation.lift"];
const LIT_AFTER: Record<QuestionId, ModuleId[]> = {
  tasks: BEFORE_REACH,
  places: BEFORE_REACH,
  feedback: BEFORE_REACH,
  start_request: BEFORE_REACH,
  reach_detail: AFTER_REACH,
  location: AFTER_REACH,
  anything_else: AFTER_REACH,
};
// The 3-minute script uses lines 1 to 5, the 60-second cut line 1, and each then shows the walker.
const PATHS = {
  full: { lines: 7, final: AFTER_REACH },
  three_minute: { lines: 5, final: AFTER_REACH },
  sixty_second: { lines: 1, final: BEFORE_REACH },
} as const;
type PathName = keyof typeof PATHS;

const litIds = (v: SessionView) => v.recommendations.filter((r) => r.status === "recommended" || r.status === "consider").map((r) => r.module_id);
const statusOf = (v: SessionView, id: ModuleId) => v.recommendations.find((r) => r.module_id === id)?.status;
const same = (a: readonly string[], b: readonly string[]) => JSON.stringify(a) === JSON.stringify(b);

interface TurnRecord {
  asked: QuestionId;
  next: QuestionId | "review";
  lit: ModuleId[];
  answered_by: string | null;
  event: AgentEvent | null;
  reply: string;
}

let turnCount = 0;

async function rehearse(engine: TurnEngine, path: PathName, events: AgentEvent[]) {
  const service = new OnboardingService(new MemorySessionStore(), { engine });
  const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
  let view = response.session;
  const send = async (input: TurnInput) => {
    const r = await service.turn(view.session_id, { token }, {
      client_turn_id: `20000000-0000-4000-8000-${String(++turnCount).padStart(12, "0")}`,
      last_seen_revision: view.revision,
      input,
    });
    view = r.session;
    return r;
  };
  const turns: TurnRecord[] = [];
  for (let i = 0; i < PATHS[path].lines && view.current_question; i++) {
    const asked = view.current_question.id;
    const before = events.length;
    const r = await send({ type: "text", text: LINES[asked] });
    const said = [...view.turns].reverse().find((t) => t.role === "assistant");
    turns.push({
      asked,
      next: view.current_question?.id ?? "review",
      lit: litIds(view),
      answered_by: said?.role === "assistant" ? (said.answered_by ?? null) : null,
      event: events.length > before ? events[events.length - 1]! : null,
      reply: r.assistant_text,
    });
  }
  // "Show My Walker" ends the conversation where it stands.
  if (view.current_question) await send({ type: "skip_rest" });
  const checks = {
    order: same(
      turns.map((t) => t.asked),
      FULL_ORDER.slice(0, PATHS[path].lines),
    ),
    lit_after_each_line: turns.every((t) => same(t.lit, LIT_AFTER[t.asked])),
    final_walker: same(litIds(view), PATHS[path].final),
    reached_review: view.state === "review",
    voice_not_suggested: statusOf(view, "voice") === "not_suggested",
    arms_worth_considering: statusOf(view, "manipulation.arm") === "consider",
    no_fallback: turns.every((t) => t.event === null || t.event.outcome === "agent"),
  };
  return { path, turns, checks, passed: Object.values(checks).every(Boolean) };
}

type Result = Awaited<ReturnType<typeof rehearse>>;

function report(label: string, results: Result[]) {
  for (const r of results) {
    const failed = Object.entries(r.checks).flatMap(([name, ok]) => (ok ? [] : [name]));
    console.log(`\n${label} / ${r.path}: ${r.passed ? "PASS" : `FAIL (${failed.join(", ")})`}`);
    for (const t of r.turns) {
      const timing = t.event ? ` ${t.event.outcome} in ${t.event.ms} ms (attempts ${t.event.attempts}${t.event.reason ? `, ${t.event.reason}` : ""})` : "";
      console.log(`  ${t.asked} -> ${t.next}${timing}; lit: ${t.lit.join(", ")}\n    reply: ${t.reply}`);
    }
  }
}

function timings(results: Result[]) {
  const ms = results.flatMap((r) => r.turns.flatMap((t) => (t.event ? [t.event.ms] : []))).sort((a, b) => a - b);
  if (ms.length === 0) return "no model turns";
  const median = ms.length % 2 ? ms[(ms.length - 1) / 2]! : (ms[ms.length / 2 - 1]! + ms[ms.length / 2]!) / 2;
  const fallbacks = results.flatMap((r) => r.turns).filter((t) => t.event && t.event.outcome !== "agent").length;
  return `${ms.length} model turns, ${fallbacks} fallbacks, ${(ms[0]! / 1000).toFixed(1)} to ${(ms.at(-1)! / 1000).toFixed(1)} s, median ${(median / 1000).toFixed(1)} s`;
}

describe("demo rehearsal with the fixed questions", () => {
  for (const path of Object.keys(PATHS) as PathName[]) {
    it(`walks the ${path.replace("_", "-")} path and ends on the intended walker`, async () => {
      const result = await rehearse(deterministicEngine, path, []);
      if (!result.passed) report("fixed questions", [result]);
      expect(result.checks).toEqual({
        order: true,
        lit_after_each_line: true,
        final_walker: true,
        reached_review: true,
        voice_not_suggested: true,
        arms_worth_considering: true,
        no_fallback: true,
      });
      // With the fixed questions running, replies carry no "answered by" mark at all.
      expect(result.turns.every((t) => t.answered_by === null)).toBe(true);
    });
  }
});

const provider = process.env.REHEARSE_PROVIDER?.trim();
const ENV_FILE = process.env.REHEARSE_ENV_FILE?.trim() || fileURLToPath(new URL("../../../apps/web/.env.local", import.meta.url));
if (provider && existsSync(ENV_FILE)) {
  // Fills only variables that aren't already set; nothing from the file is printed.
  process.loadEnvFile(ENV_FILE);
}

describe.skipIf(!provider)(`live demo rehearsal on ${provider ?? "a model"}`, () => {
  it(
    "passes every path on every run, with every reply from the model",
    async () => {
      if (provider !== "anthropic") throw new Error('REHEARSE_PROVIDER must be "anthropic".');
      const keyName = "ANTHROPIC_API_KEY";
      const apiKey = process.env[keyName]?.trim();
      if (!apiKey) throw new Error(`${keyName} isn't set here or in apps/web/.env.local.`);
      // The same default model the demo runs; ONBOARDING_AGENT_MODEL is ignored so the rehearsal matches the script.
      const runs = Number(process.env.REHEARSE_RUNS ?? 3);
      const all: Result[] = [];
      for (let run = 1; run <= runs; run++) {
        const events: AgentEvent[] = [];
        const model = createAnthropicModel({ apiKey });
        const engine = createAgentEngine({ model, onEvent: (e) => events.push(e) });
        const results: Result[] = [];
        for (const path of Object.keys(PATHS) as PathName[]) results.push(await rehearse(engine, path, events));
        report(`${provider} run ${run}`, results);
        console.log(`${provider} run ${run}: ${timings(results)}`);
        all.push(...results);
      }
      console.log(`\n${provider}, ${runs} run${runs === 1 ? "" : "s"}: ${all.filter((r) => r.passed).length} of ${all.length} paths passed; ${timings(all)}`);
      expect(all.filter((r) => !r.passed).map((r) => r.path)).toEqual([]);
      // Every reply on the walker path says it was read by the model, as the page shows it.
      expect(all.flatMap((r) => r.turns).every((t) => t.answered_by === "model")).toBe(true);
    },
    15 * 60_000,
  );
});
