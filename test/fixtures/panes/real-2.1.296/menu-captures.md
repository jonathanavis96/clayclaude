# Real Claude Code 2.1.296 approval menus

Raw `tmux capture-pane -p -J` captures of a real Claude Code 2.1.296 session (100x40 pane, fullscreen TUI,
started in the default "manual" permission mode). Paths and the host prompt are neutralised: the project is
`/home/demo/code/harbor-notes` and the folder outside it is `/home/demo/shared`. Every prompt was answered
with Escape (or No) after the capture, so nothing ran.

The question these fixtures answer: when the tablet's Yes sends option 1, does option 1 mean exactly
"Yes, this once"?

| Type (fixture) | Options, exact text | Option 1 is exactly a single-use "Yes"? | Escape |
|---|---|---|---|
| Bash command (`perm-bash.txt`) | 1. Yes · 2. Yes, and always allow access to /home/demo/code/harbor-notes from this project · 3. Yes, and switch to auto mode · auto mode handles these prompts for you · 4. No | Yes | Same as 4 (No): the call is rejected and the turn stops with "Interrupted · What should Claude do instead?" |
| Bash command with a reusable prefix (`perm-bash-prefix.txt`) | 1. Yes · 2. Yes, and don’t ask again for: npm view * · 3. Yes, and switch to auto mode · auto mode handles these prompts for you · 4. No | Yes | Same as 4 (No) |
| Write a new file (`perm-write.txt`) | 1. Yes · 2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab) · 3. No | Yes | Same as 3 (No) |
| Edit an existing file (`perm-edit.txt`) | 1. Yes · 2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab) · 3. No | Yes | Same as 3 (No) |
| Read a file outside the project (`perm-read-outside.txt`) | 1. Yes · 2. Yes, allow reading from /home/demo/shared during this session · 3. No | Yes | Same as 3 (No) |
| WebFetch (`perm-webfetch.txt`) | 1. Yes · 2. Yes, and don't ask again for www.iana.org · 3. No, and tell Claude what to do differently (esc) | Yes | Same as 3; the option is labelled "(esc)". There is no separate footer line |
| MCP tool (`perm-mcp.txt`, obsidian server) | 1. Yes · 2. Yes, and don't ask again for obsidian — Obsidian List Files In Vault commands in /tmp… (truncated by Claude Code at the pane width) · 3. No | Yes | Same as 3 (No): "Interrupted · What should Claude do instead?" |
| Plan approval, ExitPlanMode (`plan-approval.txt`) | 1. Yes, and use auto mode · 2. Yes, manually approve edits · 3. Tell Claude what to change (with the hint "shift+tab to approve with this feedback") | **No.** Option 1 approves the plan AND switches the session to auto mode. The single-approval choice is 2 | Rejects the plan and stays in plan mode ("User rejected Claude's plan"). No numbered option is identical; the nearest is 3 with no feedback. The footer shows no Esc hint, only "ctrl+g to edit in VS Code" and the plan file path |
| AskUserQuestion (`askuser.txt`) | 1. Red · 2. Green · 3. Blue · 4. Type something. · 5. Chat about this (each answer has a description line under it) | **No.** It is not an approval menu. Option 1 is the first answer, not a "Yes" | Cancels the question without answering it. No numbered equivalent |
| Folder trust (`trust-folder.txt`) | Not numbered: ❯ No, exit · Yes, I trust this folder | **No.** The first item is "No, exit". The trust choice is the second item | "Esc to cancel", which is the same as "No, exit". Not observed, because the dialog was answered with the second item so the session could continue |
| External CLAUDE.md imports (`external-imports.txt`) | Not numbered: ❯ No, disable external imports · Yes, allow external imports | **No.** The first item is "No, disable external imports" | Same as "No, disable external imports". Observed: the session started with the imports disabled, and the decision was recorded as not approved |

Notes:
- Captured with `-J`, so lines that Claude Code wraps itself (option 2 in Write and Edit) stay as two lines.
  Trailing spaces and the blank rows above the menu are left exactly as captured.
- The trust and imports captures start with the shell lines that launched `claude` in the pane.
- WebFetch on this machine normally never prompts, because a user PreToolUse hook auto-allows it. That
  capture came from a session with the hook switched off.
- No other MCP server prompted: context7 needed OAuth and exposed no tools, so the obsidian server was used.
