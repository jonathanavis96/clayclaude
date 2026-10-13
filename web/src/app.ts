import './overlay.css';
import type { Session } from '../../src/types.js';
import { openAnswerSheet, openMessageSheet } from './answer.js';
import { sessionKeyAt, type BoardState } from './board.js';
import type { ClayController, ClayPrefs } from './clay/index.js';
import { newlyNeedsYou, needsYouKeys, visibleSessions, withoutBackground } from './filter.js';
import { openFocus } from './focus.js';
import { toggleFullscreen } from './fullscreen.js';
import { noteUserExit } from './kiosk.js';
import { openAccount } from './account.js';
import type { CountFilter } from './filter.js';
import { initBoardTaps } from './taps.js';
import { openLauncher } from './launcher.js';
import { nightLevel } from './night.js';
import { getJson, postAction } from './net.js';
import { toast } from './overlay.js';
import { effective, type AppPrefs, type ConfigDefaults } from './prefs.js';
import { openSettings } from './settings.js';
import { initRenameGestures, openRenameSheet } from './rename.js';
import type { PublicConfig } from './settings-view.js';

export interface AppCtx {
  /** The element holding the board (`#app`). Only clicks inside it are treated as board taps. */
  root: HTMLElement;
  getState(): BoardState | null;
  getPrefs(): AppPrefs; setPrefs(p: AppPrefs): void;
  getClayPrefs(): ClayPrefs; setClayPrefs(c: ClayPrefs): void;
  clay: ClayController;
  /** The count filter (spec §5.1): local to this page, never saved. Setting it redraws the board. */
  getFilter(): CountFilter | null; setFilter(f: CountFilter | null): void;
}

