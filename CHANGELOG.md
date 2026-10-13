# Changelog

All notable changes to clayclaude are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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

- **The answer sheet reads Claude Code 2.1.296's permission prompts.** That
  version draws the command between dashed rules with no blank line before the
  question, so the sheet showed the header, the command and the question as one
  long bold title, with full-width dashed lines that widened the sheet. The
  question is the title again, the header and command are the detail, and a
  rule in the detail is drawn short.

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
