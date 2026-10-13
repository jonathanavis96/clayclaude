#!/usr/bin/env python3
"""clayclaude hook for Claude Code. Appends one JSON line per event to events.jsonl beside this file.

Usage in settings.json:  python3 "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/clayclaude/hook.py" <EventName> 2>/dev/null || true
Claude Code sends the event details as JSON on stdin. This script never prints, never raises,
and always exits 0, so it can never block or break a session.

With "statusline" instead of an event name it is the status line bridge's recorder: it reads the JSON
Claude Code gives its status line command and keeps that session's context window in
context/<sessionId>.json beside this file. The bridge's shell command runs the person's own status
line itself, so nothing this script does can change or blank what the status line shows.
"""
import json
import os
import re
import stat
import sys
import time

MAX_BYTES = 1000000
KEEP_BYTES = 256000
STATUS_MAX_BYTES = 1000000
SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
PRUNE_AFTER_S = 7 * 86400
PRUNE_MAX = 500


def private_open(path, flags):
    """Open for writing with mode 0600, also tightening a file an older version left 0644: the events
    carry session ids and notification text, and the config directory is often world-readable."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | flags, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)  # not ours to write into or chmod (a FIFO with a reader, a device)
        raise OSError("not a regular file: " + path)
    try:
        os.fchmod(fd, 0o600)
    except OSError:
        pass
    return os.fdopen(fd, "ab" if flags & os.O_APPEND else "wb")


def rotate(path):
    try:
        if os.path.getsize(path) <= MAX_BYTES:
            return
        with open(path, "rb") as f:
            f.seek(-KEEP_BYTES, os.SEEK_END)
            tail = f.read()
        tail = tail[tail.find(b"\n") + 1:]
        tmp = path + ".tmp"
        with private_open(tmp, os.O_TRUNC) as f:
            f.write(tail)
        os.replace(tmp, path)
    except OSError:
        pass


def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _same(path, rec):
    """Whether the record at `path` already holds these values (all but ts)."""
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as f:
            old = json.loads(f.read(4097).decode("utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(old, dict) and all(old.get(k) == v for k, v in rec.items() if k != "ts")


def _prune(d, keep):
    """Remove records nobody has written for a week: sessions long gone. Bounded, and only run for a new session."""
    cutoff = time.time() - PRUNE_AFTER_S
    removed = 0
    for name in os.listdir(d):
        if removed >= PRUNE_MAX:
            break
        if name == keep or not (name.endswith(".json") or name.endswith(".tmp")):
            continue
        p = os.path.join(d, name)
        try:
            st = os.lstat(p)
            if stat.S_ISREG(st.st_mode) and st.st_mtime < cutoff:
                os.unlink(p)
                removed += 1
        except OSError:
            pass


def statusline():
    """Record the context window Claude Code reports for this session; nothing else from the input is kept."""
    data = json.loads(sys.stdin.buffer.read(STATUS_MAX_BYTES).decode("utf-8"))
    if not isinstance(data, dict):
        return
    sid, cw = data.get("session_id"), data.get("context_window")
    if not isinstance(sid, str) or not SESSION_ID.match(sid) or not isinstance(cw, dict):
        return
    size = _count(cw.get("context_window_size"))
    if not size or size > 100000000:
        return
    used = cw.get("used_percentage")
    if isinstance(used, bool) or not isinstance(used, (int, float)) or not 0 <= used <= 100:
        used = None
    rec = {"sessionId": sid, "ts": int(time.time() * 1000), "contextWindowSize": size,
           "usedPercentage": used, "totalInputTokens": _count(cw.get("total_input_tokens"))}
    model = data.get("model")
    model = model.get("id") if isinstance(model, dict) else None
    if isinstance(model, str) and model:
        rec["model"] = model[:200]
    d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "context")
    os.makedirs(d, 0o700, exist_ok=True)
    path = os.path.join(d, sid + ".json")
    existed = os.path.lexists(path)
    if existed and _same(path, rec):
        return  # unchanged: no write, so a status line redrawing every few seconds costs no disk
    tmp = "%s.%d.tmp" % (path, os.getpid())
    try:
        with private_open(tmp, os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)) as f:
            f.write(json.dumps(rec, separators=(",", ":")).encode("utf-8"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    if not existed:
        _prune(d, sid + ".json")


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
    if event == "statusline":
        statusline()
        return
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    event = event or data.get("hook_event_name") or ""
    session_id = data.get("session_id")
    if not event or not isinstance(session_id, str) or not session_id:
        return
    entry = {"event": event, "sessionId": session_id, "ts": int(time.time() * 1000)}
    message = data.get("message")
    if isinstance(message, str) and message:
        entry["message"] = message[:500]
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "events.jsonl")
    # O_NONBLOCK: a FIFO in its place would otherwise block the hook, and with it Claude Code, until a reader came.
    with private_open(path, os.O_APPEND | getattr(os, "O_NONBLOCK", 0)) as f:
        f.write((json.dumps(entry, separators=(",", ":")) + "\n").encode("utf-8"))
    rotate(path)


try:
    main()
except Exception:
    pass
