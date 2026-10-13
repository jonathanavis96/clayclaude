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

## Typed replies: bracketed paste, and Claude working (2026-10-13)

A second real 2.1.296 session (120x40 pane, "manual" permission mode, a throwaway git folder; paths neutralised as
above), used to check how a typed reply is delivered (answer.ts, SEND_PASTE_SCRIPT: `tmux load-buffer -b <name> -`
then `tmux paste-buffer -p -d -b <name>`, so Claude receives it between ESC[200~ and ESC[201~).

- `perm-bash-manual.txt`: a Bash prompt for `touch …/marker.txt`. Bracketed pastes of `2 please`, `2`, `1`, `3` and
  `y` were delivered to it one after the other. None picked an option: the screen stayed byte-for-byte the same
  (apart from the animated "●" bullet) and the command did not run (no marker file, no project settings file).
  Control: the keystroke `4` (`send-keys -l 4`) picked option 4 at once ("Interrupted · What should Claude do
  instead?"). So a reply that reaches a Select menu as a paste is ignored by it; as keystrokes it is an answer.
- A bracketed paste into the idle input box drew the draft (`❯ Reply with only the word pong`); Enter sent it and
  Claude answered.
- `busy.txt`, `busy-later.txt`: Claude working, 250 ms apart. The spinner row changes every frame ("✶ Effecting… (2s
  · ↓ 237 tokens · thinking)", then "✽ … 296 tokens · thought for 1s"); 2.1.296 shows no "esc to interrupt". The
  input box and the rows under it do not change.
- `busy-draft.txt`: a bracketed paste while Claude works: the draft is drawn in the input box.
- `busy-queued.txt`: Enter then: Claude queues the message ("❯ Press up to edit queued messages", the message shown
  above the spinner), and the model read and answered it after its current reply.

## Renaming a running session (Task 42, 2026-10-13)

A third real 2.1.296 session (100x40 pane, a throwaway folder on a private tmux socket; the path is neutralised to
`/…/rename-stub`), used to find how Claude Code renames a running session. `claude --help` has only `-n, --name` at
start; the running session has the built-in `/rename [name]` ("Rename the current conversation", alias `/name`).

- `fresh-placeholder.txt`: the idle box of a session that has had no prompt yet, with Claude's hint `❯ Try "write a
  test for <filepath>"`. Without colours it cannot be told from typed text, so it is not an empty box.
- `rename-pasted.txt`: `/rename t42 probe one` as a bracketed paste: the draft is drawn in the box and nothing is drawn
  above it (no suggestion list once the command has an argument).
- `named-idle.txt`: after Enter: "⎿ Session renamed to: t42 probe one", the box's top rule ends in the name
  (`──── t42 probe one ─`), the pane title becomes "✳ t42 probe one", and the registry file gets `name` and
  `nameSource: "user"`. No hook event was written (no UserPromptSubmit, no Stop), and no model turn ran.
- `named-idle-44.txt`, `named-idle-30.txt`: the same box in a 44- and a 30-column pane (a 40-character name): the
  rule before the name shrinks to one dash, then the name is cut with "…" and only a space is left before it. The
  prompt line is "❯", a no-break space, a space.
- `slash-suggest.txt`: `/renam` pasted with no argument: Claude draws its slash-command suggestions above the box,
  the first highlighted; Enter would pick it. The rename path presses Enter only if nothing new is above the box.
- A name with `"`, `$(x)`, `;`, `#`, `\` and `café` was taken literally.
