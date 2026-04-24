# VS Code Copilot Chat integration — design brief (internal, temporary)

> **Scope**: research notes for adding tokenjuice support to
> `microsoft/vscode-copilot-chat`. Sits next to
> `copilot-integration-survey.md` and `copilot-cli-design-brief.md`.
> Delete when the integration lands and durable content has moved into
> `docs/`.
>
> **Source discipline**: all claims below are source-verified from
> `microsoft/vscode` `main` (fetched directly from raw GitHub) and
> `microsoft/vscode-copilot-chat` `main` for tool names. Two prior
> iterations of this brief were materially wrong (first proposed-API,
> then custom-agent-markdown-frontmatter); both are superseded.

---

## 1. Bottom line

**VS Code Copilot Chat reads file-based hooks using the same topology
as Copilot CLI.** No extension, no proposed API, no custom-agent
markdown required for a global install.

A `.json` file dropped into one of the discovery folders is picked up
on every chat request (subject to two settings gates). `mergeHooks`
concatenates file-based hooks with per-agent frontmatter hooks, so
file-based hooks fire **globally** — for every request, regardless of
which agent is active.

**Live-capture corroboration (2026-04-23)**: a PostToolUse probe
installed at `~/.copilot/hooks/hooks.json` fired on a VS Code
`run_in_terminal` invocation, confirming both (a) VS Code reads the
same user-level dir as Copilot CLI and (b) PostToolUse *does* run
(the limitation below is about what the hook can MUTATE, not whether
it fires). Captured payload saved as
[test/hosts/fixtures/vscode-copilot-posttool.json](../../test/hosts/fixtures/vscode-copilot-posttool.json)
for reference — note `tool_response` is a **string** (not an object
like the CLI's `tool_result`).

However, VS Code's `PostToolUse` hook still cannot rewrite
`tool_response`. It can only `decision: 'block'` or append
`additionalContext`. The mutating seam is `PreToolUse.updatedInput`,
and that is schema-validated, so we can only wrap tools that accept a
free-form command string — in practice, the built-in terminal tool
`run_in_terminal`.

**v1 architecture**: install `~/.copilot/hooks/tokenjuice.json`
registering a single `PreToolUse` hook with matcher
`run_in_terminal`. Hook runs `tokenjuice on-pretool-vscode`, which
reads the `PreToolUse` stdin JSON and emits an `updatedInput`
rewriting `command` to `tokenjuice wrap -- <shell> -lc '<orig>'`
(same transform as the cursor adapter). Post-tool compaction is
unavailable and left out of v1.

---

## 2. Extension surface (all source-verified)

### 2.1 Hook discovery — file-based

From `promptFileLocations.ts` `DEFAULT_HOOK_FILE_PATHS`:

| Path | Scope | Source format |
|---|---|---|
| `.github/hooks/` (any `*.json`) | workspace | Copilot-native |
| `.claude/settings.local.json` | workspace | Claude-compat |
| `.claude/settings.json` | workspace | Claude-compat |
| `~/.copilot/hooks/` (any `*.json`) | user (global) | Copilot-native |
| `~/.claude/settings.json` | user (global) | Claude-compat |

Extensions can also contribute hook files via `PromptsStorage.plugin`.
`parseHooksFromFile` handles both Copilot and Claude formats —
tokenjuice should emit Copilot-native.

### 2.2 Gates (both required for hooks to fire)

From `promptsServiceImpl.ts::computeHooks`:

- `chat.useHooks` (boolean) — the master enable. Default state
  unverified; must be `true` for hooks to load.
- `workspaceTrustService.isWorkspaceTrusted()` — untrusted workspaces
  skip all hooks regardless of the setting.

`chat.useClaudeHooks` gates the Claude-format files specifically;
irrelevant for our Copilot-native path.

Any hook file may also set `disableAllHooks: true` as a kill switch
(same semantic as Copilot CLI).

### 2.3 Hook merging (the critical piece)

From `chatServiceImpl.ts::collectHooks` (~line 1104) and
`hookSchema.ts::mergeHooks`:

1. `promptsService.getHooks` loads hooks from all discovered files.
2. If a custom agent is selected, its frontmatter `hooks` are merged
   via `mergeHooks(fileBased, agent.hooks)` which **concatenates**
   arrays per hook type.
3. Result is passed to the extension host as `ChatRequestHooks`.

Implication: a file-based install gives **global coverage** — our
`PreToolUse` hook runs on every terminal invocation in every chat
request, regardless of the selected agent. This is the architecture
decision that unblocks the integration.

### 2.4 `PreToolUse` contract

Command stdin JSON:

```ts
{
  timestamp: string;
  hook_event_name: 'PreToolUse';
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}
```

Command stdout JSON (fields we care about):

```ts
{
  hookSpecificOutput?: {
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    updatedInput?: object;   // schema-validated against tool input
    additionalContext?: string;
  };
}
```

Aggregation: `deny > ask > allow`; last `updatedInput` wins; all
`additionalContext` concatenated. `updatedInput` is validated via
`IToolsService.validateToolInput(toolName, JSON.stringify(...))` —
silently dropped on schema failure.

### 2.5 `PostToolUse` contract — LIMITED

Stdout fields read:

```ts
{
  decision?: 'block';            // other values logged + ignored
  reason?: string;
  hookSpecificOutput?: { additionalContext?: string };
}
```

No `tool_response` substitution. Exit code 2 = implicit block. We do
not use this hook in v1.

### 2.6 `IHookCommand` schema (verified from `hookSchema.ts`)

Per-entry JSON supports exactly these command fields (one required):

- `command` — cross-platform.
- `windows` or `powershell` — Windows-specific override.
- `linux` or `bash` — Linux-specific override.
- `osx` or `bash` — macOS-specific override.
- `type: 'command'` — required literal after normalization.
- `matcher` — tool-name filter (`run_in_terminal` for us).

The on-disk shape matches Copilot CLI's `QU` schema (reassuring —
same underlying contract). `disableAllHooks: true` at file level
disables that file entirely.

