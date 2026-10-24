import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as catalog from "../src/catalog";
import * as device from "../src/device";
import * as serial from "../src/serial";
import * as walker from "../src/walker";

/**
 * Today's deployed Pi, server and ESP32 firmware parse schemas from these four files (onboarding.ts is only read by the
 * web app and server, which deploy together, so it isn't pinned here), so the motion contract
 * (motion.ts, lift-serial.ts) must not change any of their shapes. This pins the JSON Schema of every exported
 * schema in them to a committed snapshot, taken on main before motion.ts existed. JSON Schema doesn't carry
 * refinements, so it pins fields, types, enums and limits, not cross-field rules. A deliberate change to one of
 * these contracts updates the snapshot (`vitest run -u`) in the same change, with every parser that reads it
 * redeployed in the right order. Same approach as the circle branch's `unchanged-shapes.test.ts`; once both
 * land, one of the two can go.
 */
function shapes(module: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(module).sort(([a], [b]) => a.localeCompare(b))) {
    if (name.endsWith("Schema") && value instanceof z.ZodType) out[name] = z.toJSONSchema(value, { unrepresentable: "any" });
  }
  return out;
}

describe("existing contract shapes", () => {
  it("are unchanged by the motion contract", async () => {
    const all = {
      catalog: shapes(catalog),
      device: shapes(device),
      serial: shapes(serial),
      walker: shapes(walker),
    };
    await expect(JSON.stringify(all, null, 2) + "\n").toMatchFileSnapshot("fixtures/existing-v1.shapes.json");
  });
});