export function initApp(ctx: AppCtx) {
  let defaults: ConfigDefaults = { quickReplies: ['yes', 'no', 'continue'], confirmBeforeSend: false, stoppedRetentionMs: 3 * 3_600_000 };
  void getJson<PublicConfig>('/api/config').then((c) => {
    if (c) defaults = { quickReplies: c.ui.quickReplies, confirmBeforeSend: c.ui.confirmBeforeSend, stoppedRetentionMs: c.stoppedRetentionMs };
  });
  const eff = () => effective(ctx.getPrefs(), defaults);
  const session = (key: string) => ctx.getState()?.sessions.find((s) => s.key === key);

  /** Open / Attach tmux. The result, success or failure, is shown as a toast. */
  const act = async (action: 'open' | 'attach', s: Session) => {
    const r = await postAction<{ message: string }>({ action, sessionId: s.key });
    toast(r.message, r.ok ? 'ok' : 'error');
  };

  /** Clear one stopped session, or all of them (spec §5.1). The row goes with the next state message. */
  const clear = async (body: { action: 'clear'; sessionId: string } | { action: 'clear-stopped' }, btn: HTMLButtonElement) => {
    btn.disabled = true;
    const r = await postAction<{ message: string }>(body);
    btn.disabled = false;
    toast(r.message, r.ok ? 'ok' : 'error');
  };

  const answer = (s: Session) => openAnswerSheet({
    session: s, getSession: () => session(s.key), confirmBeforeSend: () => eff().confirmBeforeSend, quickReplies: () => eff().quickReplies, act,
  });

  /** Task 43: a new message to an idle session. */
  const message = (s: Session) => openMessageSheet({ session: s, confirmBeforeSend: () => eff().confirmBeforeSend, quickReplies: () => eff().quickReplies });

  /** The rename sheet for a session (Task 41), from the board, its focus view or the account popup (Task 42a). */
  const rename = (key: string) => { const s = session(key); return s ? openRenameSheet(s) : undefined; };

  const focus = (key: string) => openFocus({
    sessionKey: key, getState: ctx.getState, clay: ctx.clay, ttlMinutes: () => ctx.getState()?.cacheTtlMinutes ?? 60,
    onAction: (a, s) => (a === 'answer' ? answer(s) : a === 'message' ? message(s) : void act(a, s)),
    // Closing an overlay steps the browser history back asynchronously; open the next one after that settles.
    onSwitch: (k) => setTimeout(() => focus(k), 120),
    rename,
  });

  // Counts filter the board, a meter opens its account, and the clock or blank space clears the filter on a tap and
  // toggles full screen on a double tap (spec §5.1, UI round 4).
  initBoardTaps(ctx.root, {
    getFilter: ctx.getFilter, setFilter: ctx.setFilter,
    // The popup closes before a session's focus view opens: wait for its history step to settle, as onSwitch does.
    openAccount: (id) => openAccount(id, { getState: ctx.getState, focus: (k) => setTimeout(() => focus(k), 120), rename }),
    // requestFullscreen runs synchronously inside the second tap (enterFullscreen awaits only after calling it).
    // Leaving by double tap is deliberate: the kiosk does not take the board back to full screen (Task 35).
    toggleFullscreen: () => {
      if (document.fullscreenElement) noteUserExit();
      void toggleFullscreen(document).then((r) => { if (!r.ok) toast(`Full screen is not available here: ${r.error}`, 'error'); });
    },
  });
  // Long-press or right-click on a session's name: rename it on the board (Task 41). Registered before the click handler
  // below: the click a long-press ends with is swallowed here, so the row does not also open its focus view.
  initRenameGestures(ctx.root, { open: rename });
  ctx.root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.cog')) { void openSettings({ getPrefs: ctx.getPrefs, setPrefs: ctx.setPrefs, getClayPrefs: ctx.getClayPrefs, setClayPrefs: ctx.setClayPrefs, clay: ctx.clay }); return; }
    // Task 38: the switch under the cog saves the other view in the layout preference the settings panel uses.
    const view = t.closest<HTMLElement>('[data-act="view"]');
    if (view) { const to = view.dataset.to; if (to === 'grid' || to === 'strips') ctx.setPrefs({ ...ctx.getPrefs(), layout: to }); return; }
    if (t.closest('[data-act="new"]')) { openLauncher({ getState: ctx.getState, clay: ctx.clay }); return; }
    const clr = t.closest<HTMLButtonElement>('[data-act="clear"]');
    if (clr?.dataset.key) { void clear({ action: 'clear', sessionId: clr.dataset.key }, clr); return; }
    const all = t.closest<HTMLButtonElement>('[data-act="clear-stopped"]');
    if (all) { void clear({ action: 'clear-stopped' }, all); return; }
    const ans = t.closest<HTMLElement>('[data-act="answer"]');
    if (ans?.dataset.key) { const s = session(ans.dataset.key); if (s) answer(s); return; }
    const msg = t.closest<HTMLElement>('[data-act="message"]');
    if (msg?.dataset.key) { const s = session(msg.dataset.key); if (s) message(s); return; }
    const open = t.closest<HTMLElement>('[data-act="open"]');
    if (open?.dataset.key) { const s = session(open.dataset.key); if (s) void act('open', s); return; }
    // A strip row or a grid card (spec §5.1): both open the focus view.
    const key = sessionKeyAt(t);
    if (key && session(key)) focus(key);
  });

  /* night dimming */
  const night = document.createElement('div');
  night.id = 'night';
  document.body.appendChild(night);
  const dim = () => { night.style.opacity = String(nightLevel(new Date(), ctx.getPrefs().night)); };
  setInterval(dim, 30_000); dim();

  /* sound: browsers only allow audio after a tap, so the first tap unlocks it */
  let audio: AudioContext | undefined;
  window.addEventListener('pointerdown', () => { try { audio ??= new AudioContext(); void audio.resume(); } catch { /* no audio */ } }, { once: true });
  const chime = () => {
    if (!audio || audio.state !== 'running') return;
    [660, 880].forEach((hz, i) => {
      const o = audio!.createOscillator(), g = audio!.createGain();
      o.frequency.value = hz; o.connect(g); g.connect(audio!.destination);
      const t = audio!.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.18);
    });
  };

  let seen: Set<string> | null = null;
  return {
    /** Call with every state message. */
    onState(s: BoardState) {
      const list = withoutBackground(s.sessions, ctx.getPrefs().showBackground);
      if (seen && ctx.getPrefs().sound && newlyNeedsYou(seen, list).length) chime();
      seen = needsYouKeys(list);
    },
    /** The sessions the board should draw (the stopped-retention and background preferences applied). */
    visible: (list: Session[]) => visibleSessions(list, eff().stoppedRetentionMs, Date.now(), ctx.getPrefs().showBackground),
    prefsChanged: dim,
  };
}
