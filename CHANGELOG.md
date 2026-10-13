# Changelog

All notable changes to clayclaude are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Rename in Claude Code too.** The rename sheet's **Also rename in Claude
  Code** tick (off by default, offered beside **Also rename the tmux window**)
  types Claude Code's `/rename <name>` into the session, only under Message's
  idle checks, as one checked paste; Enter only when the screen shows exactly
  that command and nothing new above the input box. When it is refused,
  nothing is renamed and the sheet says why.
- **Message an idle session from the tablet.** An asleep session in tmux has
  **Message** (on its row or card, and in its focus view), which opens the answer
  sheet's reply box and quick replies and sends the text and Enter. It is typed
  only when Claude Code reports the session idle (hooks: Stop last; else the
  registry), the pane shows Claude's empty input box with nothing under it, and
  the pane identity checks pass; otherwise nothing is sent and the sheet says why.
- **+ New preselects Auto.** `launch.defaultMode` (default `auto`) is the Mode
  + New preselects and labels "(default)"; a Start that keeps it passes
  `--permission-mode`, and a host whose `claude` lacks it gets Manual. As the
  default, `bypassPermissions` needs `allowBypassPermissions: true` and then
  skips the confirm tick (the warning stays); picked by hand it still needs it.
- **+ New offers each account's real models and a permission mode.** The model
  list comes from the models API on the account's host (kept a day; the last
  good list, then a built-in one, when that fails), newest of each family
  first and the rest under **More ▾**; `launch.models` now only adds extras.
  **Mode** passes `--permission-mode` (Manual, the default, passes nothing).
  Bypass permissions is offered only with `launch.allowBypassPermissions`
  and needs a confirm before Start.
- **Clear stopped sessions.** Each stopped row and card has **Clear**, and the
  stopped filter has **Clear all stopped**. A cleared session stays hidden
  across restarts (`state.json` beside the config, mode 0600); the host's probe
  removes its registry file only when the file is a regular file directly in
  the account's `sessions/` folder, its process is dead, and its session id
  matches. Live sessions are never touched.

### Changed

- **A named session's input box is recognised.** Claude Code draws a session's
  name (`--name` or `/rename`) on the top rule of its input box; replies and
  Message now read that box as Claude's input box instead of refusing it.
- **The kiosk board goes back to full screen by itself.** After a reload, a
  tab switch, Back or a swipe, or a rotation, the board opened by the kiosk
  asks the daemon (`POST /api/kiosk/tap`) to inject its "Tap to start" tap
  again; a double-tap exit is respected until the next reload or rotation.
  Back with a sheet or the focus view open still closes it: the board waits
  for it to close before asking. Only the page the kiosk opened can ask: the
  launch URL carries a random key (`#kiosk=<key>`, new each daemon run) that
  the request must send back, so a board some website opens in a desktop
  browser cannot make the daemon tap the tablet.
  Full screen no longer locks landscape, so the board follows a rotation.
  `clayclaude demo --kiosk` opens its own Chrome tab instead of the board's.
- **Default port 8420** (was 7420), and the demo's default 8421 (was 7421).
  Windows/Hyper-V can reserve 7125-7624 after a reboot, which breaks
  `adb reverse` under WSL. A port set with `port:` in the config is unchanged,
  and `clayclaude setup` now keeps it when re-run and uses it for the tablet,
  the hotkey and the LAN address it prints.

### Fixed

- **The hotkey no longer reloads the board.** It brings Chrome forward with its
  launcher intent, showing the open board tab, instead of opening the board's
  URL, which re-navigated the tab. The scrcpy window is titled `clayclaude`, and
  the script activates it and clicks inside it, so the mouse moves to the tablet
  without a manual click.

- **The probe refuses to run on native Windows**, where its process check
  would send Ctrl+C to the sessions it watches; the daemon shows why.
  README: supported platforms and `repoRoots`.

- **Restarting the daemon no longer piles up board tabs on the tablet.** Chrome
  reuses the kiosk's tab only while it remembers which tab that was, so each
  restart could leave another board tab open. After opening the board, the
  kiosk launch now closes this port's older board tabs (`#kiosk` with an older
  launch key) through Chrome's DevTools socket. Tabs of other ports and other
  sites are never touched. The same holds for `clayclaude demo --kiosk`.

