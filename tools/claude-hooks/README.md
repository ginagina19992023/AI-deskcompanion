# Claude Code hooks

These are the versioned hook files used by the desktop pet for Claude task status, context-window pressure, and session/window tracking.

Copy the three files in this directory to `~/.claude/hooks/`, then configure Claude Code's user `settings.json` to call:

- `pet-status.cjs` from `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUseFailure`, `Stop`, and `TaskCompleted`.
- `pet-statusline.cjs` as the `statusLine.command`.

The current workstation already has these hooks installed. `pet-status.cjs` reads live transcript token usage and reuses the same session's official status-line window size, which also works when Claude Desktop runs Claude Code in embedded `stream-json` mode.
