import { describe, expect, it } from "vitest";
import { surgeSpeed } from "@/lib/motion";

describe("surgeSpeed", () => {
  it("is 1 at rest, peaks in the middle of the surge on a sin² bell, and is back to 1 at the end", () => {
    expect(surgeSpeed(-1)).toBe(1);
    expect(surgeSpeed(0)).toBeCloseTo(1);
    expect(surgeSpeed(750)).toBeCloseTo(5);
    expect(surgeSpeed(375)).toBeCloseTo(1 + 4 * Math.sin(Math.PI / 4) ** 2);
    expect(surgeSpeed(1500)).toBeCloseTo(1);
    expect(surgeSpeed(1501)).toBe(1);
    expect(surgeSpeed(Infinity)).toBe(1);
  });
});
