---
name: tokenjuice-new-host
description: 'Scaffold or review a new tokenjuice host adapter (new post-tool hook or pre-tool wrapper integration). Use when adding or reviewing a new host under src/hosts/ such as a GitHub Copilot CLI adapter, a VS Code Copilot extension, a new AI coding agent integration, or when extending the install/doctor/uninstall surface in src/cli/main.ts. Covers the integration playbook checklist, the compactBashResult core seam, the hardcoded host list in the CLI, the aggregate doctor report, env-var isolation rules for host tests, and the pre-merge regression gate. Do NOT use for rule authoring (see src/rules/**) or for core reducer changes unrelated to hosts.'
argument-hint: 'Name of the new host (e.g., copilot-cli, copilot-vscode)'
---

# tokenjuice new-host adapter

## When to use

- Adding a new entry under `src/hosts/<host>/`
- Reviewing a PR that adds a host adapter
- Extending `tokenjuice install|uninstall|doctor` to cover a new surface
- Any post-tool output rewriter or pre-tool command wrapper for a new agent harness

For rule JSON changes, do not use this skill; edit `src/rules/**` directly.

## Primary references (read these first, do not duplicate them)

- [docs/integration-playbook.md](../../../docs/integration-playbook.md) — authoritative checklist (install, doctor, runtime hook, tests, regression gates, manual verification, docs updates).
- [docs/spec.md](../../../docs/spec.md) — reducer semantics and the supported-hosts table that must be updated.
- [docs/cursor-integration.md](../../../docs/cursor-integration.md) — reference for pre-tool wrap flows.
- [src/core/integrations/compact-bash-result.ts](../../../src/core/integrations/compact-bash-result.ts) — the one seam every post-tool host calls. Do not reimplement its logic inside an adapter.

### Active host-specific briefs (read if implementing that host)

If the host you are adding is `copilot-cli` or `vscode-copilot`, the
research is already done — read the brief BEFORE designing, or you
will redo hours of work. Briefs pin: host slug, install path and
filename (per-host files in the shared `~/.copilot/hooks/` dir to
avoid trampling), matcher value, captured payload fixtures, doctor
scope, env-var handling, and which v1 cuts to respect.

- [docs/_internal/README.md](../../../docs/_internal/README.md) — index.
- [docs/_internal/copilot-cli-design-brief.md](../../../docs/_internal/copilot-cli-design-brief.md) — post-tool adapter, claude-code pattern.
- [docs/_internal/vscode-copilot-chat-design-brief.md](../../../docs/_internal/vscode-copilot-chat-design-brief.md) — pre-tool wrap on `run_in_terminal`.
- Fixtures: [test/hosts/fixtures/copilot-cli-posttool.json](../../../test/hosts/fixtures/copilot-cli-posttool.json), [test/hosts/fixtures/vscode-copilot-pretool.json](../../../test/hosts/fixtures/vscode-copilot-pretool.json), [test/hosts/fixtures/vscode-copilot-posttool.json](../../../test/hosts/fixtures/vscode-copilot-posttool.json) (reference only; not used in v1).

When the two integrations ship, delete `docs/_internal/` and this
subsection.

## Procedure

### 1. Decide the integration mode

Answer these before writing any code (from the playbook):

- pre-tool shell rewrite, or post-tool output rewrite?
- file-based hook, extension/plugin, or API/SDK callback?
- text-only visible output, or does the host also expose a trusted full-output file when it truncates?
- OSes supported — in particular, is Windows supported natively or WSL-only (cursor precedent)?

If uncertain, prefer post-tool compaction via `compactBashResult`. Pre-tool wrapping is a deliberate exception (only cursor today) and requires `tokenjuice wrap` on the host shell path.

### 2. Implement the adapter

Create `src/hosts/<host>/index.ts` and, if a bundled runtime is needed (pi/opencode pattern), `src/hosts/<host>/extension/`.

Required exports per host:
- `install<Host>Hooks(options)` — atomic config write, preserves unrelated keys, idempotent.
- `uninstall<Host>Hooks(options)` (optional but preferred) — removes only tokenjuice entries.
- `doctor<Host>Hooks(options)` — returns the `disabled | warn | broken | ok` status matrix.
- A runtime entry that receives the host's tool result and calls `compactBashResult` from [src/core/integrations/compact-bash-result.ts](../../../src/core/integrations/compact-bash-result.ts). Do not reach into reducer internals; if you need new reducer behavior, put it in `src/core/`.

