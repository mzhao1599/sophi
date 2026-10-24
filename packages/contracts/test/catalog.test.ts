import { describe, expect, it } from "vitest";
import { MODULE_CATALOG, ModuleCatalogSchema, checkSelection } from "../src";

describe("module catalog v1", () => {
  it("parses and lists each module once", () => {
    expect(() => ModuleCatalogSchema.parse(MODULE_CATALOG)).not.toThrow();
    const ids = MODULE_CATALOG.modules.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only refers to modules that exist", () => {
    const ids = new Set(MODULE_CATALOG.modules.map((m) => m.id));
    for (const m of MODULE_CATALOG.modules) {
      for (const dep of [...m.requires, ...m.requires_any_of]) expect(ids.has(dep)).toBe(true);
    }
  });

  it("labels every estimate instead of guessing one", () => {
    for (const m of MODULE_CATALOG.modules) {
      expect(Object.values(m.estimates).every((e) => e.status === "not_measured")).toBe(true);
    }
  });
});

describe("checkSelection", () => {
  it("accepts the base walker alone", () => {
    expect(checkSelection(MODULE_CATALOG, ["base.walker"])).toEqual([]);
  });

  it("requires the base walker", () => {
    expect(checkSelection(MODULE_CATALOG, ["voice"]).map((p) => p.code)).toEqual(["required_missing"]);
  });

  it("rejects a lift without arms", () => {
    const problems = checkSelection(MODULE_CATALOG, ["base.walker", "manipulation.lift"]);
    expect(problems).toMatchObject([{ code: "requires", module_id: "manipulation.lift", needs: ["manipulation.arm"] }]);
  });

  it("asks obstacle sensors for a way to reach the user", () => {
    expect(checkSelection(MODULE_CATALOG, ["base.walker", "perception.tof"])[0]?.code).toBe("requires_any_of");
    expect(checkSelection(MODULE_CATALOG, ["base.walker", "perception.tof", "voice"])).toEqual([]);
  });

  it("refuses deferred modules", () => {
    expect(checkSelection(MODULE_CATALOG, ["base.walker", "location.gps"])[0]?.code).toBe("not_selectable");
  });
});