### 2.7 Terminal tool name — verified

From `vscode-copilot-chat/src/extension/tools/common/toolNames.ts`:

```ts
CoreRunInTerminal = 'run_in_terminal',
```

So matcher is the literal string `"run_in_terminal"`. Categorized as
`ToolCategory.Core`. This is the only built-in shell tool we need to
handle in v1; MCP-provided shell tools would each have distinct names
and are out of scope for v1.

---

## 3. Proposed integration architecture

### 3.1 Host slug and CLI subcommand

- **Host slug: `vscode-copilot`** (decided). Matches the kebab-case,
  product-scoped convention of existing hosts (`codex`, `claude-code`,
  `cursor`, `opencode`, `openclaw`, `pi`). Rejected alternatives:
  `vscode` (too broad; would collide with any future non-Copilot
  VS Code integration), `vscode-copilot-chat` (verbose; our other
  slugs drop product suffixes), `copilot-chat` (ambiguous with the
  Copilot CLI adapter).
- **Runtime subcommand: `tokenjuice on-pretool-vscode`** (reads
  `PreToolUse` stdin JSON, writes the `updatedInput` JSON).
- Paired host slug: **`copilot-cli`** for the CLI adapter.
- Env vars to snapshot in tests: `HOME`, `PATH`, `SHELL`,
  `process.platform`. **Not** `COPILOT_HOME` — VS Code ignores it
  (see §3.2).

### 3.2 Install surface

**Install path: `$HOME/.copilot/hooks/tokenjuice-vscode.json`** — the
only install artifact. **Per-host filename is deliberate** (see
shared-file finding below).

**Shared-file finding with Copilot CLI (2026-04-23, live)**: with
`COPILOT_HOME` unset, both hosts scan the **same** user-level dir
`$HOME/.copilot/hooks/`. VS Code loads every `*.json` there; Copilot
CLI merges every `*.json` there. A single `hooks.json` is therefore
shared infrastructure — anything tokenjuice writes under a generic
filename will be stomped by a sibling host's install, and vice-versa.
**Mitigation**: write per-host filenames
(`tokenjuice-vscode.json` here, `tokenjuice-cli.json` in the CLI
adapter) so the two installs coexist without trampling.

