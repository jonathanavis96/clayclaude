#!/usr/bin/env python3
"""clayclaude host probe. Standard library only. Prints one JSON object."""
import datetime
import email.utils
import glob
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

try:
    import fcntl
except ImportError:  # not on Windows; the probe runs on Linux and macOS hosts (and refuses native Windows: main)
    fcntl = None

KEEP = {"assistant", "user", "last-prompt", "ai-title"}
REGISTRY_MAX_BYTES = 65536
REGISTRY_CLIP = 4096  # PATH_MAX: a cwd is never longer


def _no_constant(name):
    raise ValueError(f"non-standard JSON constant {name}")


def _finite_float(s):
    f = float(s)
    if f != f or f in (float("inf"), float("-inf")):
        raise ValueError(f"number {s[:32]} overflows a double")
    return f


def loads(text):
    """json.loads without NaN/Infinity: re-emitted, they would make the whole output unparseable to JSON.parse.

    That covers a literal like 1e400 too, which float() turns into inf; main's allow_nan=False would otherwise
    fail the whole snapshot on it.
    Deep nesting raises RecursionError, which is not a ValueError; it is one more kind of unparseable file."""
    try:
        return json.loads(text, parse_constant=_no_constant, parse_float=_finite_float)
    except RecursionError:
        raise ValueError("nested too deeply") from None


def expand(p):
    return os.path.expanduser(p)


RECYCLE_SLACK_S = 600  # clock steps and btime's whole seconds; a real session's process starts before it writes startedAt


def _boot_time():
    try:
        with open("/proc/stat", "rb") as f:
            for line in f:
                if line.startswith(b"btime "):
                    return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        pass
    return None


def _started_after(fields, started_at):
    """True when the process (stat fields after comm) started well after the session's startedAt: a recycled pid."""
    if isinstance(started_at, bool) or not isinstance(started_at, (int, float)):
        return False
    started_s = started_at if started_at < 1e11 else started_at / 1000  # seconds or ms
    boot = _boot_time()
    if started_s < 1e9 or boot is None:
        return False  # not a real date (before 2001), or no boot time: cannot judge
    try:
        proc_s = boot + int(fields[19]) / os.sysconf("SC_CLK_TCK")
    except (TypeError, ValueError, OSError, IndexError):
        return False
    return proc_s > started_s + RECYCLE_SLACK_S


NATIVE_WINDOWS = "clayclaude's probe does not support native Windows hosts; run Claude Code and clayclaude under WSL2"


class UnsupportedPlatform(RuntimeError):
    pass


def native_windows():
    """Native Windows, where os.kill(pid, 0) sends CTRL_C_EVENT to the process group and any other signal calls
    TerminateProcess: the liveness check would interrupt the very sessions it watches. WSL2 reports linux."""
    return sys.platform == "win32" or os.name == "nt"


def pid_live(pid, proc_start, started_at=None):
    """Whether `pid` is still the process that wrote the registry file.

    `procStart` (newer Claude Code) must match exactly. Without it, a process that started well after the
    session's `startedAt` is a recycled pid: after a reboot, low pids from months-old files belong to daemons.
    Raises UnsupportedPlatform on native Windows rather than signal anything (callers treat a raise as "cannot tell")."""
    if native_windows():
        raise UnsupportedPlatform(NATIVE_WINDOWS)
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return False  # kill(0) and kill(-n) signal process groups, so they would "succeed"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        pass
    except (OSError, OverflowError, TypeError):
        return False
    if proc_start is None and started_at is None:
        return True
    try:
        # Bytes, not text: comm is cut at 15 bytes and can end mid UTF-8 character.
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read()
    except OSError:
        # No /proc at all (macOS): pid existence is enough. With /proc, an unreadable entry means the process
        # exited mid-check or is another user's, hidden by hidepid: a recycled pid either way, not our session.
        return not os.path.exists("/proc/self/stat")
    fields = raw[raw.rfind(b")") + 2:].split()
    if proc_start is None:
        return not _started_after(fields, started_at)
    return len(fields) > 19 and fields[19] == str(proc_start).encode()


PROC = "/proc"
HEADLESS_FLAGS = ("-p", "--print")
STREAM_FLAGS = ("--input-format", "--output-format")


