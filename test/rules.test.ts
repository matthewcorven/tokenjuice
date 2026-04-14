import { describe, expect, it } from "vitest";

import { loadBuiltinRules, verifyBuiltinRules } from "../src/index.js";

describe("rules", () => {
  it("loads builtin rules successfully", async () => {
    const rules = await loadBuiltinRules();
    expect(rules.map((rule) => rule.id)).toEqual([
      "git/status",
      "search/rg",
      "generic/fallback",
    ]);
  });

  it("verifies builtin rules cleanly", async () => {
    const results = await verifyBuiltinRules();
    expect(results.every((result) => result.ok)).toBe(true);
  });
});
