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

  it("skips a tool step's reply that the server replaces with its own line, but not when nothing was heard", () => {
    const heard = { transcript: "Walk me to the boathouse." };
    expect(saysClearOrSafe(reply("I'll find a safe route there.", { ...heard, topics: ["other"], tool_call: { name: "start_route", destination: "the boathouse" } }))).toBe(false);
    expect(saysClearOrSafe(reply("Stopping now, stay safe.", { ...heard, topics: ["other"], tool_call: { name: "stop_route" } }))).toBe(false);
    expect(saysClearOrSafe(reply("Checking where you are, safely.", { ...heard, topics: ["other"], tool_call: { name: "get_location" } }))).toBe(false);
    expect(saysClearOrSafe(reply("I'll find a safe route there.", { topics: ["other"], tool_call: { name: "start_route", destination: "the boathouse" } }))).toBe(true);
  });

  it("skips replies whose words the server replaces: arms and offers", () => {
    expect(saysClearOrSafe(reply("It's safe.", { topics: ["arms"] }))).toBe(false);
    expect(saysClearOrSafe(reply("Sounds are safer.", { topics: ["settings"], cues_change: { cues: ["sound", "spoken"] } }))).toBe(false);
  });
});