- **A permission prompt is answered Yes or No from the tablet, never with an
  option read off the screen.** Parts of a permission prompt are text the model
  wrote (the command, a file path, the "allow <prefix>" label, a question's
  body), and they could be shaped into fake options, a fake input box or a fake
  footer, so the menu the sheet read differed from Claude's: tapping "No" could
  send the digit of Claude's real "Yes", a typed reply's Enter could pick the
  highlighted "Yes", and a rule in a command could cut its dangerous part out of
  the detail. Recognising such text never converged, so the sheet no longer
  parses a permission prompt's options. It shows the whole screen as the
  terminal draws it (monospace, nothing left out or cut at a frame, a very long
  screen cut only in the middle with a marker, and a marker when the prompt's
  top is above the screen) and offers at most two buttons: **Yes** types `1`
  and **No** presses Escape. Yes is offered only when Claude's own option 1 at
  the bottom of the screen is a plain "Yes" (allow once). A plan approval's
  option 1 also switches the session to bypass, auto or accept-edits mode, so
  a plan is approved on the PC and the tablet offers No only. Other choices,
  such as "don't ask again", are made on the PC; the sheet says so and offers
  **Open** and **Attach tmux**. A prompt is a
  permission prompt when Claude Code says so (its registry waits on a
  permission, or its "needs your permission" Notification hook has not been
  answered) or when the screen is not positively one of Claude's own other
  prompts, each recognised by its bottom line, which the model cannot write: a
  startup dialog's `Enter to confirm · Esc to cancel`, an AskUserQuestion menu's
  exact `Enter to select · ↑/↓ to navigate · Esc to cancel` at column 0 (its
  numbered choices are kept, unless Claude's own "Do you want to …?" sits
  directly above them), or the input box with only status rows under it (the
  only screen that takes a typed reply). The "needs your permission"
  notification Claude Code also sends 6 seconds into an AskUserQuestion menu no
  longer turns that menu into a permission prompt.