### 3. Wire the CLI + exports (easy to forget)

Every item below must be updated in the same PR. This list is what the playbook underspecifies:

- [src/cli/main.ts](../../../src/cli/main.ts)
  - Add the host to the hardcoded install-target list (search for the literal `"codex"` to find the switch and the usage string — both must include the new host).
  - Add `install <host>` and, if supported, `uninstall <host>` branches.
  - Add a `doctor <host>` branch and the internal runtime hook subcommand (e.g. `<host>-post-tool-use`) if the host's hook script shells out to `tokenjuice`.
  - Update the `--help` / usage text.
- [src/index.ts](../../../src/index.ts) — export `install*`, `uninstall*`, `doctor*`, the runtime function, and the result/report types.
- [src/hosts/shared/hook-doctor.ts](../../../src/hosts/shared/hook-doctor.ts) — decide whether `doctorInstalledHooks` should aggregate this host. If yes, add it and update the test; if no (openclaw-style: owned elsewhere), document why.
- [README.md](../../../README.md) command list and any support table.
- [docs/spec.md](../../../docs/spec.md) supported hosts table.
- If host behavior differs materially, add a dedicated design doc under `docs/`.

### 4. Tests

Follow the pattern in [test/hosts/](../../../test/hosts/). For every new host suite:

- Snapshot and restore every env var the adapter reads. At minimum:
  - `HOME`, `PATH`, `process.platform`, `SHELL`
  - Host-specific home/config: `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_HOME`, `CURSOR_HOME`, `PI_CODING_AGENT_DIR`, `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `TOKENJUICE_CURSOR_SHELL`, `COPILOT_HOME` (Copilot CLI only; VS Code Copilot ignores it)
  - Anything new your adapter reads (add it to this list in the playbook if so).
- Use temp dirs for config paths; never read real `~/.<host>`.
- Cover: install idempotency, preservation of unrelated keys, the full doctor status matrix, runtime rewrite/skip/bypass paths, raw-mode bypass, and (if applicable) the trusted-full-output fallback.

If you add the host to `doctorInstalledHooks`, existing aggregate tests will need that host's env home pinned to a temp dir or they will leak real machine config.

### 5. Regression gate before handoff

```bash
pnpm typecheck
pnpm exec vitest run test/hosts/<host>.test.ts
pnpm exec vitest run test/hosts/codex.test.ts test/hosts/claude-code.test.ts test/hosts/pi.test.ts
# If normalization/classification changed:
pnpm exec vitest run test/core/command.test.ts test/core/classify.test.ts test/core/trace.test.ts
# Final:
pnpm verify
```

### 6. Manual smoke

```bash
pnpm build
node dist/cli/main.js install <host>
node dist/cli/main.js doctor <host>
node dist/cli/main.js wrap --format json --trace -- bash -lc "git status --short"
```

Distinguish the two truncation boundaries when debugging output:
- `... omitted ...` → reducer truncation; rerun with `--raw`.
- `[tokenjuice: output truncated]` → capture truncation; rerun with a larger `--max-capture-bytes`.

## Review checklist

Use when reviewing a new-host PR. Each item maps to a failure mode seen in past host work.

- [ ] Adapter calls `compactBashResult` and does not duplicate reducer logic.
- [ ] Install is atomic and preserves unrelated config keys.
- [ ] Uninstall (if present) removes only tokenjuice entries.
- [ ] Doctor returns every status in `disabled | warn | broken | ok` under test.
- [ ] Runtime hook parses payloads defensively and does not throw on bad input.
- [ ] Raw-mode bypass is honored.
- [ ] `src/cli/main.ts` install list, usage string, and switch all mention the new host.
- [ ] `src/index.ts` re-exports install/uninstall/doctor/runtime + types.
- [ ] `doctorInstalledHooks` decision made explicitly (include or document exclusion).
- [ ] `README.md` and `docs/spec.md` updated.
- [ ] Host test suite snapshots every env var the adapter reads.
- [ ] Aggregate doctor test updated if the host was added to the aggregate.
- [ ] `pnpm verify` passes locally.
