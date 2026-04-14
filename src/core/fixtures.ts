import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reduceExecution } from "./reduce.js";

import type { RuleFixture } from "../types.js";

export type FixtureVerificationResult = {
  id: string;
  ruleId: string;
  ok: boolean;
  path: string;
  errors: string[];
};

function fixturesRoot(): string {
  return resolve(fileURLToPath(new URL("../rules/fixtures", import.meta.url)));
}

async function listFixtureFiles(root: string): Promise<string[]> {
  async function walk(currentDir: string): Promise<string[]> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          return await walk(fullPath);
        }
        if (!entry.isFile() || !entry.name.endsWith(".fixture.json")) {
          return [];
        }
        return [fullPath];
      }),
    );
    return files.flat();
  }

  try {
    return await walk(root);
  } catch {
    return [];
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateFixture(raw: unknown): raw is RuleFixture {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.ruleId !== "string") {
    return false;
  }
  if (typeof value.input !== "object" || value.input === null || Array.isArray(value.input)) {
    return false;
  }
  if (typeof value.expect !== "object" || value.expect === null || Array.isArray(value.expect)) {
    return false;
  }

  const expect = value.expect as Record<string, unknown>;
  if ("matchedReducer" in expect && typeof expect.matchedReducer !== "string") {
    return false;
  }
  if ("family" in expect && typeof expect.family !== "string") {
    return false;
  }
  if ("contains" in expect && !isStringArray(expect.contains)) {
    return false;
  }
  if ("excludes" in expect && !isStringArray(expect.excludes)) {
    return false;
  }

  return true;
}

export async function loadBuiltinFixtures(): Promise<Array<{ fixture: RuleFixture; path: string }>> {
  const root = fixturesRoot();
  const files = await listFixtureFiles(root);

  return await Promise.all(
    files.map(async (fullPath) => {
      const parsed = JSON.parse(await readFile(fullPath, "utf8")) as unknown;
      if (!validateFixture(parsed)) {
        throw new Error(`invalid fixture: ${relative(root, fullPath)}`);
      }
      return {
        fixture: parsed,
        path: fullPath,
      };
    }),
  );
}

export async function verifyBuiltinFixtures(): Promise<FixtureVerificationResult[]> {
  const fixtures = await loadBuiltinFixtures();

  return await Promise.all(
    fixtures.map(async ({ fixture, path }) => {
      const errors: string[] = [];
      try {
        const result = await reduceExecution(fixture.input, {
          ...(fixture.input.cwd ? { cwd: fixture.input.cwd } : {}),
          maxInlineChars: 5000,
        });

        if (fixture.expect.matchedReducer && result.classification.matchedReducer !== fixture.expect.matchedReducer) {
          errors.push(
            `expected matched reducer ${fixture.expect.matchedReducer}, got ${result.classification.matchedReducer ?? "none"}`,
          );
        }
        if (fixture.expect.family && result.classification.family !== fixture.expect.family) {
          errors.push(`expected family ${fixture.expect.family}, got ${result.classification.family}`);
        }
        for (const snippet of fixture.expect.contains ?? []) {
          if (!result.inlineText.includes(snippet)) {
            errors.push(`missing expected text: ${snippet}`);
          }
        }
        for (const snippet of fixture.expect.excludes ?? []) {
          if (result.inlineText.includes(snippet)) {
            errors.push(`unexpected text present: ${snippet}`);
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      return {
        id: fixture.id,
        ruleId: fixture.ruleId,
        ok: errors.length === 0,
        path,
        errors,
      };
    }),
  );
}
