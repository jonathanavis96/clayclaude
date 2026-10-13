#!/usr/bin/env python3
"""clayclaude hook for Claude Code. Appends one JSON line per event to events.jsonl beside this file.

Usage in settings.json:  python3 "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/clayclaude/hook.py" <EventName> 2>/dev/null || true
Claude Code sends the event details as JSON on stdin. This script never prints, never raises,
and always exits 0, so it can never block or break a session.
"""
import json
import os
import stat
import sys
import time

MAX_BYTES = 1000000
KEEP_BYTES = 256000


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


def main():
    event = sys.argv[1] if len(sys.argv) > 1 else ""
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