**Env divergence from Copilot CLI**: VS Code resolves the hooks
folder via `pathService.userHome()` (i.e., `$HOME`) and **does NOT
honour `$COPILOT_HOME`**. Verified in `promptFileLocations.ts:193`
(path is hardcoded `'~/.copilot/hooks'`) and the tilde-expansion site
in `promptsServiceImpl.ts:780-781`. Contrast: Copilot CLI honours
`COPILOT_HOME` for its own `hooks/` dir (corrected from earlier brief
which said `config/hooks/` — the CLI's actual path is
`$COPILOT_HOME/hooks/`). Consequence — if a user sets
`COPILOT_HOME=/custom/path`, VS Code still reads
`$HOME/.copilot/hooks/` and the CLI reads `/custom/path/hooks/`.
The two hosts then live in different dirs entirely; both tokenjuice
adapters must be re-run after such an env change.

**User-setup guidance (ship in docs once this lands)**: the future
`docs/copilot-integration.md` (or equivalent) must spell out for end
users:

- That VS Code Copilot Chat and Copilot CLI share
  `~/.copilot/hooks/` by default — any hand-edited `hooks.json`
  there is read by both.
- That `tokenjuice install vscode-copilot` and
  `tokenjuice install copilot-cli` each write a distinct per-host
  filename in that dir and are safe to run together.
- That hand-rolled hook files should use per-host filenames, never
  a generic `hooks.json`, to avoid clobbering our installs.
- That `COPILOT_HOME` redirects only the CLI; running both surfaces
  with `COPILOT_HOME` set requires both installs to be re-run after
  the env change.

File contents (written to `tokenjuice-vscode.json`):

```jsonc
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "matcher": "run_in_terminal",
        "command": "tokenjuice on-pretool-vscode"
      }
    ]
  }
}
```

