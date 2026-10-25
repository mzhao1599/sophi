import { describe, expect, it } from "vitest";
import { saysClearOrSafe, type WalkerReply } from "../../src/walker/assistant";

/** The words Sophi never says about the way ahead (assistant.ts, saysClearOrSafe). */
const reply = (text: string, extra: Partial<WalkerReply> = {}): WalkerReply => ({ transcript: "", reply: text, topics: ["obstacles"], cues_change: null, ...extra });

describe("saysClearOrSafe", () => {
  it.each([
    "The way is clear.",
    "CLEAR ahead.",
    "It's all-clear.",
    "It’s safe to walk.",
    "I cannot say if the way is clear.",
    "The path has been cleared.",
    "There's enough clearance.",
    "It's safer to the left.",
    "For your safety, slow down.",
    "Walk safely.",
    "That looks unsafe.",
  ])("catches %j", (text) => {
    expect(saysClearOrSafe(reply(text))).toBe(true);
    // Whatever the model tagged.
    expect(saysClearOrSafe(reply(text, { topics: ["other"] }))).toBe(true);
  });

  it.each(["The front sensor measured something 64 centimetres ahead just now.", "I didn't hear you clearly.", "Nuclear safeguards.", "Clearwater is a city."])("passes %j", (text) => {
    expect(saysClearOrSafe(reply(text))).toBe(false);
  });

  it("skips replies whose words the server replaces: arms and offers", () => {
    expect(saysClearOrSafe(reply("It's safe.", { topics: ["arms"] }))).toBe(false);
    expect(saysClearOrSafe(reply("Sounds are safer.", { topics: ["settings"], cues_change: { cues: ["sound", "spoken"] } }))).toBe(false);
  });

  it("skips a step the server words itself, but reads the answer after a sensors card", () => {
    expect(saysClearOrSafe(reply("Let me show you if it's clear.", { tool_call: { name: "show_on_screen", view: "sensors" } }))).toBe(false);
    // The final answer carries no tool call: it is checked.
    expect(saysClearOrSafe(reply("It's on your screen, and the way is clear."))).toBe(true);
  });
});