def headless_argv(pid):
    """Whether the process's argv is a headless claude: print mode (-p/--print) or a stream-json SDK pipe.

    For registry files without an `entrypoint` (older Claude Code). None when argv cannot be read (no /proc: macOS).
    Flags only, up to `--`: a prompt or path that merely contains "-p" does not count."""
    try:
        with open(f"{PROC}/{int(pid)}/cmdline", "rb") as f:
            raw = f.read(65536)
    except (OSError, ValueError, TypeError):
        return None
    argv = [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
    if not argv:
        return None  # a zombie or kernel thread: nothing to judge by
    for i, a in enumerate(argv[1:], 1):
        if a == "--":
            break
        if a in HEADLESS_FLAGS or a.startswith("--print="):
            return True
        name, eq, val = a.partition("=")
        if name in STREAM_FLAGS and (val if eq else (argv[i + 1] if i + 1 < len(argv) else "")) == "stream-json":
            return True
    return False


def open_regular(path):
    """Open `path` for reading only if it is a regular file, else raise OSError.

    O_NONBLOCK: opening a FIFO would otherwise wait for a writer, and the probe would hang until the
    daemon kills it, every poll. A symlink to /dev/zero or /dev/urandom would never end. Neither is ours to read."""
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise OSError(f"not a regular file: {path}")
        return os.fdopen(fd, "rb"), st
    except BaseException:
        os.close(fd)
        raise


def tail_lines(path, nbytes, strict=False):
    """Whole lines from the last `nbytes` of `path`; [] if unreadable, or raise OSError when `strict`."""
    try:
        f, st = open_regular(path)
        with f:
            size = st.st_size
            # One byte before the window tells whether its first line is whole (preceded by a newline) or cut.
            start = max(0, size - nbytes - 1)
            f.seek(start)
            buf = f.read(size - start)  # bounded even if the file grows while we read
    except OSError:
        if strict:
            raise
        return []
    text = buf.decode("utf-8", "replace")
    lines = text.split("\n")
    if start > 0:
        lines = lines[1:]  # the byte before the window, or the tail of a line cut by it
    if not text.endswith("\n"):
        lines = lines[:-1]  # last line still being written
    return [ln for ln in lines if ln.strip()]


def clip_str(s, n):
    return s[:n] if isinstance(s, str) else s


MAX_DEPTH = 64  # nothing Claude Code writes comes close; deeper would overflow the encoder's stack on output


def clip_obj(o, n, depth=0):
    """Clip every string to `n` characters and cut anything nested deeper than MAX_DEPTH."""
    if isinstance(o, str):
        return o[:n]
    if isinstance(o, (list, dict)) and depth >= MAX_DEPTH:
        return None
    if isinstance(o, list):
        return [clip_obj(x, n, depth + 1) for x in o]
    if isinstance(o, dict):
        return {k: clip_obj(v, n, depth + 1) for k, v in o.items()}
    return o


def trim_line(line, clip):
    try:
        d = loads(line)
    except ValueError:
        return None
    if not isinstance(d, dict):
        return None
    t = d.get("type")
    if t == "system":
        if d.get("subtype") != "compact_boundary":
            return None
    elif t not in KEEP:
        return None
    d.pop("toolUseResult", None)
    d.pop("wireToolInputs", None)  # duplicates tool_use inputs at full size
    if isinstance(d.get("content"), str):
        d["content"] = d["content"][:clip]
    msg = d.get("message")
    if isinstance(msg, dict) and isinstance(msg.get("content"), str):
        msg["content"] = msg["content"][:clip]
    if isinstance(msg, dict) and isinstance(msg.get("content"), list):
        out = []
        for b in msg["content"]:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt in ("text", "thinking"):
                b[bt] = clip_str(b.get(bt), clip)
                b.pop("signature", None)
            elif bt == "tool_result":
                c = b.get("content")
                if not isinstance(c, str):
                    c = json.dumps(c)
                b["content"] = c[:clip]
            elif bt == "tool_use":
                b["input"] = clip_obj(b.get("input"), clip)
            src = b.get("source")
            if isinstance(src, dict):
                src.pop("data", None)  # base64 image/document payload
            out.append(b)
        msg["content"] = out
    d = clip_obj(d, clip)  # backstop: no field the rules above miss can ship at full size
    return json.dumps(d, separators=(",", ":"))


def find_transcript(d, session_id, cwd=None, index=None):
    """`index` (a dict, filled on the first miss) maps file name to path across every project of `d`."""
    if not isinstance(session_id, str) or not session_id or "/" in session_id:
        return None
    name = session_id + ".jsonl"
    if isinstance(cwd, str) and cwd:
        # Where Claude Code puts it: one stat, not a scan of every project (thousands of them, per registry file).
        p = os.path.join(d, "projects", slug(cwd), name)
        if os.path.isfile(p):
            return p
    if index is None:
        hits = glob.glob(os.path.join(glob.escape(d), "projects", "*", glob.escape(name)))
        return hits[0] if hits else None
    if not index:
        index[None] = True  # built, even if empty
        for p in sorted(glob.glob(os.path.join(glob.escape(d), "projects", "*", "*.jsonl"))):
            index.setdefault(os.path.basename(p), p)
    return index.get(name)


def read_registry(f):
    """(data, mtime) for one registry file; data is None for anything unreadable or not a JSON object."""
    try:
        fh, st = open_regular(f)
        with fh:
            raw_bytes = fh.read(REGISTRY_MAX_BYTES + 1)
        if len(raw_bytes) > REGISTRY_MAX_BYTES:
            raise ValueError("registry file too large")  # real ones are under 1 KB
        # Not the host locale: Claude Code writes UTF-8. "replace": one odd byte in a cwd must not hide a live session.
        data = loads(raw_bytes.decode("utf-8", "replace"))
        # Shipped as-is to the daemon and the board: no field may carry a huge string.
        return (clip_obj(data, REGISTRY_CLIP) if isinstance(data, dict) else None), st.st_mtime
    except (OSError, ValueError):
        return None, 0


def snapshot(req):
    tail_bytes = int(req.get("tailBytes", 262144))
    max_lines = int(req.get("maxLines", 60))
    clip = int(req.get("clip", 2000))
    # Transcript text one snapshot may carry, and the time it may spend reading. Past either, the rest are
    # marked `deferred` (no tsig, so the caller asks again) and arrive on later polls as the caller's
    # `known` fills: a crowd of sessions slows the first polls down instead of timing every poll out.
    budget = int(req.get("budgetBytes", 4_000_000))
    budget_ms = req.get("budgetMs")
    deadline = time.monotonic() + budget_ms / 1000 if isinstance(budget_ms, int) and budget_ms > 0 else None
    # Dead registry files last touched longer ago than this are left out (the caller would hide them anyway).
    dead_after = req.get("deadAfterMs")
    known_all = req.get("known") or {}
    only = req.get("only")
    now = time.time()
    dirs, wanted = [], []
    for raw in req.get("dirs", []):
        d = expand(raw)
        known = known_all.get(raw) or {}
        regs = []
        for f in sorted(glob.glob(os.path.join(glob.escape(d), "sessions", "*.json"))):
            data, mtime = read_registry(f)
            if only and not (data and data.get("sessionId") == only):
                continue
            live = False
            reg = {"file": os.path.basename(f), "mtimeMs": int(mtime * 1000), "data": data, "live": False, "transcript": []}
            if data and isinstance(data.get("pid"), int):
                try:
                    reg["live"] = live = pid_live(data["pid"], data.get("procStart"), data.get("startedAt"))
                    # Task 45: the registry's `entrypoint` says whether it is a headless helper; older ones need argv.
                    if live and not isinstance(data.get("entrypoint"), str) and headless_argv(data["pid"]):
                        reg["headless"] = True
                except Exception:
                    pass  # one odd process must not sink the host
            if not live and dead_after is not None and (now - mtime) * 1000 > dead_after:
                continue  # Claude Code never deletes these: a sessions/ dir can hold thousands nobody will show
            if data and isinstance(data.get("pid"), int):
                sid = data.get("sessionId")
                if isinstance(sid, str) and sid and (live or now - mtime < 6 * 3600):
                    # Live first; then ones the caller has nothing for; then the newest.
                    wanted.append(((not live, sid in known, -mtime), reg, d, sid, data.get("cwd"), known))
            regs.append(reg)
        events = tail_lines(os.path.join(d, "clayclaude", "events.jsonl"), 65536)
        dirs.append({"configDir": raw, "registries": regs, "events": events})
    wanted.sort(key=lambda w: w[0])
    spent, indexes = 0, {}
    for _, reg, d, sid, cwd, known in wanted:
        tp = find_transcript(d, sid, cwd, indexes.setdefault(d, {}))
        if not tp:
            continue
        try:
            st = os.stat(tp)
            sig = f"{st.st_size}:{st.st_mtime_ns}"
            if known.get(sid) == sig:
                reg.update(tsig=sig, same=True)  # caller already has this exact tail; do not resend it
                continue
            if spent >= budget or (deadline is not None and time.monotonic() >= deadline):
                reg["deferred"] = True
                continue
            # strict: a tail we could not read must not go out under a signature the daemon would cache as current.
            kept = [x for x in (trim_line(ln, clip) for ln in tail_lines(tp, tail_bytes, strict=True)) if x]
            reg.update(tsig=sig, transcript=kept[-max_lines:])
            spent += sum(len(x) for x in reg["transcript"])
        except Exception:
            reg.update(transcript=[])  # one bad transcript must not sink the host
            reg.pop("tsig", None)
    return {"ok": True, "nowMs": int(now * 1000), "dirs": dirs}


def _reap_one(sessions, real_sessions, file, session_id):
    """Remove one registry file if, right now, it is safe: see reap()."""
    if not isinstance(file, str) or not file or file in (".", "..") or os.path.basename(file) != file or "\0" in file:
        return "not in sessions/"
    path = os.path.join(sessions, file)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return "not found"
    except OSError:
        return "unreadable"
    if not stat.S_ISREG(st.st_mode):
        return "not a regular file"  # a symlink (lstat does not follow it), a directory, a FIFO
    if os.path.dirname(os.path.realpath(path)) != real_sessions:
        return "not in sessions/"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return "unreadable"
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return "changed"
        raw = os.read(fd, REGISTRY_MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        if len(raw) > REGISTRY_MAX_BYTES:
            raise ValueError("too large")
        data = loads(raw.decode("utf-8", "replace"))
    except ValueError:
        return "unparseable"
    if not isinstance(data, dict) or data.get("sessionId") != session_id:
        return "sessionId differs"
    pid = data.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int):
        return "no pid"
    try:
        if pid_live(pid, data.get("procStart"), data.get("startedAt")):
            return "live"
    except Exception:
        return "live"  # cannot tell: treat it as live
    try:
        # The same file still, at the moment of removal (not one put in its place since it was read).
        now = os.lstat(path)
        if not stat.S_ISREG(now.st_mode) or (now.st_dev, now.st_ino) != (st.st_dev, st.st_ino):
            return "changed"
        os.unlink(path)
    except FileNotFoundError:
        return "not found"
    except OSError:
        return "could not remove"
    return "removed"


def reap(req):
    """Remove the registry files of a session the user cleared (spec §5.1). Each file is removed only if, at this
    moment, it is a regular file (not a symlink) directly inside <configDir>/sessions/ (realpath check), its JSON
    sessionId is the one asked for, and its pid is not running or is no longer the process that wrote it (the
    snapshot's liveness rule). Anything else is left alone, with the reason."""
    d = expand(req["configDir"])
    sessions = os.path.join(d, "sessions")
    results = []
    # The sessions dir itself must be a real directory, not a symlink to somewhere else.
    ok_dir = os.path.isdir(sessions) and not os.path.islink(sessions)
    real_sessions = os.path.realpath(sessions)
    try:
        before = os.stat(sessions) if ok_dir else None
    except OSError:
        before = None
    for f in req["files"]:
        reason = _reap_one(sessions, real_sessions, f, req["sessionId"]) if ok_dir else "not in sessions/"
        results.append({"file": f, "removed": reason == "removed", "reason": reason})
    # Removing a file bumps the directory's mtime, which the usage providers read as "a claude run since" (_idle_since):
    # put it back. A run that starts meanwhile still shows, by its own registry file's mtime.
    if before is not None and any(r["removed"] for r in results):
        try:
            os.utime(sessions, ns=(before.st_atime_ns, before.st_mtime_ns))
        except OSError:
            pass
    return {"ok": True, "results": results}


def bad_request(why):
    print(f"bad request: {why}", file=sys.stderr)
    sys.exit(2)


def check_request(req):
    if not isinstance(req, dict):
        bad_request("not a JSON object")
    if req.get("mode") == "snapshot":
        dirs = req.get("dirs", [])
        if not isinstance(dirs, list) or not all(isinstance(d, str) for d in dirs):
            bad_request("dirs must be a list of strings")
        known = req.get("known") or {}
        if not isinstance(known, dict) or not all(isinstance(v, dict) for v in known.values()):
            bad_request("known must map each dir to an object")
        for k in ("tailBytes", "maxLines", "clip", "budgetBytes", "budgetMs", "deadAfterMs"):
            if k in req and (isinstance(req[k], bool) or not isinstance(req[k], int) or req[k] < 0):
                bad_request(f"{k} must be a non-negative integer")
    elif req.get("mode") == "reap":
        if not isinstance(req.get("configDir"), str) or not req["configDir"]:
            bad_request("configDir must be a string")
        sid = req.get("sessionId")
        if not isinstance(sid, str) or not sid:
            bad_request("sessionId must be a non-empty string")
        files = req.get("files")
        if not isinstance(files, list) or not all(isinstance(f, str) for f in files) or len(files) > 1000:
            bad_request("files must be a list of strings")
    elif req.get("mode") in ("usage", "models"):
        accts = req.get("accounts", [])
        if not isinstance(accts, list) or not all(isinstance(a, dict) for a in accts):
            bad_request("accounts must be a list of objects")


def main():
    if native_windows():
        # Before reading the request, touching any file or checking any process: refuse the whole host.
        sys.stdout.write("\n" + json.dumps({"ok": False, "error": NATIVE_WINDOWS, "unsupportedPlatform": "win32"}) + "\n")
        return
    try:
        req = json.loads(sys.argv[1])
    except (IndexError, ValueError) as e:
        bad_request(e)
    check_request(req)
    mode = req.get("mode")
    if mode == "snapshot":
        out = snapshot(req)
    elif mode == "usage":
        out = usage(req)
    elif mode == "repos":
        out = repos(req)
    elif mode == "cli":
        out = cli(req)
    elif mode == "discover":
        out = discover(req)
    elif mode == "reap":
        out = reap(req)
    elif mode == "models":
        out = models(req)
    else:
        print(f"unknown mode {mode!r}", file=sys.stderr)
        sys.exit(2)
    # Leading newline: text a remote shell startup file printed without one cannot join the JSON line.
    sys.stdout.write("\n" + json.dumps(out, separators=(",", ":"), allow_nan=False) + "\n")


USAGE_URL = os.environ.get("CLAYCLAUDE_USAGE_URL", "https://api.anthropic.com/api/oauth/usage")
TOKEN_URL = os.environ.get("CLAYCLAUDE_TOKEN_URL", "https://platform.claude.com/v1/oauth/token")
# Claude Code's public OAuth client id (bundled in the CLI; not a secret).
OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"  # gitleaks:allow (public client id)
# The usage endpoint answers 429 (rate_limit_error, Retry-After: 0) to every request whose
# User-Agent is not Claude Code's, e.g. Python-urllib (verified 2026-10-12). Any claude-code/<v> passes.
USER_AGENT = os.environ.get("CLAYCLAUDE_USER_AGENT", "claude-code/2.1.296 (clayclaude)")
HTTP_TIMEOUT = 8


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """urllib carries every header, Authorization included, on to wherever a 30x points (http too). None of these
    endpoints redirects, so a 30x is an error here, and no token or refresh token goes anywhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_open = urllib.request.build_opener(_NoRedirect()).open
LOCK_TIMEOUT = 20  # longer than one refresh (HTTP_TIMEOUT plus the write) by another probe
_deadline = None  # monotonic time by which this probe must have answered (request "budgetMs")


def _left():
    return float("inf") if _deadline is None else _deadline - time.monotonic()


def _need(seconds, what):
    """Refuse to start a step that could still be running when the daemon kills the probe.

    A kill between the token endpoint's answer and the write would lose a rotated refresh token."""
    if _left() < seconds:
        raise TimeoutError(f"no time left in this poll to {what}")


def _oauth_account(d):
    """The `oauthAccount` of `<configDir>/.claude.json`, falling back to `$HOME/.claude.json` only for the default
    `~/.claude`: the first one that has an email."""
    cands = [os.path.join(d, ".claude.json")]
    if os.path.realpath(d) == os.path.realpath(expand("~/.claude")):
        cands.append(expand("~/.claude.json"))
    for p in cands:
        try:
            with open(p) as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        acct = data.get("oauthAccount") if isinstance(data, dict) else None
        e = acct.get("emailAddress") if isinstance(acct, dict) else None
        if isinstance(e, str) and e:
            return acct
    return {}


def _email(d):
    return _oauth_account(d).get("emailAddress")


def _account_info(d):
    """Email, and the name and plan when `.claude.json` has them (the plan as Claude Code stores it: organisation type
    and rate-limit tier). A field it lacks is left out, never guessed."""
    acct = _oauth_account(d)
    out = {"email": acct.get("emailAddress")}
    for key, src in (("name", ("displayName",)), ("plan", ("organizationType",)),
                     ("planTier", ("organizationRateLimitTier", "userRateLimitTier"))):
        v = next((acct.get(k) for k in src if isinstance(acct.get(k), str) and acct.get(k)), None)
        if v:
            out[key] = v[:120]
    return out


def _private_open(path, mode):
    """Open a fresh file that is never, even for a moment, wider than `mode`."""
    try:
        os.unlink(path)  # a stale file keeps its old mode; never write tokens into it
    except FileNotFoundError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode & 0o600)
    try:
        os.fchmod(fd, mode)
    except BaseException:
        os.close(fd)
        raise
    return os.fdopen(fd, "w")


