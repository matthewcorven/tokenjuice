import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installCodexHook, runCodexPostToolUseHook } from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  delete process.env.CODEX_HOME;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tokenjuice-codex-test-"));
  tempDirs.push(dir);
  return dir;
}

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; output: string }> {
  let output = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  try {
    const code = await run();
    return { code, output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe("installCodexHook", () => {
  it("installs a single tokenjuice PostToolUse hook and preserves unrelated hooks", async () => {
    const home = await createTempDir();
    const hooksPath = join(home, "hooks.json");
    await writeFile(
      hooksPath,
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [{ type: "command", command: "echo session" }],
            },
          ],
          PostToolUse: [
            {
              matcher: "^Bash$",
              hooks: [{ type: "command", command: "python3 /tmp/post_tool_use_tokenjuice.py" }],
            },
            {
              matcher: "^Bash$",
              hooks: [{ type: "command", command: "echo keep-me", statusMessage: "keep me" }],
            },
          ],
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const result = await installCodexHook(hooksPath);
    const parsed = JSON.parse(await readFile(hooksPath, "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; statusMessage?: string }> }>>;
    };

    expect(result.hooksPath).toBe(hooksPath);
    expect(result.backupPath).toBe(`${hooksPath}.bak`);
    expect(parsed.hooks.SessionStart).toHaveLength(1);
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(parsed.hooks.PostToolUse[0]?.hooks[0]?.command).toBe("echo keep-me");
    expect(parsed.hooks.PostToolUse[1]?.matcher).toBe("^Bash$");
    expect(parsed.hooks.PostToolUse[1]?.hooks[0]?.command).toContain("codex-post-tool-use");
    expect(parsed.hooks.PostToolUse[1]?.hooks[0]?.statusMessage).toBe("compacting bash output with tokenjuice");
  });
});

describe("runCodexPostToolUseHook", () => {
  it("rewrites bash post-tool output when tokenjuice compacts it", async () => {
    const home = await createTempDir();
    process.env.CODEX_HOME = home;

    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "git status",
      },
      tool_response: [
        "On branch pr-65478-security-fix",
        "Your branch and 'origin/pr-65478-security-fix' have diverged,",
        "and have 8 and 642 different commits each, respectively.",
        "",
        "Changes not staged for commit:",
        "\tmodified:   src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts",
        "\tmodified:   src/agents/pi-embedded-runner/run/attempt.test.ts",
        "",
        "no changes added to commit",
      ].join("\n"),
    });

    const { code, output } = await captureStdout(() => runCodexPostToolUseHook(payload));
    const response = JSON.parse(output) as { decision: string; reason: string };
    const debug = JSON.parse(await readFile(join(home, "tokenjuice-hook.last.json"), "utf8")) as {
      rewrote: boolean;
      matchedReducer?: string;
    };

    expect(code).toBe(0);
    expect(response.decision).toBe("block");
    expect(response.reason).toContain("Changes not staged:");
    expect(response.reason).toContain("M: src/agents/pi-embedded-runner/run/attempt.prompt-helpers.ts");
    expect(response.reason).not.toContain("and have 8 and 642");
    expect(debug.rewrote).toBe(true);
    expect(debug.matchedReducer).toBe("git/status");
  });

  it("skips rewriting generic fallback output for compound shell diagnostics", async () => {
    const home = await createTempDir();
    process.env.CODEX_HOME = home;

    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "printf 'cwd: '; pwd; printf 'repo: '; git rev-parse --show-toplevel; git status --short --branch",
      },
      tool_response: Array.from({ length: 18 }, (_, index) => {
        if (index === 0) {
          return "cwd: /Users/vincentkoc/GIT/_Perso/openclaw";
        }
        if (index === 1) {
          return "repo: /Users/vincentkoc/GIT/_Perso/openclaw";
        }
        return `worktree /Users/vincentkoc/GIT/_Perso/openclaw/.worktrees/pr-${66200 + index}`;
      }).join("\n"),
    });

    const { code, output } = await captureStdout(() => runCodexPostToolUseHook(payload));
    const debug = JSON.parse(await readFile(join(home, "tokenjuice-hook.last.json"), "utf8")) as {
      rewrote: boolean;
      skipped?: string;
      matchedReducer?: string;
    };

    expect(code).toBe(0);
    expect(output).toBe("");
    expect(debug.rewrote).toBe(false);
    expect(debug.skipped).toBe("generic-compound-command");
    expect(debug.matchedReducer).toBe("generic/fallback");
  });

  it("skips rewriting weak generic fallback compaction", async () => {
    const home = await createTempDir();
    process.env.CODEX_HOME = home;

    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "node -e \"console.log('x')\"",
      },
      tool_response: Array.from({ length: 18 }, (_, index) => `line ${index + 1} ${"x".repeat(24)}`).join("\n"),
    });

    const { code, output } = await captureStdout(() => runCodexPostToolUseHook(payload));
    const debug = JSON.parse(await readFile(join(home, "tokenjuice-hook.last.json"), "utf8")) as {
      rewrote: boolean;
      skipped?: string;
      matchedReducer?: string;
    };

    expect(code).toBe(0);
    expect(output).toBe("");
    expect(debug.rewrote).toBe(false);
    expect(debug.skipped).toBe("generic-weak-compaction");
    expect(debug.matchedReducer).toBe("generic/fallback");
  });
});
