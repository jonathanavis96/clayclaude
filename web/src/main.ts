import './style.css';
import { renderBoard, type BoardState } from './board.js';
import { showLink } from './banner.js';
import { initApp } from './app.js';
import { initKiosk } from './kiosk.js';
import { createClayController, readClayPrefs, writeClayPrefs } from './clay/index.js';
import { loadPrefs, savePrefs, type AppPrefs, type StorageLike } from './prefs.js';
import { withoutBackground, type CountFilter } from './filter.js';
import { BUILD, buildLabel, reloadFor, type Stamp } from './build.js';
import { getJson } from './net.js';
import { overlayCount, toast } from './overlay.js';

// The build stamp (spec §5.1): in the console at load, so a screenshot or a remote-debug session shows which code ran.
console.info(`clayclaude ${buildLabel(BUILD)}`);

const root = document.getElementById('app')!;
const banner = document.getElementById('banner')!;
let state: BoardState | null = null;

// localStorage can throw (storage blocked); wrap it once.
const store: StorageLike = {
  getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  setItem: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

// Clay characters. Their prefs live under `clay` in the shared clayclaude.prefs object (read and written only through
// Plan 2's readClayPrefs/writeClayPrefs, which validate); the cache TTL arrives with every state message.
const clay = createClayController({
  prefs: readClayPrefs(store),
  cacheTtlMinutes: () => state?.cacheTtlMinutes ?? 60,
});
let prefs: AppPrefs = loadPrefs(store);   // tolerates Plan 1's stored { meters } object
/** The count the person tapped (spec §5.1): only this page's state, never stored. */
let filter: CountFilter | null = null;

// Before the first state: the clock and the top bar, with the banner saying it is connecting (spec §12).
// onRelayout: a rotation or resize switched strips <-> grid; redraw now and mount the characters in the new slots.
const draw = () => renderBoard(root, state && { ...state, sessions: app.visible(state.sessions) }, { ...prefs, filter }, { onRelayout: () => { draw(); syncClay(); } });
/** Mounts, retargets and unmounts the characters in the rows just drawn. */
const syncClay = () => { if (state) clay.sync(root, app.visible(state.sessions), Date.now() + state.clockSkew); };

const app = initApp({
  // Focus view and account popups list sessions too: background ones stay out of those unless shown (Task 45).
  root, getState: () => state && (prefs.showBackground ? state : { ...state, sessions: withoutBackground(state.sessions, false) }),
  getPrefs: () => prefs, setPrefs: (p) => { prefs = p; savePrefs(store, p); draw(); syncClay(); app.prefsChanged(); },
  getClayPrefs: () => readClayPrefs(store),
  setClayPrefs: (c) => { writeClayPrefs(store, c); clay.setPrefs(c); },
  clay,
  getFilter: () => filter, setFilter: (f) => { filter = f; draw(); syncClay(); },
});

// An always-on tab keeps running the code it loaded, through daemon upgrades and rebuilds. Task 32: a focus-view bug
// stayed on the tablet long after its fix, because the open tabs ran an old bundle. So on every (re)connect, and every
// few minutes, ask the daemon which build it serves; when it is another one, reload, but not over an open sheet.
let served: Stamp | null = null;
let warned = false;
const sessionStore = { getItem: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  setItem: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } } };
function applyBuild() {
  const r = reloadFor(BUILD, served, sessionStore, overlayCount() === 0);
  if (r === 'reload') location.reload();
  else if (r === 'stale' && !warned) { warned = true; console.warn(`clayclaude: the daemon serves ${buildLabel(served!)}, this page is ${buildLabel(BUILD)}`); toast('This page is an old build: reload it to update', 'error'); }
}
async function checkBuild() { served = await getJson<Stamp>('/api/version'); applyBuild(); }
setInterval(() => void checkBuild(), 5 * 60_000);

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => void checkBuild();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'state') { const next: BoardState = { ...msg, clockSkew: msg.serverTime - Date.now() }; state = next; showLink(banner, 'live'); app.onState(next); draw(); syncClay(); }
  };
  ws.onclose = () => { showLink(banner, state ? 'down' : 'connecting'); setTimeout(connect, 3000); };
}

async function wake() { try { await (navigator as any).wakeLock?.request('screen'); } catch { /* not allowed */ } }
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
void wake();
showLink(banner, 'connecting');
draw();
setInterval(() => { draw(); syncClay(); if (served) applyBuild(); }, 1000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
connect();
initKiosk();
