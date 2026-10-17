import type { ClayController, ClayPrefs } from './clay/index.js';
import { getJson, postJson } from './net.js';
import { pushOverlay } from './overlay.js';
import { effective, type AppPrefs } from './prefs.js';
import { applyChange, type PrefName } from './settings-model.js';
import { settingsHtml, type PublicConfig, type ScreenSettings } from './settings-view.js';
import { BUILD, type Stamp } from './build.js';

export interface SettingsCtx {
  getPrefs(): AppPrefs; setPrefs(p: AppPrefs): void;
  getClayPrefs(): ClayPrefs; setClayPrefs(c: ClayPrefs): void;
  clay: ClayController;
}

/** A sheet is open or on its way: the fetch below takes a moment, and a second tap on the cog must not open another. */
let showing = false;

export async function openSettings(ctx: SettingsCtx): Promise<void> {
  if (showing) return;
  showing = true;
  const [config, served, screen0] = await Promise.all([getJson<PublicConfig>('/api/config'), getJson<Stamp>('/api/version'), getJson<ScreenSettings>('/api/screen')]);   // never throw: null when the daemon is unreachable
  let screen = screen0;
  const el = document.createElement('section');
  el.className = 'settings modal';
  const close = pushOverlay(el, () => { showing = false; });
  const draw = () => {
    const p = ctx.getPrefs();
    const d = { quickReplies: config?.ui.quickReplies ?? ['yes', 'no', 'continue'], confirmBeforeSend: config?.ui.confirmBeforeSend ?? false, stoppedRetentionMs: config?.stoppedRetentionMs ?? 3 * 3_600_000 };
    const scroll = el.querySelector('.sgrid')?.scrollTop ?? 0;
    el.innerHTML = settingsHtml({ prefs: p, clay: ctx.getClayPrefs(), config, clayStatus: ctx.clay.status(), effective: effective(p, d), build: { page: BUILD, served }, screen });
    const g = el.querySelector('.sgrid'); if (g) g.scrollTop = scroll;
  };
  draw();
  el.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-act="close"]')) close(); });
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const key = t.dataset.screen;
    if (key) {
      // The daemon checks the value; a bad one is refused and the field shows the setting still in force.
      void postJson<ScreenSettings & { ok?: boolean }>('/api/screen', { [key]: Number(t.value) }).then((r) => { if (r?.ok) screen = { ...r, enabled: true }; draw(); });
      return;
    }
    const name = t.dataset.pref as PrefName | undefined;
    if (!name) return;
    const r = applyChange(ctx.getPrefs(), ctx.getClayPrefs(), name, t.type === 'checkbox' ? t.checked : t.value);
    ctx.setPrefs(r.prefs); ctx.setClayPrefs(r.clay);
    draw();
  });
}
