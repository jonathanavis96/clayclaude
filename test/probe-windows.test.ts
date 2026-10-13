import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE, PYTHON, makeDir, writeJson } from './helpers/probe.js';
import { runProbe, ProbeError } from '../src/probe/run.js';
import { Collector } from '../src/collector.js';
import { CapsCache } from '../src/actions/launch.js';
import { parseConfig } from '../src/config.js';
import { unsupportedPlatformWarning } from '../src/actions/platform.js';

// On native Windows os.kill(pid, 0) sends CTRL_C_EVENT to the process group and any other signal calls
// TerminateProcess: a probe run there would interrupt the very sessions it watches. It must refuse to run.
const MESSAGE = "clayclaude's probe does not support native Windows hosts; run Claude Code and clayclaude under WSL2";

/** Python run first: pretend to be native Windows, and turn every process signal and file walk into a loud failure. */
const prelude = (fake: 'platform' | 'name') => `
import datetime, email.utils, glob, json, os, re, shutil, stat, subprocess, sys, time, urllib.error, urllib.request  # what the probe imports, loaded as on the real platform
def _forbidden(name):
    def f(*a, **k):
        sys.stderr.write("FORBIDDEN: " + name + " was called\\n")
        sys.stderr.flush()
        os._exit(97)
    return f
${fake === 'platform' ? 'sys.platform = "win32"' : 'os.name = "nt"'}
import ssl
ssl.enum_certificates = lambda store: []  # the Windows certificate store, which ssl reads on win32
os.kill = _forbidden("os.kill")
for n in ("scandir", "listdir", "walk"):
    setattr(os, n, _forbidden("os." + n))
glob.glob = _forbidden("glob.glob")
`;

/** A stand-in python3 for runProbe: runs the probe it is fed on stdin, after the prelude. */
function fakeWindowsPython(fake: 'platform' | 'name'): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-win-'));
  writeFileSync(join(d, 'prelude.py'), `${prelude(fake)}
src = sys.stdin.read()
exec(compile(src, "probe.py", "exec"), {"__name__": "__main__"})
`);
  const bin = join(d, 'python3');
  writeFileSync(bin, `#!/bin/sh\nexec ${PYTHON} -I "${join(d, 'prelude.py')}"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A registry file whose pid is this test's own process: a probe that checked it would signal us. */
function liveRegistry(): string {
  const d = makeDir();
  writeJson(join(d, 'sessions', 'a.json'), { pid: process.pid, sessionId: 'a', cwd: '/x', startedAt: Date.now() });
  return d;
}

const local = parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: me, label: Me, colour: "#fff", host: local, configDir: /c/me}
`).hosts[0];

describe('probe on native Windows', () => {
  for (const fake of ['platform', 'name'] as const) {
    it(`refuses every mode before signalling or walking anything (${fake === 'platform' ? 'sys.platform win32' : 'os.name nt'})`, async () => {
      const py = fakeWindowsPython(fake);
      const dir = liveRegistry();
      const reqs = [
        { mode: 'snapshot', dirs: [dir] },
        { mode: 'reap', configDir: dir, sessionId: 'a', files: ['a.json'] },
        { mode: 'repos', roots: [dir] },
        { mode: 'discover' },
        { mode: 'usage', accounts: [] },
        { mode: 'cli', bin: 'claude' },
      ];
      for (const req of reqs) {
        const err = await runProbe(local, req, { pythonBin: py }).then(() => null, (e: unknown) => e);
        expect(err, req.mode).toBeInstanceOf(ProbeError);
        expect((err as ProbeError).kind).toBe('unsupported');
        expect((err as ProbeError).message).toBe(`local: ${MESSAGE}`);
      }
    });
  }

  it('prints the error-shaped JSON and exits 0', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-win-'));
    const script = join(d, 'run.py');
    writeFileSync(script, `${prelude('platform')}
sys.argv = ["probe.py", ${JSON.stringify(JSON.stringify({ mode: 'snapshot', dirs: [liveRegistry()] }))}]
exec(compile(open(${JSON.stringify(PROBE)}).read(), "probe.py", "exec"), {"__name__": "__main__"})
`);
    const out = execFileSync(PYTHON, ['-I', script], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({ ok: false, error: MESSAGE, unsupportedPlatform: 'win32' });
  });

  it('pid_live itself never calls os.kill there', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-win-'));
    const script = join(d, 'live.py');
    writeFileSync(script, `
import os, sys
ns = {"__name__": "probe"}
exec(compile(open(${JSON.stringify(PROBE)}).read(), "probe.py", "exec"), ns)
${prelude('platform')}
try:
    r = ns["pid_live"](os.getpid(), None)
    print("returned " + repr(r))
except Exception as e:
    print("raised " + type(e).__name__)
`);
    expect(execFileSync(PYTHON, ['-I', script], { encoding: 'utf8' }).trim()).toBe('raised UnsupportedPlatform');
  });
});

describe('the daemon shows why a native Windows host is not watched', () => {
  const cfg = parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: me, label: Me, colour: "#fff", host: local, configDir: ${liveRegistry()}}
`);

  it('the collector logs the message for the host', async () => {
    const py = fakeWindowsPython('platform');
    const log = vi.fn();
    const c = new Collector(cfg, { log, probe: (h, r) => runProbe(h, r, { pythonBin: py }) });
    await c.pollOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe(`clayclaude: host local cannot be watched: local: ${MESSAGE}`);
  });

  it('the launcher card gives the message as the reason it cannot launch', async () => {
    const py = fakeWindowsPython('platform');
    const caps = new CapsCache((h, r) => runProbe(h, r, { pythonBin: py }));
    expect(await caps.get(cfg.hosts[0])).toEqual({ error: `local: ${MESSAGE}` });
  });
});

describe('daemon on native Windows', () => {
  it('warns at start-up that native Windows is not supported', () => {
    expect(unsupportedPlatformWarning('win32')).toMatch(/native Windows is not supported.*WSL2/);
    expect(unsupportedPlatformWarning('linux')).toBeNull();
    expect(unsupportedPlatformWarning('darwin')).toBeNull();
  });
});
