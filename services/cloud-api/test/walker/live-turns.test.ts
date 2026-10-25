// The walker assistant's demo lines (design beats 2 to 5) through the real walker service, as typed
// text and as synthetic voice clips, routed as the server routes them: typed turns to Claude when
// ANTHROPIC_API_KEY is set (else Gemini), spoken turns to Gemini. Runs only when asked for, on a Mac (it makes the clips
// with `say` and `ffmpeg`, writing files only; nothing plays aloud):
//
//   WALKER_LIVE=1 pnpm --filter @walker/cloud-api walker-live
//
// It reads GEMINI_API_KEY and ANTHROPIC_API_KEY from the environment, or else from apps/web/.env.local
// (WALKER_LIVE_ENV_FILE names another file), and never prints them. WALKER_LIVE_MODES picks the modes
// ("text,audio" by default; "text" runs without a Gemini key when Claude reads typed turns). Only the presenter's scripted, fictional lines and three
// fresh wordings reach the model, and the voice is synthetic, so no real person is recorded. Each turn's
// latency and the model that answered it are printed. The models are the server's own, from
// walkerModelsFromEnv: WALKER_AGENT_MODEL, WALKER_BACKUP_MODEL ("none" for one model) and
// WALKER_BACKUP_AFTER_MS apply here as on the server. WALKER_LIVE_RUNS sets the runs per mode (3).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sameCues, type CapabilityManifest, type DeviceTurnRequest, type WalkerTurnResponse } from "@walker/contracts";
import { MemoryWalkerStore, WalkerService, createWalkerAssistantFor, walkerModelsFromEnv, walkerTypedAssistantFromEnv, type TurnEvent } from "../../src";
import { PRESS_CONFIRM, SIMULATED_READINGS } from "../../src/walker/lines";
import { Clock, snapshot } from "./support";

/** The walker as devices/pi's simulator reports it: the walker itself as `sim-coordinator`, its serial parts (simulated) and its own voice. */
function demoManifest(clock: Clock): CapabilityManifest {
  const part = (module_id: CapabilityManifest["modules"][number]["module_id"], instance_id: string, simulated: boolean) => ({
    module_id,
    instance_id,
    firmware_version: null,
    protocol_version: module_id === "voice" || module_id === "base.walker" ? null : 1,
    health: "ok" as const,
    faults: [],
    observed_at: clock.iso(-100),
    simulated,
  });
  return {
    device_configuration_version: 1,
    generated_at: clock.iso(),
    simulator: true,
    modules: [
      part("base.walker", "sim-coordinator", true),
      part("controls.hand", "hand-left-01", true),
      part("perception.tof", "tof-front-01", true),
      part("voice", "voice-mac", false),
    ],
  };
}

const live = process.env.WALKER_LIVE === "1";
const ENV_FILE = process.env.WALKER_LIVE_ENV_FILE?.trim() || fileURLToPath(new URL("../../../../apps/web/.env.local", import.meta.url));
if (live && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/** The walker's models as the server picks them from its environment. */
const MODELS = walkerModelsFromEnv(process.env);
const MODES = (process.env.WALKER_LIVE_MODES ?? "text,audio").split(",").map((m) => m.trim()) as ("text" | "audio")[];

/** The server's two model steps: Gemini (spoken turns, and typed ones without Claude) and Claude (typed turns). */
function assistants() {
  const gemini = process.env.GEMINI_API_KEY?.trim();
  const typed = walkerTypedAssistantFromEnv(process.env);
  if (MODES.includes("audio") && !gemini) throw new Error("GEMINI_API_KEY isn't set here or in apps/web/.env.local (spoken turns need it; WALKER_LIVE_MODES=text skips them).");
  if (!gemini && !typed) throw new Error("Neither GEMINI_API_KEY nor ANTHROPIC_API_KEY is set here or in apps/web/.env.local.");
  return { assistant: gemini ? createWalkerAssistantFor(gemini, MODELS) : null, typed };
}

const ARMS = "This walker doesn't have robot arms, so I can't pick things up or move things.";
const words = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean);