def _write_creds(path, creds):
    path = os.path.realpath(path)  # a symlinked file is updated where it lives; the link stays
    mode = stat.S_IMODE(os.stat(path).st_mode)
    with open(path) as src, _private_open(path + ".bak", mode) as bak:
        shutil.copyfileobj(src, bak)
    tmp = path + ".tmp"
    with _private_open(tmp, mode) as f:
        json.dump(creds, f, indent=2)
        f.flush()
        os.fsync(f.fileno())  # the rename must never publish an empty file after a crash
    os.replace(tmp, path)


class _DirLock:
    """flock on the config dir itself: it outlives the credentials file's inode, which os.replace swaps."""

    def __init__(self, d, timeout):
        self.d, self.timeout, self.fd = d, timeout, None

    def __enter__(self):
        if fcntl is None:
            return self
        self.fd = os.open(self.d, os.O_RDONLY)
        end = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except BlockingIOError:
                if time.monotonic() >= end:
                    os.close(self.fd)
                    raise TimeoutError("another refresher holds this account's credentials") from None
                time.sleep(0.05)

    def __exit__(self, *exc):
        if self.fd is not None:
            os.close(self.fd)  # releases the lock


def _read_creds(path):
    with open(path) as f:
        creds = json.load(f)
    if not isinstance(creds, dict) or not isinstance(creds.get("claudeAiOauth"), dict):
        raise ValueError("credentials file has no claudeAiOauth object")
    return creds


