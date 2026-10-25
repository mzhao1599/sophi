import type { ScreenContent } from "@walker/contracts";
import type { HelpScreen } from "../src/bus";
import { describe, expect, it } from "vitest";
import { startingSettings } from "../src/screen/attach";
import { ScreenMachine, pickScreen, type ScreenModel } from "../src/screen/machine";
import { FakeClock, flush } from "./support/fakes";

/** Rows GS1 and GS2 of test/EXPECTED.md: where help sits in the walker screen's priority. */

const settings = startingSettings(undefined, Date.parse("2026-10-24T02:00:00Z"));
const base: ScreenModel = { link: "online", talk: "idle", alerts: ["vibration"], offer: null, answer: null, done: null, obstacle: null, motion: null, motionEnded: null, message: null, showing: null, navigation: null, help: null };
const open: HelpScreen = { state: "help", help: { phase: "open", sent_to: ["Maya"], shown_to: [], coming: [], confirm_okay: false } };
const name = (model: Partial<ScreenModel>, now = 0) => pickScreen({ ...base, ...model }, now, settings).content.state;
const answer = { id: 1, heard: null, reply: "It's sunny.", source: "model" as const, startedMono: 0, spokenMono: null };
const offer = { proposal_id: "11111111-1111-4111-8111-111111111111", from_cues: ["vibration" as const], cues: ["sound" as const] };
const message = { id: 1, message_id: "22222222-2222-4222-8222-222222222222", from_name: "Maya", text: "Dinner at six.", spokenMono: null };

describe("help in the walker screen's priority", () => {
  it("GS1: under her Talk and an obstacle; above the offer, Done, a message, offline and the clock", () => {
    expect(name({ help: open })).toBe("help");
    expect(name({ help: open, talk: "recording" })).toBe("listening");
    expect(name({ help: open, talk: "waiting" })).toBe("thinking");
    expect(name({ help: open, answer })).toBe("answering");
    expect(name({ help: open, obstacle: { zone: "front_left", mm: 300, simulated: true, lastNearMono: 0, near: true } })).toBe("obstacle");
    expect(name({ help: open, offer })).toBe("help");
    expect(name({ help: open, done: { result: { kind: "nothing_changed" }, untilMono: 10_000 } })).toBe("help");
    expect(name({ help: open, message })).toBe("help");
    expect(name({ help: open, link: "offline" })).toBe("help");
    expect(name({ help: { state: "help_countdown", seconds_left: 3 } })).toBe("help_countdown");
  });

  it("GS2: the hold or countdown drops an answer on screen; a request from a poll doesn't", async () => {
    const clock = new FakeClock();
    const states: ScreenContent[] = [];
    const machine = new ScreenMachine({ clock, simulator: true, settings, localTime: () => null, onState: (s) => states.push(s.screen), onError: (e) => { throw e; } });
    machine.seed({ link: "online" });
    machine.answer({ id: 1, heard: null, reply: "It's sunny.", source: "model" });
    await flush();
    machine.help(open);
    await flush();
    expect(states.at(-1)!.state).toBe("answering");
    machine.help({ state: "help_countdown", seconds_left: 8 });
    await flush();
    expect(states.at(-1)).toEqual({ state: "help_countdown", seconds_left: 8 });
    machine.help(null);
    await flush();
    expect(states.at(-1)!.state).toBe("ambient");
    machine.stop();
  });
});