- **Keys reach only the screen that was checked.** Claude can draw a permission
  prompt (the model's next tool call) between the moment the sheet's answer is
  checked against the screen and the moment its keys arrive, and a typed reply
  landing on it as keystrokes could approve it ("2" is "Yes, and don't ask
  again"). Every answer (an option, Yes, No, a reply and its Enter, a startup
  dialog's arrow keys and its Enter) is sent by one script on the session's
  host that reads the screen, compares its SHA-256 with the screen that was
  checked, and sends the keys in the same shell invocation, so nothing is sent
  once the screen has changed before that check. For a reply
  the check covers Claude's input box and the rows under it: the spinner above
  it redraws every frame while Claude works, and a prompt Claude draws replaces
  the input box. A reply is delivered as one bracketed paste (a paste buffer of
  its own, loaded from stdin), never as keystrokes: a real Claude Code 2.1.296
  Bash prompt ignored pasted `2 please`, `2`, `1`, `3` and `y`, while the
  keystroke `4` picked option 4. Its Enter is pressed only if the screen read
  after the paste still shows Claude's input box with the same rows, by the
  same check. A host needs `sha256sum`, `shasum` or `openssl` for the check.
  One gap is accepted by design: a reply sent while Claude works
  is queued like typing at the PC, and in a rare window of a few tens of
  milliseconds its Enter can land on a permission prompt Claude opens at that
  instant (Claude Code moves the keyboard to a new prompt before drawing it),
  picking its highlighted option: "Yes" (allow once) on a tool's prompt, but
  "Yes, and use auto mode" on a plan approval, which approves the plan and
  switches the session's permission mode to auto. A permission prompt itself
  is only ever answered Yes (`1`) or No (Escape) by your own tap.
  Claude Code 2.1.296's AskUserQuestion menu, which draws a rule between the
  model's answers and its own "Chat about this", is read as one menu keyed 1 to
  5 as Claude numbers it. Every real 2.1.296 approval menu and dialog is a test
  fixture. The sheet shows invisible format characters from the screen (a
  right-to-left override, an isolate, a mark) as visible markers such as
  `⟨U+202E⟩` and lays the screen's text out left to right in written order, as
  the terminal does, so such characters can never make the sheet read
  differently from the PC.
- **Yes and No work on a real 2.1.296 permission prompt every time.** Claude
  blinks the pending tool's `●` at column 0 while the prompt waits, which
  changed the screen's hash, so about half of the taps failed with "The prompt
  changed". The sheet's hash and the host-side check before the keys both read
  that bullet as a space now, and reading the same prompt again after an answer
  no longer reports it as a new question.
- **Claude's startup dialogs are answered only while a launch is starting**,
  and their Enter is no longer pressed blind after the arrow keys: the screen
  read after the cursor moves must be the same dialog with the chosen option
  selected, and the Enter is sent by a script that checks that screen first.
  Their `Enter to confirm · Esc to cancel` footer must start at the dialog's
  own option column.
- **The permission sheet's heading is Claude's, never the model's**: "Claude
  asks for permission", or "… to use <tool>" with the tool's name from Claude
  Code's own notification. It no longer shows the pending tool's summary.
- **The external CLAUDE.md imports dialog is titled with its own question**
  ("Allow external CLAUDE.md file imports?"), not the folder-trust question:
  the "." in "CLAUDE.md" ended the question early.
- **An answer that leads straight to a new question shows it.** The session
  stays "needs you" (the next tool's permission, say), which the sheet reported
  as "No response from the session". It now reads the screen again when the
  session's question changes or the wait runs out, and a different prompt is
  shown as the session's response.

## [0.1.0] - 2026-10-12

First release.

### Added

- **The board.** A full-screen, landscape web app for a spare Android tablet that
  shows every Claude Code session on this machine and on any host you can reach
  over ssh, in order of urgency: needs you, at the usage limit, working, compacting,
  asleep, stopped. Each row shows the session's name, account, host, what it
  is doing or asking, context use, time in that state and the prompt-cache
  countdown.
- **Grid view**: when the rows would not fit, the board switches to a grid of
  smaller cards (or keep either with the Layout setting).
- **Focus view**: tap a session for a large character, its context, model,
  effort, token and tool counts, a live tool feed, the last prompt and reply,
  the files touched, and the other sessions along the bottom.
- **State detection** from Claude Code's session registry, transcripts and
  (optional) hooks, with a single Python 3.8+ probe streamed over ssh. Nothing is
  installed on remote hosts.
- **Usage meters** per account (five-hour and weekly): `oauth` (reads the
  account's login and asks Anthropic, refreshing the token unless
  `refresh: false`), `http` (reads a URL another tool publishes) or `none`. The
  merged result is served at `GET /usage` for other dashboards.
- **Clay characters**: one animated clay figure per session, in 26 states
  (seven each for working, needs you and asleep, by time in the state and the
  prompt-cache countdown; stopped, context nearly full, usage limit,
  compacting; and the launcher's wave). Drawn live in 3D or baked on the
  tablet, or baked on the PC; Auto picks per device. `/gallery` shows them all.
- **Actions from the tablet**: open a session in Chrome (a chosen profile) or the
  Claude desktop app, attach to its tmux pane in a terminal on the PC, answer a
  permission prompt or question from the answer sheet (sent only if the prompt is
  unchanged), and start a new session from **+ New** in a repo with a chosen
  model and effort.
- **Settings panel**, kept per device: animation mode, shadows, frame-rate cap
  and body colour; layout, rings or bars, stopped-session retention and a
  needs-you chime; night dimming; answer confirmation and quick replies; and a
  read-only view of the accounts and hosts.
- **Kiosk by default** (`tablet.kiosk`): whenever the tablet connects, the
  daemon wakes it, keeps it on while charging and opens the board full screen
  (the installed app, or Chrome with one injected tap). In an ordinary Chrome
  tab, a double-tap on the clock or blank space goes full screen and locks
  landscape (double-tap again to leave).
- **`clayclaude setup`**: finds `~/.claude*` directories locally and on ssh hosts,
  asks for each account's label, colour, usage provider and open action, offers
  to install the hooks (showing the diff and backing up first), sets up the
  tablet over adb, installs the Windows hotkey, and can turn on LAN access with a
  generated token. Writes the config with mode 0600.
- **Windows hotkey** (AutoHotkey v2, Win+Shift+T by default) that wakes the
  tablet, brings the board to the front and hands the PC keyboard and mouse to it
  through scrcpy.
- **`clayclaude demo`**: a fixture board (or a gallery of every character state)
  with simulated sessions, usage and actions; no hosts or credentials are touched.
  `--sessions N` fills it for the grid view, `--adb` and `--kiosk` show it on the
  tablet.
- **Security**: listens on 127.0.0.1 only by default; Host and Origin checks on
  every request and websocket; optional LAN mode with a token, constant-time
  comparison and a lockout on repeated wrong tries.