def _refresh(d, path, used_token, force, secrets):
    """Refresh under the account lock; return the claudeAiOauth now on disk.

    Re-reads the file once locked: if another refresher already replaced the token this
    probe was using (or it is no longer near expiry), its result is used and no second
    refresh is spent. The write merges into a fresh read, so fields another writer
    changed meanwhile survive."""
    _need(HTTP_TIMEOUT + 2, "refresh safely")
    with _DirLock(d, min(LOCK_TIMEOUT, _left() - HTTP_TIMEOUT - 2)):
        oauth = _read_creds(path)["claudeAiOauth"]
        _note_secrets(oauth, secrets)
        if oauth.get("accessToken") != used_token or (not force and not _due(oauth)):
            return oauth
        _need(HTTP_TIMEOUT + 2, "refresh safely")
        if not os.access(os.path.dirname(os.path.realpath(path)), os.W_OK | os.X_OK):
            # The token endpoint rotates the refresh token; one we could not save would lock the account out.
            raise PermissionError("cannot write beside the credentials file, so it will not be refreshed")
        body = json.dumps({"grant_type": "refresh_token", "refresh_token": oauth["refreshToken"],
                           "client_id": OAUTH_CLIENT_ID}).encode()
        req = urllib.request.Request(TOKEN_URL, data=body, headers={"Content-Type": "application/json", "User-Agent": USER_AGENT}, method="POST")
        with _open(req, timeout=HTTP_TIMEOUT) as r:
            payload = json.loads(r.read())
        _note_secrets(payload, secrets)
        expires_in = int(payload.get("expires_in") or 8 * 3600)
        update = {"accessToken": payload["access_token"],
                  "expiresAt": int(time.time() * 1000) + expires_in * 1000}
        if payload.get("refresh_token"):
            update["refreshToken"] = payload["refresh_token"]
        creds = _read_creds(path)  # whatever is on disk now, not what was read before the request
        creds["claudeAiOauth"].update(update)
        _write_creds(path, creds)
        return creds["claudeAiOauth"]


