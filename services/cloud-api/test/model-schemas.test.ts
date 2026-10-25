import { describe, expect, it } from "vitest";
import { ShowViewSchema } from "@walker/contracts";
import { AGENT_REPLY_JSON_SCHEMA } from "../src/onboarding/agent";
import { walkerReplyJsonSchema } from "../src/walker/assistant";

/**
 * Claude's structured outputs reject some JSON Schema keywords with a 400 on every call, before any model
 * runs, so one bad field fails every turn instantly (live, every walker turn fell back to a fixed line when
 * `distance_mm` carried `minimum`/`maximum`). Limits belong in the zod schemas that check the reply, and in
 * the prompt, never in the schema sent to the API.
 */
const REJECTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength"];

function rejectedKeywords(node: unknown, path = "$"): string[] {
  if (Array.isArray(node)) return node.flatMap((item, i) => rejectedKeywords(item, `${path}[${i}]`));
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => [
    // Inside `properties`, keys are field names, not keywords.
    ...(REJECTED.includes(key) && !path.endsWith(".properties") ? [`${path}.${key}`] : []),
    ...rejectedKeywords(value, `${path}.${key}`),
  ]);
}

describe("the schemas sent to Claude", () => {
  it("use no keyword the structured-output API rejects, in every walker variant and onboarding", () => {
    const views = ShowViewSchema.options;
    const variants = [false, true].flatMap((help) => [false, true].flatMap((routes) => [[], views].map((v) => walkerReplyJsonSchema(v, help, routes))));
    expect(variants.flatMap((schema) => rejectedKeywords(schema))).toEqual([]);
    expect(rejectedKeywords(AGENT_REPLY_JSON_SCHEMA)).toEqual([]);
  });
});
