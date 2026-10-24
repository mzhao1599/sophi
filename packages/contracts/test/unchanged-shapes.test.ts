import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as device from "../src/device";
import * as walker from "../src/walker";

/**
 * Today's deployed Pi parses walker.ts and device.ts strictly, so the circle must not change any of their
 * shapes. This pins the JSON Schema of every exported schema in both files to a committed snapshot. JSON
 * Schema doesn't carry refinements, so it pins fields, types, enums and limits, not cross-field rules.
 * Not covered: refinements and transforms (`.refine`, `.trim()`), and exports that aren't schemas (constants
 * such as PROPOSAL_TTL_MS, and functions such as checkCuesChange); the existing walker and device tests cover those.
 * A deliberate change to these contracts updates the snapshot (`vitest run -u`) in the same change, with the
 * Pi re-bundled first.
 */
function shapes(module: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(module).sort(([a], [b]) => a.localeCompare(b))) {
    if (name.endsWith("Schema") && value instanceof z.ZodType) out[name] = z.toJSONSchema(value, { unrepresentable: "any" });
  }
  return out;
}

describe("walker.ts and device.ts shapes", () => {
  it("are unchanged", async () => {
    await expect(JSON.stringify({ device: shapes(device), walker: shapes(walker) }, null, 2) + "\n").toMatchFileSnapshot(
      "fixtures/walker-device-v1.shapes.json",
    );
  });
});