def _due(oauth):
    exp = oauth.get("expiresAt")
    return not isinstance(exp, (int, float)) or exp - time.time() * 1000 < 5 * 60 * 1000


def _call_usage(token):
    _need(HTTP_TIMEOUT, "call the usage API")
    req = urllib.request.Request(USAGE_URL, headers={"Authorization": f"Bearer {token}",
                                                     "anthropic-beta": "oauth-2025-04-20",
                                                     "User-Agent": USER_AGENT})
    with _open(req, timeout=HTTP_TIMEOUT) as r:
        return json.loads(r.read())


def _note_secrets(oauth, secrets):
    """Remember every token value seen, so no error message can carry one out."""
    if isinstance(oauth, dict):
        for k in ("accessToken", "refreshToken", "access_token", "refresh_token"):
            if isinstance(oauth.get(k), str) and oauth[k]:
                secrets.add(oauth[k])


def _scrub(msg, secrets):
    """Remove token values from `msg`, including escaped forms and any printable run of 8+ chars."""
    pieces = set()
    for t in secrets:
        pieces.update({t, repr(t)[1:-1], t.encode("unicode_escape").decode("ascii", "replace")})
        pieces.update(re.findall(r"[!-~]{8,}", t))
    for p in sorted(pieces, key=len, reverse=True):
        if len(p) >= 4:
            msg = msg.replace(p, "[redacted]")
    return re.sub(r"sk-ant-[A-Za-z0-9_-]+", "[redacted]", msg)


