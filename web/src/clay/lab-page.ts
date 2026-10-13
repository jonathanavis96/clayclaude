/**
 * Clay lab (web/clay-lab.html): every state in a gallery, or the real board with fixture sessions.
 * Used by people to look at the characters and by the browser tests.
 *   ?view=gallery|board|editor  &mode=auto|bake|live|pc  &n=8 (board rows)  &layout=strips|grid|auto (board view, default strips)  &fail=worker,main (make those bake backends fail)
 * mode=pc and fail work on the dev server only (see lab-params.ts).
 * view=editor is the pose editor (spec §7.4.7): dev server only, lazy-loaded, never in the production bundle.
 */
import '../style.css';
import type { Session } from '../../../src/types.js';
import { renderBoard } from '../board.js';
import { MainBackend, WorkerBackend, type BakeBackend } from './baker.js';
import { createClayController, type ClayDeps } from './controller.js';
import { DEFAULT_CLAY_PREFS } from './prefs.js';
import { labParams } from './lab-params.js';
import { renderStats } from './stage.js';
import { CLAY_STATES } from './states.js';
import { RENDERER_VERSION } from './version.js';

const q = new URLSearchParams(location.search);
const root = document.getElementById('app')!;
// mode, fail and n, checked: outside the dev server the URL cannot pick pc or force a fallback to it (lab-params.ts)
const params = labParams(location.search, !!import.meta.env?.DEV);
const fail = params.fail;

// count requestAnimationFrame registrations: the shared loop must ask once per frame, however many characters
let rafCalls = 0;
const raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => { rafCalls++; return raf(cb); };

const failing = (name: string): BakeBackend => ({ name, bake: async () => { throw new Error(`${name} disabled by ?fail`); }, dispose() {} });
// count real bakes, so a test can prove a second visit plays from IndexedDB without baking
let bakes = 0;
const counted = (b: BakeBackend): BakeBackend => ({ name: b.name, bake: (k, o) => { bakes++; return b.bake(k, o); }, dispose: () => b.dispose() });
const deps: Partial<ClayDeps> = {
  backends: (stage) => [
    () => counted(fail.has('worker') ? failing('worker') : new WorkerBackend()),
    () => counted(fail.has('main') ? failing('main') : new MainBackend(stage)),
  ],
};
const clay = createClayController({ prefs: { ...DEFAULT_CLAY_PREFS, mode: params.mode }, cacheTtlMinutes: 60, deps });

const MIN = 60_000;
export function fixtureSessions(n: number, now: number): Session[] {
  const plan: Array<[Session['state'], number, boolean?]> = [
    ['needs-you', 3 * MIN], ['working', 0.2 * MIN], ['working', 20 * MIN, true], ['asleep', 12 * MIN],
    ['compacting', 1 * MIN], ['limit', 30 * MIN], ['asleep', 57 * MIN], ['stopped', 40 * MIN],
    ['working', 70 * MIN], ['needs-you', 62 * MIN],
  ];
  return Array.from({ length: n }, (_, i) => {
    const [state, age, over] = plan[i % plan.length];
    return {
      key: `lab:acct:s${i}`, host: 'lab', account: 'acct', sessionId: `s${i}`, pid: 1000 + i, name: `session ${i + 1}`, cwd: '/x',
      state, stateSince: now - age, live: state !== 'stopped', overContext: !!over, contextPct: over ? 91 : 40, hostOnline: true, lastSeen: now,
      question: state === 'needs-you' ? 'Should I run the migration on the staging database now?' : undefined,
      lastAssistantAt: now - age, cacheExpiresAt: now - age + 60 * MIN,
    } as Session;
  });
}

declare const __CLAY_EDITOR__: boolean;
if (__CLAY_EDITOR__ && q.get('view') === 'editor') {
  root.style.cssText = 'display:block;height:100%';
  void import('./editor.js').then((m) => Object.assign(window, { __editor: m.mountEditor(root) }));
} else if (q.get('view') === 'board') {
  const sessions = fixtureSessions(params.n, Date.now());
  const draw = () => {
    const now = Date.now();
    renderBoard(root, { sessions, usage: [], accounts: [{ id: 'acct', label: 'Lab', colour: '#e8b54a', host: 'lab' }], cacheTtlMinutes: 60, serverTime: now, clockSkew: 0 }, { meters: 'rings', layout: params.layout });
    clay.sync(root, sessions, now);
  };
  draw();
  setInterval(draw, 1000);
} else {
  // Spec §7.4.6: every state side by side at board size (the board's own --row, so 72 CSS px on the tablet),
  // one line per group, so a reviewer can compare W with W, N with N, S with S and X with X.
  root.style.cssText = 'display:block;height:100%;overflow:auto;padding:8px;box-sizing:border-box';
  for (const [label, prefix] of [['Working', 'W'], ['Needs you', 'N'], ['Asleep', 'S'], ['Other', 'X'], ['Launcher card', 'L']] as const) {
    const sec = document.createElement('section');
    sec.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px';
    sec.innerHTML = `<h2 style="width:100%;margin:0;font:600 12px ui-monospace,monospace;color:#8a93a3">${label}</h2>`;
    for (const id of CLAY_STATES.filter((s) => s.startsWith(prefix))) {
      const cell = document.createElement('figure');
      cell.style.cssText = 'margin:0;background:#161a21;border-radius:10px;padding:4px;color:#8a93a3;font:12px ui-monospace,monospace;text-align:center';
      cell.innerHTML = `<div class="char" data-state-id="${id}" style="height:calc(var(--row) * .8)"><div class="ph"><i></i><i></i></div></div><figcaption>${id}</figcaption>`;
      sec.appendChild(cell);
      clay.mountState(cell.querySelector<HTMLElement>('.char')!, id, { puffed: id === 'X2' });
    }
    root.appendChild(sec);
  }
}

// What Auto picked and why, readable in an on-device screenshot (Plan 3's settings panel shows the same).
const statusEl = document.createElement('div');
statusEl.id = 'clay-status';
statusEl.style.cssText = 'position:fixed;left:0;right:0;bottom:0;padding:4px 8px;background:#000c;color:#f2f4f7;font:12px ui-monospace,monospace;z-index:5';
document.body.appendChild(statusEl);
const errors: string[] = [];
const origError = console.error.bind(console);
console.error = (...a: unknown[]) => { errors.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}` : String(x))).join(' ')); origError(...a); };
addEventListener('error', (e) => errors.push(`error: ${e.message}`));
addEventListener('unhandledrejection', (e) => errors.push(`rejection: ${String((e as PromiseRejectionEvent).reason)}`));
const showStatus = () => {
  const st = clay.status();
  statusEl.textContent = `clay ${st.mode} · ${st.reason} · baked ${st.baked}/${st.total} · renderer ${RENDERER_VERSION}`
    + (errors.length ? ` · ${errors.length} errors, last: ${errors[errors.length - 1]}` : '');
  // the gallery scrolls in the space above the fixed status bar (which wraps on a narrow window), so the bar never
  // covers a heading or a cell
  if (q.get('view') !== 'editor' && q.get('view') !== 'board') root.style.height = `calc(100% - ${statusEl.offsetHeight}px)`;
};
showStatus();
setInterval(showStatus, 1000);

Object.assign(window, { __lab: { clay, renders: () => renderStats.renders, rafCalls: () => rafCalls, bakes: () => bakes, ready: true } });