Absolute binary path resolved at install time (mirror the cursor
adapter's pattern — see `src/hosts/cursor/index.ts`). One file, one
entry, idempotent merge if the file already exists.

Optional: workspace variant at `.github/hooks/tokenjuice.json` for
repo-scoped install. Keep out of v1 unless a user asks; user-scope
install covers the common case globally.

### 3.3 Pre-tool runtime

In `tokenjuice on-pretool-vscode`:

1. Read JSON from stdin.
2. If `tool_name !== 'run_in_terminal'` → emit `{}` (no-op).
3. Extract the original command string from `tool_input`.
4. Emit:
   ```json
   { "hookSpecificOutput": {
       "updatedInput": { "command": "tokenjuice wrap -- <shell> -lc '<escaped-orig>'" }
   }}
   ```
5. Shell selection: honour `$SHELL` (POSIX) or emit a `powershell`
   wrapper on Windows. Cross-platform escaping follows the existing
   cursor adapter's logic — reuse, don't reinvent.

### 3.4 Install / uninstall / doctor

- `tokenjuice install vscode-copilot` — write
  `~/.copilot/hooks/tokenjuice-vscode.json` with our entry;
  idempotent; if the file already exists, merge-preserve any
  hand-added sibling entries; if a legacy `tokenjuice.json` or
  sibling `hooks.json` contains a tokenjuice entry, migrate it into
  the new per-host filename.
- `tokenjuice uninstall vscode-copilot` — remove the tokenjuice
  entry; delete the file iff it becomes empty.
- `tokenjuice doctor vscode-copilot`:
  1. Check `~/.copilot/hooks/tokenjuice-vscode.json` exists; also
     scan other `*.json` in that dir for stray tokenjuice entries
     left by older installs.
  2. Parse; locate the tokenjuice entry.
  3. Compare `command` string against current expected value (reuse
     `hosts/shared/hook-command.ts`).
  4. Check binary existence on disk.
  5. Advisory-only warning for `chat.useHooks` / workspace trust —
     we can't read VS Code's user settings reliably from outside the
     editor, but we can print the setting key the user must enable.
  6. Aggregate into `hosts/shared/hook-doctor.ts`.

### 3.5 What to leave out of v1

- `PostToolUse` integration (can't rewrite output).
- Non-terminal tools (schema would reject our wrapper).
- MCP-provided shell tools (distinct names; revisit in v2).
- Workspace-scoped install (`.github/hooks/tokenjuice.json`) — add on
  request.
- Custom-agent frontmatter install — not needed, JSON file gives us
  global coverage.
- Claude-format install — not needed, Copilot-native is first-class.

---

## 4. Remaining unknowns (minor; non-blocking)

1. ~~Default value of `chat.useHooks`~~ — **resolved 2026-04-23**:
   defaults to `true` (source: `chat.contribution.ts` line ~1325 in
   microsoft/vscode `main`, `default: true`). Caveats: (a) marked
   `restricted` + `preview` tag, (b) forced to `false` when the
   enterprise policy `chat_preview_features_enabled === false`,
   (c) `minimumVersion: '1.109'`. Doctor output should still print
   the setting key as advisory for cases where a user or policy has
   disabled it.
2. ~~`run_in_terminal` tool-input JSON schema~~ — **resolved
   2026-04-23** from live fixture
   [test/hosts/fixtures/vscode-copilot-pretool.json](../../test/hosts/fixtures/vscode-copilot-pretool.json):
   `tool_input = { command: string, explanation: string, goal: string,
   mode: 'sync' | 'async', timeout?: number }`. `command` is a
   top-level string — not nested. Our `updatedInput` must preserve
   the sibling fields (`explanation`, `goal`, `mode`, `timeout`) and
   only replace `command`.
3. Cross-platform shell escaping edge cases for Windows-native. First
   integration test target; reuse cursor's logic as the baseline.
4. MCP-tool passthrough. Confirm our matcher-miss path returns `{}`
   without breaking other tools or logging noise.
5. Snapshot freshness. Claims above are pinned to raw GitHub `main`
   at fetch time (~2026-04-23). Verify HEAD hasn't moved before
   committing architecture.

---

## 5. Implementation plan

Follow the `tokenjuice-new-host` skill checklist.

1. ~~Capture a real `PreToolUse` payload~~ — **done**. See
   [test/hosts/fixtures/vscode-copilot-pretool.json](../../test/hosts/fixtures/vscode-copilot-pretool.json).
2. **Pre-tool runtime**: add `on-pretool-vscode` subcommand in
   [src/cli/main.ts](../../src/cli/main.ts). Pure stdin→stdout JSON
   transformation — fully unit-testable.
3. **Adapter scaffold**: `src/hosts/vscode-copilot/index.ts` with
   `installVscodeCopilotHooks`, `uninstallVscodeCopilotHooks`,
   `doctorVscodeCopilotHooks`. Install writes
   `~/.copilot/hooks/tokenjuice-vscode.json` (merge-aware, idempotent).
4. **CLI wiring**: `install | uninstall | doctor vscode-copilot` in
   [src/cli/main.ts](../../src/cli/main.ts); update hardcoded host list and
   usage strings.
5. **Aggregate doctor**: add to [src/hosts/shared/hook-doctor.ts](../../src/hosts/shared/hook-doctor.ts);
   tighten aggregate tests with a temp `HOME`.
6. **Tests**: `test/hosts/vscode-copilot.test.ts` per §6 below.
7. **Docs**: README host list, [docs/spec.md](../../docs/spec.md) supported-hosts
   table, new `docs/vscode-copilot-integration.md`. Call out the
   `chat.useHooks` + workspace-trust preconditions.
8. **Integration playbook**: add a checklist entry in
   [docs/integration-playbook.md](../../docs/integration-playbook.md).
9. **Release**: bump version per [AGENTS.md](../../AGENTS.md) §Release Process.

### Relationship to the Copilot CLI adapter

Copilot CLI and VS Code share the same hook JSON schema **and the
same user-level hooks dir** (`~/.copilot/hooks/` when `COPILOT_HOME`
is unset). Factor the shared serializer/parser/idempotent-merge
logic into **`src/hosts/shared/hooks-json-file.ts`** (alongside the
existing `src/hosts/shared/hook-command.ts`). The helper must accept
a filename parameter so CLI writes `tokenjuice-cli.json` and VS Code
writes `tokenjuice-vscode.json` side-by-side without clobbering.
Build CLI first, harvest shared code, then wire VS Code.

Install-path divergence (see §3.2): CLI respects `COPILOT_HOME`,
VS Code does not. When `COPILOT_HOME` is set the two adapters write
to different dirs entirely.

---

## 6. Test coverage (required)

New suite `test/hosts/vscode-copilot.test.ts` must cover every row
below. Follow the env-snapshot pattern in
[test/hosts/cursor.test.ts](../../test/hosts/cursor.test.ts).
Snapshot and restore: `HOME`, `PATH`, `SHELL`, `process.platform`.
**Do NOT** include `COPILOT_HOME` in resolution logic — VS Code
ignores it; add a test that asserts this (set `COPILOT_HOME` to a
decoy path, run install, confirm the file lands under `$HOME` not
the decoy).

### Install

- Writes `$HOME/.copilot/hooks/tokenjuice-vscode.json` with a
  `preToolUse` entry whose `matcher` is `"run_in_terminal"` and
  whose command invokes the resolved-absolute `tokenjuice` binary.
- Ignores `$COPILOT_HOME` (assertion test).
- Idempotent: running install twice produces byte-identical output.
- Preserves hand-added sibling entries in the same file.
- Preserves unrelated top-level keys (`version`, `disableAllHooks`,
  other event arrays).
- Creates `hooks/` dir if missing.
- Migration: if a legacy `tokenjuice.json` (no host suffix) exists,
  install moves it to `tokenjuice-vscode.json`.

### Coexistence with CLI adapter (critical)

- Pre-seed `~/.copilot/hooks/tokenjuice-cli.json` with the CLI
  adapter's expected content. Run `installVscodeCopilotHooks`.
  Assert: (a) the CLI file is byte-identical, (b) the VS Code file
  is written correctly, (c) both `doctor copilot-cli` and
  `doctor vscode-copilot` subsequently return `ok`.
- Pre-seed a hand-rolled `hooks.json` with unrelated entries. Run
  install. Assert it is untouched.

### Uninstall

- Removes the tokenjuice entry.
- Deletes the file iff it becomes empty.
- No-op when nothing is installed.
- Does **not** touch sibling files.

### Doctor

Return every status from `disabled | warn | broken | ok`:
- `ok`: file exists, entry matches expected command, binary exists.
- `warn`: installed command string drifted.
- `broken`: referenced binary missing on disk.
- `disabled`: `disableAllHooks: true` at file level.
- Doctor must **also** print an advisory about `chat.useHooks` and
  workspace trust (cannot be verified from outside the editor, so
  advisory-only text must appear in output — assert on the string).

### Pre-tool runtime (`on-pretool-vscode`)

Feed [test/hosts/fixtures/vscode-copilot-pretool.json](../../test/hosts/fixtures/vscode-copilot-pretool.json)
into the subcommand and assert:
- `tool_name === "run_in_terminal"` with `tool_input.command` set →
  stdout JSON is
  `{ hookSpecificOutput: { updatedInput: { command: "tokenjuice wrap -- <shell> -lc '<escaped>'", explanation, goal, mode, timeout } } }`.
- **Sibling fields preserved**: `explanation`, `goal`, `mode`,
  `timeout` from the original `tool_input` must appear unchanged in
  `updatedInput` (schema validation silently drops malformed inputs;
  this is the #1 regression risk).
- Escaping correctness: inputs containing single quotes, double
  quotes, backslashes, `$VAR`, and newlines all round-trip through
  the wrapper unchanged when the wrapped shell evaluates them.
- Skip path: `tool_name !== "run_in_terminal"` → stdout is `{}`.
- Defensive parse: malformed stdin → stdout `{}`, exit 0, no throw.
- Platform branch: on `process.platform === "win32"`, wrapper uses
  `powershell` (or the project's documented Windows shell);
  otherwise honours `$SHELL` with `-lc`.
- Raw-mode bypass (if TOKENJUICE_RAW or equivalent) → stdout `{}`.

### Aggregate doctor

- `doctorInstalledHooks` includes `vscode-copilot`.
- Aggregate tests pin `HOME` to a temp dir.

### CLI wiring

- `install vscode-copilot`, `uninstall vscode-copilot`,
  `doctor vscode-copilot` all wired.
- `on-pretool-vscode` subcommand registered.
- `tokenjuice --help` lists the new host.
- Hardcoded install-target list updated.

### Regression gate

```bash
pnpm typecheck
pnpm exec vitest run test/hosts/vscode-copilot.test.ts
pnpm exec vitest run test/hosts/cursor.test.ts test/hosts/copilot-cli.test.ts
pnpm verify
```

Manual smoke: install into a real `$HOME/.copilot/hooks/`, enable
`chat.useHooks` in VS Code Insiders (default `true` since 1.109),
trust the workspace, run a terminal command from Copilot Chat,
confirm the tokenjuice wrapper fires.

---

## 7. Definition of Done

All items must be true before handoff.

### Code

- [ ] `src/hosts/vscode-copilot/index.ts` exports
      `installVscodeCopilotHooks`, `uninstallVscodeCopilotHooks`,
      `doctorVscodeCopilotHooks`.
- [ ] `on-pretool-vscode` subcommand in `src/cli/main.ts`:
      stdin JSON → stdout JSON, pure function.
- [ ] Uses shared `src/hosts/shared/hooks-json-file.ts` (harvested
      from CLI adapter).
- [ ] Install writes per-host filename `tokenjuice-vscode.json`.
- [ ] Install does **not** read `COPILOT_HOME`.
- [ ] `updatedInput` preserves sibling tool_input fields
      (`explanation`, `goal`, `mode`, `timeout`).
- [ ] Cross-platform shell escaping reuses cursor's logic; no
      reinvention.
- [ ] Matcher-miss and bad-input paths return `{}` without throwing.

### Wiring

- [ ] `src/cli/main.ts`: `install`, `uninstall`, `doctor`,
      `on-pretool-vscode` branches + usage text + hardcoded host list
      all updated.
- [ ] `src/index.ts`: all three surface functions + runtime + types
      re-exported.
- [ ] `src/hosts/shared/hook-doctor.ts`: host added to aggregate.

### Tests

- [ ] `test/hosts/vscode-copilot.test.ts` covers every row in §6.
- [ ] Fixture [vscode-copilot-pretool.json](../../test/hosts/fixtures/vscode-copilot-pretool.json)
      drives at least the runtime happy-path, sibling-preservation,
      and matcher-skip tests.
- [ ] Coexistence test with CLI adapter passes.
- [ ] `COPILOT_HOME`-ignored assertion test present.
- [ ] Aggregate doctor test updated; does not leak real `$HOME`.
- [ ] `pnpm verify` passes locally.

### Docs

- [ ] [README.md](../../README.md) host list + support table updated.
- [ ] [docs/spec.md](../../docs/spec.md) supported-hosts table
      updated.
- [ ] [docs/integration-playbook.md](../../docs/integration-playbook.md)
      env-var list updated (note: VS Code ignores `COPILOT_HOME`).
- [ ] Public `docs/vscode-copilot-integration.md` created; covers
      `chat.useHooks` default (true since 1.109) + enterprise policy
      override + workspace-trust requirement.
- [ ] User-setup guidance section from §3.2 appears in the public
      docs (shared-file trampling warning).
- [ ] `docs/_internal/vscode-copilot-chat-design-brief.md` and
      `docs/_internal/copilot-cli-design-brief.md` deleted together
      after both integrations ship.

### Release

- [ ] Version bumped per [AGENTS.md](../../AGENTS.md) §Release Process.
- [ ] `pnpm release:local` green.