def _one(d, refresh, secrets):
    path = os.path.join(d, ".credentials.json")
    oauth = _read_creds(path)["claudeAiOauth"]
    _note_secrets(oauth, secrets)
    exp = oauth.get("expiresAt")
    refreshed = False
    if not refresh and isinstance(exp, (int, float)) and exp <= time.time() * 1000:
        raise RuntimeError("token expired and refresh is off")  # a certain 401; do not spend a request on it
    if refresh and _due(oauth):
        oauth = _refresh(d, path, oauth.get("accessToken"), False, secrets)
        refreshed = True
    try:
        return _call_usage(oauth["accessToken"])
    except urllib.error.HTTPError as e:
        if e.code == 401 and refresh and not refreshed:  # once per poll: a fresh token that 401s will not be fixed by another
            oauth = _refresh(d, path, oauth["accessToken"], True, secrets)
            return _call_usage(oauth["accessToken"])
        raise


def _retry_after(v):
    """Seconds from a Retry-After header (delta-seconds or an HTTP date), or None."""
    if not v:
        return None
    try:
        return max(0, int(float(v)))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(v)
        return max(0, int(when.timestamp() - time.time()))
    except (TypeError, ValueError, OverflowError):
        return None


def usage(req):
    global _deadline
    budget = req.get("budgetMs")
    if isinstance(budget, (int, float)) and not isinstance(budget, bool) and budget > 0:
        _deadline = time.monotonic() + budget / 1000
    out = []
    for a in req.get("accounts", []):
        raw = a.get("configDir", "")
        d = expand(raw) if isinstance(raw, str) else ""
        entry = {"configDir": raw, **_account_info(d)}
        if "key" in a:
            entry["key"] = a["key"]
        kind = a.get("kind", "oauth")
        secrets = set()
        try:
            if kind == "token":
                u = _token_usage(a, d, secrets)
            elif kind == "meter-log":
                u = _meter_log(a.get("log"))
                u["idle"] = _idle_since(d, _iso_ms((u.get("five_hour") or {}).get("resets_at")))
            else:
                u = _one(d, bool(a.get("refresh", True)), secrets)
            if "held" in u:
                entry.update(ok=True, held=u["held"])
            else:
                entry.update(ok=True, five_hour=u.get("five_hour"), seven_day=u.get("seven_day"))
                if kind == "meter-log":
                    entry.update(ts=u.get("ts"), idle=u["idle"])
        except Exception as e:  # report, never raise; never echo token values
            entry.update(ok=False, error=_scrub(f"{type(e).__name__}: {e}", secrets)[:200])
            if isinstance(e, urllib.error.HTTPError):
                entry["status"] = e.code
                ra = _retry_after(e.headers.get("Retry-After") if e.headers else None)
                if ra is not None:
                    entry["retryAfterS"] = ra
        out.append(entry)
    return {"ok": True, "accounts": out}


# --- usage from a long-lived `claude setup-token` token (usage provider "token") ---
# The usage endpoint refuses a setup token (403, missing scope user:profile), but every inference reply carries
# the subscription meters as rate-limit headers. One max_tokens:1 call to a small model is a reading. Header names
# as read by claude-usage-tracker's tracker/header_usage.py (2026-10-12):
#   anthropic-ratelimit-unified-5h-utilization  0-1 fraction    anthropic-ratelimit-unified-5h-reset  epoch seconds
#   anthropic-ratelimit-unified-7d-utilization  0-1 fraction    anthropic-ratelimit-unified-7d-reset  epoch seconds
MESSAGES_URL = os.environ.get("CLAYCLAUDE_MESSAGES_URL", "https://api.anthropic.com/v1/messages")
TOKEN_MODEL = "claude-haiku-5-5"
# A subscription token is accepted for Claude Code traffic, which opens with Claude Code's own system line.
CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
RL_PREFIX = "anthropic-ratelimit-unified-"
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
ENV_FILE_MAX_BYTES = 1 << 20
METER_TAIL_BYTES = 65536  # a meter line is ~1 KB; the logs run to tens of MB and are never read whole


def home_path(p):
    """`~/...` is this host's home; nothing else is expanded (`~user` stays literal, and the config refuses it)."""
    if not isinstance(p, str) or not p:
        raise ValueError("no path given")
    return os.path.expanduser("~") + p[1:] if p == "~" or p.startswith("~/") else p


def _env_token(name, env_file):
    """Variable `name` from this process's environment, else from its one `NAME=value` line in `env_file`.

    The file is parsed, never sourced or run; no other line is kept. Errors name the variable, never a value."""
    if not isinstance(name, str) or not ENV_NAME.match(name):
        raise ValueError("tokenEnv is not a variable name")
    v = os.environ.get(name, "").strip()
    if v:
        return v
    if env_file:
        try:
            f, _ = open_regular(home_path(env_file))
            with f:
                text = f.read(ENV_FILE_MAX_BYTES).decode("utf-8", "replace")
        except OSError as e:
            raise LookupError(f"{name} is not set and the env file is unreadable ({type(e).__name__})") from None
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("export "):
                s = s[len("export "):].lstrip()
            key, sep, val = s.partition("=")
            if sep and key.strip() == name:
                val = val.strip()
                if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                    val = val[1:-1]
                if val:
                    return val
    raise LookupError(f"{name} is not set in the environment" + (" or the env file" if env_file else ""))


