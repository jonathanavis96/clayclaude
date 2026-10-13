// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createClayController, type ClayDeps } from '../web/src/clay/controller.js';
import { DEFAULT_CLAY_PREFS } from '../web/src/clay/prefs.js';
import { MemoryStore } from '../web/src/clay/store.js';

// The controller's live 3D Stage holds a WebGL context, a scarce resource on the tablet (Chrome keeps ~16). Opening
// and closing the focus view while the Stage is still being made must not leave that Stage behind undisposed.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  (HTMLCanvasElement.prototype as any).getContext = function () { return { clearRect() {}, drawImage() {} }; };
});

const session = { key: 'h:a:s1', host: 'h', account: 'a', sessionId: 's1', pid: 1, name: 's', cwd: '/', state: 'working', stateSince: Date.now(),
  live: true, overContext: false, hostOnline: true, lastSeen: Date.now() } as any;
const slot = () => { const el = document.createElement('div'); Object.defineProperty(el, 'clientWidth', { value: 200 }); Object.defineProperty(el, 'clientHeight', { value: 200 }); document.body.appendChild(el); return el; };

describe('clay controller live Stage', () => {
  it('disposes a Stage that finishes loading after the focus view that asked for it has closed', async () => {
    const stages: Array<{ disposed: boolean }> = [];
    const pending: Array<() => void> = [];
    const deps: Partial<ClayDeps> = {
      openStore: async () => new MemoryStore(),
      backends: () => [],
      idle: () => sleep(1),
      fetch: (async () => new Response(JSON.stringify({ pc: false, reason: 'test' }))) as typeof fetch,
      makeStage: () => new Promise((resolve) => pending.push(() => {
        const s = { disposed: false, canvas: document.createElement('canvas'), setSize() {}, render() {}, lost: () => false, dispose() { this.disposed = true; } };
        stages.push(s);
        resolve(s as any);
      })),
    };
    const ctl = createClayController({ prefs: { ...DEFAULT_CLAY_PREFS, mode: 'bake' }, cacheTtlMinutes: 60, deps });
    await sleep(20);                               // mode chosen in settings: bake, no trial and no Stage
    expect(ctl.status().mode).toBe('bake');
    const stop1 = ctl.mountLarge(slot(), session);  // focus view opens: the Stage starts loading
    stop1();                                        // ...and closes before it is ready
    pending.shift()!();                             // the first Stage arrives late
    await sleep(5);
    const stop2 = ctl.mountLarge(slot(), session);  // the focus view opens again
    pending.shift()?.();
    await sleep(5);
    stop2();
    await sleep(5);
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.map((s) => s.disposed)).toEqual(stages.map(() => true));
    ctl.dispose();
  });
});
