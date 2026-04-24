# internal scratch docs

Temporary working notes used during the GitHub Copilot (CLI + VS Code)
integration effort. Not shipped to users and not a stable reference.

**Lifecycle**: delete this folder once the Copilot integrations land
and the durable content has been promoted into `docs/` proper (spec,
README table, per-host design docs).

Current contents:

- `copilot-integration-survey.md` — repo survey pass #1 (as-is state of
  the fork, before any Copilot-specific design).
- `copilot-cli-design-brief.md` — research + proposed architecture for
  the `github/copilot-cli` adapter (post-tool hook, claude-code
  pattern; Copilot CLI has a full `postToolUse` surface with
  `modifiedResult`).
- `vscode-copilot-chat-design-brief.md` — research + proposed
  architecture for `microsoft/vscode-copilot-chat`. VS Code's
  `PostToolUse` cannot rewrite tool output, so the only viable path
  is a cursor-style pre-tool wrap on the terminal tool, shipped via a
  VS Code extension — gated on access to the proposed hooks API.