type Check = (r: WalkerTurnResponse, mode: "text" | "audio") => void;
const askCanHelp: Check = (r) => {
  expect(r.turn.answered_by).toBe("model");
  expect(r.proposal).toBeNull();
  // Every part the walker reports works, so nothing may be called broken or missing.
  expect(r.turn.reply).not.toMatch(/not respond|unavailable|isn't working|not working|offline/i);
};
const askObstacle: Check = (r, mode) => {
  // Typed on the page, the server reads the sensors itself (distance_guard): its own words, with the numbers.
  // Spoken, the walker runs get_distance and the model answers from the result.
  expect(r.turn.answered_by).toBe(mode === "text" ? "fixed" : "model");
  expect(r.turn.reply.endsWith(SIMULATED_READINGS)).toBe(true);
  expect(r.turn.reply).not.toMatch(/\b(clear|safe)\b/i);
  expect(r.turn.reply).toMatch(/\d|centimet|metre|meter/i);
};
const askShortSounds: Check = (r) => {
  expect(r.turn.answered_by).toBe("model");
  expect(r.proposal).toMatchObject({ state: "open", base_configuration_version: 1, summary: "Switch your alerts from buzzing to short sounds." });
  // Short sounds instead of buzzing, speech kept: exactly the change asked for.
  expect(sameCues(r.proposal!.cues, ["sound", "spoken"])).toBe(true);
  expect(r.turn.reply).toBe(`I can switch your alerts from buzzing to short sounds. ${PRESS_CONFIRM}`);
};
const askArms: Check = (r) => {
  expect(r.turn).toMatchObject({ answered_by: "fixed", reply: ARMS });
  expect(r.proposal).toBeNull();
};

const SCRIPT: { beat: string; line: string; check: Check }[] = [
  { beat: "2", line: "What can you help me with?", check: askCanHelp },
  { beat: "3", line: "Is anything in front of me?", check: askObstacle },
  { beat: "4", line: "Stop buzzing me, use short sounds instead.", check: askShortSounds },
  { beat: "5", line: "Can you pick up my keys?", check: askArms },
];
const FRESH: { beat: string; line: string; check: Check }[] = [
  { beat: "2'", line: "Which parts of my walker are working right now?", check: askCanHelp },
  { beat: "3'", line: "How close is the nearest thing ahead of me?", check: askObstacle },
  { beat: "4'", line: "Could you beep at me instead of shaking the handles?", check: askShortSounds },
];

describe.skipIf(!live)("live walker turns", () => {
  it(
    "answers every scripted line, typed and spoken, on every run",
    async () => {
      const models = assistants();
      const runs = Number(process.env.WALKER_LIVE_RUNS ?? 3);
      const dir = mkdtempSync(join(tmpdir(), "walker-live-"));
      const clips = new Map<string, string>();
      for (const { line } of MODES.includes("audio") ? [...SCRIPT, ...FRESH] : []) {
        const aiff = join(dir, `${clips.size}.aiff`);
        const wav = join(dir, `${clips.size}.wav`);
        execFileSync("say", ["-o", aiff, line]);
        execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", aiff, "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", wav]);
        clips.set(line, readFileSync(wav).toString("base64"));
      }
      rmSync(dir, { recursive: true });

      const events: TurnEvent[] = [];
      const clock = new Clock();
      clock.t = Date.now();
      const service = new WalkerService(new MemoryWalkerStore(), { ...models, onTurn: (e) => events.push(e) });
      const rows: string[] = [];
      const failures: string[] = [];

      async function walker() {
        const { secret, response } = await service.createPairingCode({ kind: "owner", secret: undefined });
        const paired = await service.pair({ code: response.code, service_version: "live" }, "live");
        return { secret, id: paired.device_id, credential: paired.credential };
      }
      async function ask(w: { secret: string; id: string; credential: string }, line: string, mode: "text" | "audio", beat: string, run: number, check: Check) {
        clock.t = Date.now();
        await service.heartbeat({ kind: "device", credential: w.credential }, w.id, {
          sent_at: clock.iso(),
          service_version: "live",
          manifest: demoManifest(clock),
          snapshot: snapshot(clock),
          events: [],
        });
        const client_turn_id = crypto.randomUUID();
        const started = performance.now();
        // Typed lines come from the walker's page, as people type them; spoken ones from the walker, which
        // continues a tool request as the Pi does: the transcript as text, original_audio, the tool results.
        let r = mode === "text"
          ? await service.turn({ kind: "owner", secret: w.secret }, w.id, { client_turn_id, input: { type: "text", text: line } })
          : await service.turn({ kind: "device", credential: w.credential }, w.id, { client_turn_id, input: { type: "audio", mime: "audio/wav", data_base64: clips.get(line)!, duration_ms: 3000 }, snapshot: snapshot(clock) });
        let steps = 0;
        while (r.tool_call && steps++ < 3) {
          const continuation: DeviceTurnRequest = { client_turn_id, input: { type: "text", text: (r.turn.heard ?? line).slice(0, 500) }, snapshot: snapshot(clock), tool_results: r.tool_results ?? [], original_audio: true };
          r = await service.turn({ kind: "device", credential: w.credential }, w.id, continuation);
        }
        const ms = Math.round(performance.now() - started);
        const e = events.at(-1)!;
        rows.push(`${beat.padEnd(3)} ${mode.padEnd(5)} run ${run} ${String(ms).padStart(5)} ms (model ${e.model_ms}, tries ${e.attempts}, ${e.model ?? "none"}) ${r.turn.answered_by.padEnd(5)} heard=${JSON.stringify(r.turn.heard)} reply=${JSON.stringify(r.turn.reply)}`);
        try {
          check(r, mode);
          if (mode === "audio") {
            expect(r.turn.heard_by).toBe("gemini");
            // The transcript has the line's words (a synthetic voice, so close to exact).
            const heard = new Set(words(r.turn.heard ?? ""));
            const missing = words(line).filter((w) => !heard.has(w));
            expect(missing.length).toBeLessThanOrEqual(1);
          }
        } catch (error) {
          failures.push(`${beat} ${mode} run ${run}: ${(error as Error).message.split("\n")[0]}`);
        }
        return r;
      }

      for (const mode of MODES) {
        for (let run = 1; run <= runs; run++) {
          const w = await walker();
          for (const { beat, line, check } of SCRIPT) {
            const r = await ask(w, line, mode, beat, run, check);
            // The demo presses Confirm after beat 4.
            if (r.proposal) await service.answer({ kind: "device", credential: w.credential }, w.id, r.proposal.proposal_id, { answer: "confirm" });
          }
        }
        for (const { beat, line, check } of FRESH) await ask(await walker(), line, mode, beat, 1, check);
      }
      console.log(`typed=${models.typed ? "claude" : MODELS.main} main=${MODELS.main} backup=${MODELS.backup ?? "none"} after_ms=${MODELS.backup ? MODELS.backupAfterMs : "-"} modes=${MODES.join(",")}`);
      console.log(rows.join("\n"));
      const latencies = rows.map((r) => Number(/(\d+) ms/.exec(r)![1])).sort((a, b) => a - b);
      const byBackup = MODELS.backup ? events.filter((e) => e.model === MODELS.backup).length : 0;
      console.log(`answered by the backup: ${byBackup} of ${events.length}`);
      console.log(`turns=${latencies.length} median=${latencies[Math.floor(latencies.length / 2)]} ms max=${latencies.at(-1)} ms`);
      expect(failures).toEqual([]);
    },
    15 * 60_000,
  );

  it("says all parts are simulated, once, on a walker whose every part is", async () => {
    const clock = new Clock();
    clock.t = Date.now();
    const service = new WalkerService(new MemoryWalkerStore(), { ...assistants(), onTurn: () => {} });
    const { response } = await service.createPairingCode({ kind: "owner", secret: undefined });
    const w = await service.pair({ code: response.code, service_version: "live" }, "live");
    const allSimulated = demoManifest(clock);
    for (const m of allSimulated.modules) m.simulated = true;
    await service.heartbeat({ kind: "device", credential: w.credential }, w.device_id, { sent_at: clock.iso(), service_version: "live", manifest: allSimulated, snapshot: snapshot(clock), events: [] });
    const r = await service.turn({ kind: "device", credential: w.credential }, w.device_id, { client_turn_id: crypto.randomUUID(), input: { type: "text", text: "Which parts are simulated?" }, snapshot: snapshot(clock) });
    console.log(`all simulated: ${r.turn.answered_by} reply=${JSON.stringify(r.turn.reply)}`);
    expect(r.turn.answered_by).toBe("model");
    expect(r.turn.reply.endsWith("All of this walker's parts are simulated.")).toBe(true);
    expect(r.turn.reply).not.toContain("Some of this walker's parts are simulated.");
  }, 60_000);
});