def _pct(fraction):
    try:
        f = float(fraction) * 100
    except (TypeError, ValueError):
        return None
    return round(f, 4) if f == f and f not in (float("inf"), float("-inf")) else None


def _epoch_iso(epoch):
    try:
        return datetime.datetime.fromtimestamp(float(epoch), datetime.timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def _idle_since(d, since):
    """No claude run on this account since `since` (epoch ms): each run creates a file in <configDir>/sessions (the
    directory's mtime) and keeps writing it while it runs (the file's mtime, for a run that began before `since`)."""
    if not isinstance(since, (int, float)) or isinstance(since, bool):
        return False
    sessions = os.path.join(d, "sessions")
    try:
        touched = os.stat(sessions).st_mtime
    except OSError:
        return True
    try:
        with os.scandir(sessions) as it:
            for e in it:
                try:
                    if e.is_file(follow_symlinks=False):
                        touched = max(touched, e.stat(follow_symlinks=False).st_mtime)
                except OSError:
                    continue
    except OSError:
        pass
    return touched * 1000 <= since


def _iso_ms(v):
    """An ISO time with a zone as epoch ms, or None (no zone, or not a time)."""
    if not isinstance(v, str):
        return None
    try:
        t = datetime.datetime.fromisoformat(v[:-1] + "+00:00" if v.endswith("Z") else v)
    except ValueError:
        return None
    return t.timestamp() * 1000 if t.tzinfo is not None else None


def _token_usage(a, d, secrets):
    # The last reading's five-hour window has reset. A call now would start a new window itself, so hold it
    # until a claude run on this account has started one.
    if _idle_since(d, a.get("idleSinceMs")):
        return {"held": "lapsed"}
    token = _env_token(a.get("tokenEnv"), a.get("envFile"))
    secrets.add(token)
    _need(HTTP_TIMEOUT, "call the messages API")
    model = a.get("model") if isinstance(a.get("model"), str) and a.get("model") else TOKEN_MODEL
    body = json.dumps({"model": model, "max_tokens": 1, "system": CLAUDE_CODE_SYSTEM,
                       "messages": [{"role": "user", "content": "Hi"}]}).encode()
    req = urllib.request.Request(MESSAGES_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01",
        "content-type": "application/json", "User-Agent": USER_AGENT})
    with _open(req, timeout=HTTP_TIMEOUT) as r:
        r.read(65536)
        h = {k.lower(): v for k, v in r.headers.items()}
    if not any(RL_PREFIX + k in h for k in ("5h-utilization", "7d-utilization")):
        raise ValueError("no rate-limit headers in the reply")
    return {"five_hour": {"utilization": _pct(h.get(RL_PREFIX + "5h-utilization")), "resets_at": _epoch_iso(h.get(RL_PREFIX + "5h-reset"))},
            "seven_day": {"utilization": _pct(h.get(RL_PREFIX + "7d-utilization")), "resets_at": _epoch_iso(h.get(RL_PREFIX + "7d-reset"))}}


# --- the models an account's token can use (Task 46: the + New launcher's model list) ---
# GET /v1/models with the account's own token, read here on its host: the OAuth access token from
# <configDir>/.credentials.json (never refreshed here; an expired one is an error and nothing is sent), or a setup token
# (usage provider "token"). The same headers as the usage calls; no redirects. Only id, display_name and created_at are
# returned. Pages are followed by after_id from the last page, at most MODELS_MAX_PAGES.
MODELS_URL = os.environ.get("CLAYCLAUDE_MODELS_URL", "https://api.anthropic.com/v1/models")
MODELS_MAX_PAGES = 10
MODELS_MAX_BYTES = 1 << 20
MODEL_ID = re.compile(r"[A-Za-z0-9_.\[\]-]{1,64}\Z")


def _models_token(a, d, secrets):
    if a.get("kind") == "token":
        token = _env_token(a.get("tokenEnv"), a.get("envFile"))
        secrets.add(token)
        return token
    oauth = _read_creds(os.path.join(d, ".credentials.json"))["claudeAiOauth"]
    _note_secrets(oauth, secrets)
    exp = oauth.get("expiresAt")
    if isinstance(exp, (int, float)) and exp <= time.time() * 1000:
        raise RuntimeError("token expired (the model list never refreshes it; a claude run on this account will)")
    token = oauth.get("accessToken")
    if not isinstance(token, str) or not token:
        raise ValueError("no access token in the credentials file")
    return token


def _clip_model(m):
    if not isinstance(m, dict):
        return None
    mid = m.get("id")
    if not isinstance(mid, str) or not MODEL_ID.match(mid) or mid.startswith("-"):
        return None
    out = {"id": mid}
    for k, n in (("display_name", 64), ("created_at", 40)):
        if isinstance(m.get(k), str):
            out[k] = m[k][:n]
    return out


