import { describe, expect, it } from "vitest";
import { tidyModelText } from "../src/model-text";

describe("tidying a model's words", () => {
  it.each([
    // Seen live on 2026-10-25 (3 of 6 onboarding runs, and a demo recording).
    ["Your daughter would like to know you got home okay, though location sharing isn't built yet..", "Your daughter would like to know you got home okay, though location sharing isn't built yet."],
    ["Your daughter would like to know you got home okay, though location sharing isn't built yet.}", "Your daughter would like to know you got home okay, though location sharing isn't built yet."],
    ["Mostly at home, with walks to the park and the grocery store..", "Mostly at home, with walks to the park and the grocery store."],
    ["It isn't built yet.}.", "It isn't built yet."],
    ['A buzz in the handles."}', 'A buzz in the handles."'],
    ["You asked {can it carry shopping}?", "You asked can it carry shopping?"],
    ["You'd like **help** with `buttons`.", "You'd like help with buttons."],
    ["Can it carry my bags?.", "Can it carry my bags?"],
    ["Around the house, .", "Around the house."],
    ["At home , and outside .", "At home, and outside."],
    ["Two  spaces   here.", "Two spaces here."],
    ["  Okay.  ", "Okay."],
  ])("%j becomes %j", (raw, tidy) => {
    expect(tidyModelText(raw)).toBe(tidy);
  });

  it("leaves ordinary copy, apostrophes, quotes and parentheses alone", () => {
    for (const line of ["You'd like help picking things up off the floor.", 'You said "home" and "the shop".', "The left handle (the one with the button).", "Okay! Where will you use it?", ""]) {
      expect(tidyModelText(line)).toBe(line);
    }
  });

  it("leaves a real ellipsis for the copy rules to refuse", () => {
    expect(tidyModelText("Well... at home.")).toBe("Well... at home.");
  });
});
