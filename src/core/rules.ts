import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { JsonRule } from "../types.js";
import { assertValidRule, validateRule } from "./validate-rules.js";

const RULE_PATHS = [
  "git/status.json",
  "search/rg.json",
  "generic/fallback.json",
] as const;

let cachedRules: JsonRule[] | null = null;

async function readRule(relativePath: string): Promise<JsonRule> {
  const rulesRoot = resolve(fileURLToPath(new URL("../rules", import.meta.url)));
  const fullPath = resolve(rulesRoot, relativePath);
  const raw = await readFile(fullPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  assertValidRule(parsed);
  return parsed;
}

export async function loadBuiltinRules(): Promise<JsonRule[]> {
  if (cachedRules !== null) {
    return cachedRules;
  }

  cachedRules = await Promise.all(RULE_PATHS.map((path) => readRule(path)));
  return cachedRules;
}

export async function verifyBuiltinRules(): Promise<Array<{ id: string; ok: boolean; errors: string[] }>> {
  const rulesRoot = resolve(fileURLToPath(new URL("../rules", import.meta.url)));
  return await Promise.all(
    RULE_PATHS.map(async (relativePath) => {
      const fullPath = resolve(rulesRoot, relativePath);
      const raw = JSON.parse(await readFile(fullPath, "utf8")) as unknown;
      const result = validateRule(raw);
      return {
        id: relativePath.replace(/\.json$/u, ""),
        ok: result.ok,
        errors: result.ok ? [] : result.errors,
      };
    }),
  );
}