def _list_models(token):
    found, seen, after = [], set(), None
    for _ in range(MODELS_MAX_PAGES):
        q = {"limit": "1000"}
        if after:
            q["after_id"] = after
        req = urllib.request.Request(MODELS_URL + "?" + urllib.parse.urlencode(q), headers={
            "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01",
            "User-Agent": USER_AGENT})
        with _open(req, timeout=HTTP_TIMEOUT) as r:
            body = loads(r.read(MODELS_MAX_BYTES).decode("utf-8", "replace"))
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise ValueError("no model list in the reply")
        for m in data:
            c = _clip_model(m)
            if c and c["id"] not in seen:
                seen.add(c["id"])
                found.append(c)
        last = body.get("last_id")
        if body.get("has_more") is not True or not isinstance(last, str) or not last or last == after:
            break
        after = last
    return found


def models(req):
    out = []
    for a in req.get("accounts", []):
        raw = a.get("configDir", "")
        d = expand(raw) if isinstance(raw, str) else ""
        entry = {"key": a.get("key")}
        secrets = set()
        try:
            entry.update(ok=True, models=_list_models(_models_token(a, d, secrets)))
        except Exception as e:  # report, never raise; never echo token values
            entry.update(ok=False, error=_scrub(f"{type(e).__name__}: {e}", secrets)[:200])
            if isinstance(e, urllib.error.HTTPError):
                entry["status"] = e.code
        out.append(entry)
    return {"ok": True, "accounts": out}


# --- usage from a meter's JSON-lines log (usage provider "meter-log") ---
def _meter_log(path):
    """The newest complete reading in the last METER_TAIL_BYTES of the log; error and malformed lines are skipped."""
    for line in reversed(tail_lines(home_path(path), METER_TAIL_BYTES, strict=True)):
        try:
            d = loads(line)
        except ValueError:
            continue
        if isinstance(d, dict) and "error" not in d and isinstance(d.get("five_hour"), dict):
            return {"ts": d.get("ts"), "five_hour": d.get("five_hour"), "seven_day": d.get("seven_day")}
    raise LookupError("no reading in the meter log")


def slug(path):
    """Claude Code's project directory name for a working directory."""
    return re.sub(r"[^A-Za-z0-9]", "-", path)


def _is_repo(p):
    return os.path.exists(os.path.join(p, ".git"))


def _walk_repos(root, depth, out, limit):
    try:
        entries = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError:
        return
    for e in entries:
        if len(out) >= limit:
            return
        if e.name.startswith(".") or e.name == "node_modules":
            continue
        try:
            if not e.is_dir(follow_symlinks=False):
                continue
        except OSError:
            continue
        if _is_repo(e.path):
            out.append(e.path)
        elif depth > 1:
            _walk_repos(e.path, depth - 1, out, limit)


def repos(req):
    """Git repositories under the given roots, with the time a Claude session last used each."""
    limit = int(req.get("limit", 400))
    dirs = [expand(d) for d in req.get("configDirs", [])]
    roots_out, paths = [], []
    for raw in req.get("roots", []):
        absroot = os.path.abspath(expand(raw))
        exists = os.path.isdir(absroot)
        roots_out.append({"raw": raw, "abs": absroot, "exists": exists})
        if exists:
            _walk_repos(absroot, int(req.get("depth", 2)), paths, limit)
    found = []
    for p in sorted(set(paths)):
        used = 0
        for d in dirs:
            try:
                used = max(used, int(os.path.getmtime(os.path.join(d, "projects", slug(p))) * 1000))
            except OSError:
                pass
        found.append({"path": p, "name": os.path.basename(p), "lastUsedMs": used})
    found.sort(key=lambda r: (-r["lastUsedMs"], r["name"]))
    return {"ok": True, "roots": roots_out, "repos": found}


def _run_cli(binp, args):
    shell = shutil.which("bash")
    cmd = [shell, "-lc", 'exec "$0" "$@"', binp] + args if shell else [binp] + args
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=8, stdin=subprocess.DEVNULL)
    return p.returncode, p.stdout.decode("utf-8", "replace")


def cli(req):
    """Run `<bin> --version` and `<bin> --help` in a login shell, to learn what the installed CLI supports."""
    binp = req.get("bin", "claude")
    if not re.match(r"^[A-Za-z0-9_./~-]{1,200}$", binp):
        return {"ok": False, "error": "bad binary name"}
    binp = expand(binp)
    try:
        code, help_text = _run_cli(binp, ["--help"])
        if code != 0:
            return {"ok": False, "error": "exit %d: %s" % (code, help_text.strip().split("\n")[0][:200])}
        _, version = _run_cli(binp, ["--version"])
        return {"ok": True, "version": version.strip().split("\n")[0][:100], "help": help_text[:60000]}
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, str(e)[:200])}


def discover(req):
    """Claude config directories in $HOME, for `clayclaude setup`."""
    home = os.path.expanduser("~")
    out = []
    try:
        names = sorted(os.listdir(home))
    except OSError:
        names = []
    for name in names:
        if not name.startswith(".claude"):
            continue
        d = os.path.join(home, name)
        if not os.path.isdir(d):
            continue
        sessions = glob.glob(os.path.join(d, "sessions", "*.json"))
        has_creds = os.path.exists(os.path.join(d, ".credentials.json"))
        if not (sessions or has_creds or os.path.isdir(os.path.join(d, "projects")) or os.path.exists(os.path.join(d, "settings.json"))):
            continue
        out.append({"path": d, "name": name, "sessionFiles": len(sessions), "hasCredentials": has_creds,
                    "hasSettings": os.path.exists(os.path.join(d, "settings.json")), "email": _email(d)})
    return {"ok": True, "home": home, "dirs": out}


if __name__ == "__main__":
    main()
