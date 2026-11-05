import { describe, it, expect } from 'vitest';
import { InteropPicker, liveInteropSockets } from '../src/wsl-interop.js';

const entry = (name: string, mtimeMs: number, kind: 'socket' | 'link' = 'socket') => ({ name, mtimeMs, kind });

describe('liveInteropSockets', () => {
  const list = (entries: ReturnType<typeof entry>[], alive: number[] = [2, 100, 200, 300]) =>
    liveInteropSockets({ read: () => entries, pidAlive: (p) => alive.includes(p), dir: '/run/WSL' });

  it('lists sockets newest first', () => {
    expect(list([entry('2_interop', 1), entry('300_interop', 3), entry('200_interop', 2)]))
      .toEqual(['/run/WSL/300_interop', '/run/WSL/200_interop', '/run/WSL/2_interop']);
  });
  it('skips the 1_interop link, which only points at the boot socket', () => {
    expect(list([entry('1_interop', 9, 'link'), entry('2_interop', 1)])).toEqual(['/run/WSL/2_interop']);
  });
  it('skips the socket of a session whose process has gone', () => {
    expect(list([entry('999_interop', 9), entry('200_interop', 2)])).toEqual(['/run/WSL/200_interop']);
  });
  it('skips anything else in the directory', () => {
    expect(list([entry('notes', 9), entry('200_interop', 2)])).toEqual(['/run/WSL/200_interop']);
  });
  it('is empty when the directory cannot be read (not WSL)', () => {
    expect(liveInteropSockets({ read: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });
});

describe('InteropPicker', () => {
  const SOCKS = ['/run/WSL/300_interop', '/run/WSL/200_interop', '/run/WSL/2_interop'];

  it('moves off a socket that fails, to the newest other one', () => {
    const env: NodeJS.ProcessEnv = { WSL_INTEROP: '/run/WSL/200_interop' };
    expect(new InteropPicker(env, () => SOCKS).next()).toBe('/run/WSL/300_interop');
    expect(env.WSL_INTEROP).toBe('/run/WSL/300_interop');
  });
  it('sets the variable for a systemd service, which starts without it', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(new InteropPicker(env, () => SOCKS).next()).toBe('/run/WSL/300_interop');
    expect(env.WSL_INTEROP).toBe('/run/WSL/300_interop');
  });
  it('tries each socket once per stretch of failures, then reports none', () => {
    const env: NodeJS.ProcessEnv = {};
    const p = new InteropPicker(env, () => SOCKS);
    expect([p.next(), p.next(), p.next(), p.next()]).toEqual([...SOCKS, undefined]);
  });
  it('comes round again after a full pass, so a socket that recovers is found', () => {
    const env: NodeJS.ProcessEnv = {};
    const p = new InteropPicker(env, () => SOCKS);
    for (let i = 0; i < 4; i++) p.next();
    p.next();
    expect(env.WSL_INTEROP).toBe(SOCKS[0]);
  });
  it('tries a socket that appears during the stretch, such as a new terminal', () => {
    const env: NodeJS.ProcessEnv = {};
    const socks = ['/run/WSL/2_interop'];
    const p = new InteropPicker(env, () => socks);
    p.next(); p.next();
    socks.unshift('/run/WSL/400_interop');
    expect(p.next()).toBe('/run/WSL/400_interop');
  });
  it('starts over once the command works again', () => {
    const env: NodeJS.ProcessEnv = {};
    const p = new InteropPicker(env, () => SOCKS);
    p.next();
    p.reset();
    expect(p.next()).toBe('/run/WSL/200_interop'); // the working one in use is not "next"; the rest are
  });
  it('does nothing without sockets', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(new InteropPicker(env, () => []).next()).toBeUndefined();
    expect(env).toEqual({});
  });
});
