import { describe, it, expect, vi, afterEach } from 'vitest';
import { Baker, type BakeBackend } from '../web/src/clay/baker.js';
import type { SheetKey } from '../web/src/clay/sheet.js';

const key = (state: SheetKey['state']): SheetKey => ({ state, puffed: false, size: 96, shadows: true, colour: '#e07a4f', version: 'v' });
const bitmap = { close() {} } as unknown as ImageBitmap;

function backend(name: string, log: string[], fail = false): BakeBackend & { disposed: boolean } {
  const b = {
    name, disposed: false,
    async bake(k: SheetKey) { log.push(`${name}:${k.state}`); await new Promise((r) => setTimeout(r, 1)); if (fail) throw new Error(`${name} broke`); return { bitmap, png: Promise.resolve(new Blob()), renderMs: 1 }; },
    dispose() { b.disposed = true; },
  };
  return b;
}

afterEach(() => { vi.useRealTimers(); });

describe('Baker', () => {
  it('runs one bake at a time, on-screen (urgent) jobs before idle ones, and merges duplicate requests', async () => {
    const log: string[] = [];
    const b = new Baker([() => backend('w', log)], 0);
    const jobs = [b.bake(key('S2'), false), b.bake(key('S3'), false), b.bake(key('N4'), true), b.bake(key('S3'), false)];
    await Promise.all(jobs);
    expect(log).toEqual(['w:S2', 'w:N4', 'w:S3']); // S2 had already started; urgent N4 jumps the queue; S3 is baked once for both callers
    b.dispose();
  });

  it('a request for a key already baking shares that bake instead of queueing a second one', async () => {
    const log: string[] = [];
    let finish: () => void = () => {};
    const slow: BakeBackend = {
      name: 'w',
      bake: (k) => { log.push(`w:${k.state}`); return new Promise((res) => { finish = () => res({ bitmap, png: Promise.resolve(new Blob()), renderMs: 1 }); }); },
      dispose() {},
    };
    const b = new Baker([() => slow], 0);
    const idle = b.bake(key('S2'), false);
    await new Promise((r) => setTimeout(r, 1));           // S2 is now in flight
    const urgent = b.bake(key('S2'), true);              // the character comes on screen
    expect(b.pending).toBe(1);
    finish();
    const [a, c] = await Promise.all([idle, urgent]);
    expect(a).toBe(c);
    expect(log).toEqual(['w:S2']);
    expect(b.pending).toBe(0);
    b.dispose();
  });

  it('a failing backend hands over to the next one for good; the last one failing fails only that job', async () => {
    const log: string[] = [];
    const made: string[] = [];
    const b = new Baker([() => { made.push('w'); return backend('w', log, true); }, () => { made.push('m'); return backend('m', log); }], 0);
    await b.bake(key('W2'), true);
    await b.bake(key('W3'), true);
    expect(log).toEqual(['w:W2', 'm:W2', 'm:W3']);
    expect(made).toEqual(['w', 'm']);
    const only = new Baker([() => backend('m', [], true)], 0);
    await expect(only.bake(key('X4'), true)).rejects.toThrow('m broke');
    b.dispose(); only.dispose();
  });

  it('a backend that cannot be built is skipped', async () => {
    const log: string[] = [];
    const b = new Baker([() => { throw new Error('no OffscreenCanvas'); }, () => backend('m', log)], 0);
    await b.bake(key('L1'), true);
    expect(log).toEqual(['m:L1']);
    expect(b.backendName).toBe('m');
    b.dispose();
  });

  it('keeps a healthy backend alive (its bitmaps die with it) and reports a backend lost to a failure', async () => {
    vi.useFakeTimers();
    const log: string[] = [];
    const made: Array<ReturnType<typeof backend>> = [];
    let lost = 0;
    const b = new Baker([() => { const x = backend('w', log, made.length === 1); made.push(x); return x; }, () => backend('m', log)], 0, () => lost++);
    const p = b.bake(key('W2'), true);
    await vi.advanceTimersByTimeAsync(5);
    await p;
    await vi.advanceTimersByTimeAsync(10 * 60_000);    // ten idle minutes
    expect(made[0].disposed).toBe(false);
    expect(lost).toBe(0);
    b.dispose();
    const c = new Baker([() => backend('w', log, true), () => backend('m', log)], 0, () => lost++);
    const q = c.bake(key('W3'), true);
    await vi.advanceTimersByTimeAsync(5);
    await q;
    expect(lost).toBe(1);
    c.dispose();
  });

  it('dispose during an in-flight bake rejects the job and builds nothing new', async () => {
    const events: string[] = [];
    let lost = 0;
    // like WorkerBackend: dispose() rejects the bake in flight
    const hanging = (name: string): BakeBackend => {
      let reject: (e: Error) => void = () => {};
      return {
        name,
        bake() { events.push(`${name} baking`); return new Promise((_, rej) => { reject = rej; }); },
        dispose() { events.push(`${name} disposed`); reject(new Error('disposed')); },
      };
    };
    const b = new Baker([() => hanging('w'), () => { events.push('m created'); return hanging('m'); }], 0, () => lost++);
    const running = b.bake(key('W2'), false);
    const queued = b.bake(key('W3'), false);
    const outcomes = Promise.allSettled([running, queued]);
    await new Promise((r) => setTimeout(r, 1));
    b.dispose();
    const [r, q] = await outcomes;
    expect(r.status === 'rejected' && (r.reason as Error).message).toBe('disposed');
    expect(q.status === 'rejected' && (q.reason as Error).message).toBe('disposed');
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['w baking', 'w disposed']);
    expect(lost).toBe(0);
    expect(b.backendName).toBeNull();
    expect(b.pending).toBe(0);
    await expect(b.bake(key('W4'), true)).rejects.toThrow('disposed');
    expect(events).toEqual(['w baking', 'w disposed']);
  });

  it('a bake that finishes after dispose (main thread: cannot be cancelled) is closed and rejected, not delivered', async () => {
    let closed = 0;
    let finish: () => void = () => {};
    const main: BakeBackend = {
      name: 'm',
      bake: () => new Promise((res) => { finish = () => res({ bitmap: { close() { closed++; } } as unknown as ImageBitmap, png: Promise.resolve(new Blob()), renderMs: 1 }); }),
      dispose() { /* the stage belongs to the controller */ },
    };
    let lost = 0;
    const b = new Baker([() => main], 0, () => lost++);
    const job = b.bake(key('W2'), true);
    const outcome = job.then(() => 'resolved', (e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 1));
    b.dispose();
    finish();
    expect(await outcome).toBe('disposed');
    expect(closed).toBe(1);
    expect(lost).toBe(0);
  });
});
