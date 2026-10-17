import type { AppPrefs } from './prefs.js';
import type { ClayPrefs } from './clay/index.js';
import { esc } from './html.js';
import { RETENTION_CHOICES } from './settings-model.js';
import { buildLabel, staleAgainst, type Stamp } from './build.js';

export interface PublicConfig {
  demo?: boolean;
  hosts: { id: string; ssh: string | null; tmuxSession: string; repoRoots: string[] }[];
  accounts: { id: string; label: string; colour: string; host: string; configDir: string; usage: string; open: string }[];
  ui: { quickReplies: string[]; confirmBeforeSend: boolean };
  stoppedRetentionMs: number;
  lan: { enabled: boolean };
}

/** The tablet's dim and sleep settings (GET /api/screen); kept by the daemon, which drives the tablet over adb. */
export interface ScreenSettings { enabled: boolean; dimAfterMinutes?: number; dimPercent?: number; sleepAfterMinutes?: number }

export interface SettingsView {
  prefs: AppPrefs; clay: ClayPrefs; config: PublicConfig | null;
  clayStatus: { mode: string; reason: string; baked: number; total: number };
  effective: { quickReplies: string[]; confirmBeforeSend: boolean; stoppedRetentionMs: number };
  /** This page's build and the one the daemon serves now (/api/version), so a stale page can be told apart (spec §5.1). */
  build?: { page: Stamp; served: Stamp | null };
  screen?: ScreenSettings | null;
}

const sel = (name: string, cur: string | number, choices: [string, string][]) =>
  `<select data-pref="${name}">${choices.map(([v, l]) => `<option value="${esc(v)}"${String(cur) === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
const chk = (name: string, on: boolean) => `<input type="checkbox" data-pref="${name}"${on ? ' checked' : ''}>`;
const num = (name: string, cur: number | undefined, min: number, max: number) =>
  `<input type="number" inputmode="numeric" data-screen="${name}" min="${min}" max="${max}" step="1" value="${cur ?? ''}">`;
const row = (label: string, control: string, hint = '') => `<label class="srow"><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>${control}</label>`;

export function settingsHtml(v: SettingsView): string {
  const { prefs: p, clay: c, config } = v;
  const mode = v.clayStatus;
  // "Default" names the config's retention (the effective one only when the config is unavailable), not a chosen one.
  const dflt = config?.stoppedRetentionMs ?? v.effective.stoppedRetentionMs;
  const retention: [string, string][] = [['', `Default (${Math.round(dflt / 3_600_000 * 10) / 10} h)`], ...RETENTION_CHOICES.map(([l, ms]): [string, string] => [String(ms), l])];
  return `<div class="settings-panel"><header><h2>Settings</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
    <div class="sgrid">
    <section><h3>Characters</h3>
      ${row('Animation mode', sel('clay.mode', c.mode, [['auto', 'Auto'], ['bake', 'Bake on device'], ['live', 'Live 3D'], ['pc', 'Baked by PC']]))}
      <p class="muted status">Now using ${esc(mode.mode)}: ${esc(mode.reason)} (${mode.baked} of ${mode.total} baked)</p>
      ${row('Shadows', chk('clay.shadows', c.shadows))}
      ${row('Frame-rate cap', sel('clay.fpsCap', c.fpsCap, [['15', '15 fps'], ['30', '30 fps'], ['60', '60 fps']]))}
      ${row('Body colour', `<input type="color" data-pref="clay.bodyColour" value="${esc(c.bodyColour)}">`)}</section>
    <section><h3>Board</h3>
      ${row('Layout', sel('layout', p.layout, [['auto', 'Auto'], ['strips', 'Strips'], ['grid', 'Grid']]), 'Auto shows the grid when the strips would not fit')}
      ${row('Usage shown as', sel('meters', p.meters, [['rings', 'Rings'], ['bars', 'Bars']]))}
      ${row('Hide stopped sessions after', sel('stoppedRetentionMs', p.stoppedRetentionMs ?? '', retention))}
      ${row('Show background sessions', chk('showBackground', p.showBackground), 'Headless claude -p and SDK helpers; off by default')}
      ${row('Sound when a session needs you', chk('sound', p.sound), 'Off by default')}</section>
    <section><h3>Night dimming</h3>
      ${row('Dim at night', chk('night.enabled', p.night.enabled))}
      ${row('From', `<input type="time" data-pref="night.from" value="${esc(p.night.from)}">`)}
      ${row('Until', `<input type="time" data-pref="night.to" value="${esc(p.night.to)}">`)}
      ${row('Darkness', `<input type="range" min="10" max="90" step="5" data-pref="night.level" value="${Math.round(p.night.level * 100)}">`)}</section>
    ${v.screen?.enabled ? `<section><h3>Tablet screen</h3>
      ${row('Dim after (minutes)', num('dimAfterMinutes', v.screen.dimAfterMinutes, 0, 1440), 'With no prompt typed to Claude; 0 never dims')}
      ${row('Dimmed brightness (%)', num('dimPercent', v.screen.dimPercent, 1, 100))}
      ${row('Sleep after (minutes)', num('sleepAfterMinutes', v.screen.sleepAfterMinutes, 0, 1440), 'Screen off; the next prompt turns it back on. 0 never sleeps')}</section>` : ''}
    <section><h3>Answering</h3>
      ${row('Confirm before sending', chk('confirmBeforeSend', v.effective.confirmBeforeSend))}
      ${row('Quick replies', `<input type="text" data-pref="quickReplies" value="${esc(v.effective.quickReplies.join(', '))}">`, 'Comma separated')}</section>
    <section class="wide"><h3>Accounts and hosts</h3><p class="muted">Read only. Edit the config file to change these.${config?.demo ? ' <b>Demo mode: nothing here is real.</b>' : ''}</p>
      ${config ? `<table><tr><th>Account</th><th>Host</th><th>Usage</th><th>Open</th></tr>${config.accounts.map((a) =>
        `<tr><td><i class="dot" style="background:${esc(a.colour)}"></i>${esc(a.label)}</td><td>${esc(a.host)}</td><td>${esc(a.usage)}</td><td>${esc(a.open)}</td></tr>`).join('')}</table>
        <p class="muted">Hosts: ${config.hosts.map((h) => esc(h.id + (h.ssh ? ` (ssh ${h.ssh})` : ' (this PC)'))).join(', ')}. LAN access: ${config.lan.enabled ? 'on' : 'off'}.</p>` : '<p class="muted">Config unavailable.</p>'}</section>
    ${v.build ? `<section class="wide build"><h3>Build</h3><p class="muted">This page: <code>${esc(buildLabel(v.build.page))}</code></p>${
      staleAgainst(v.build.page, v.build.served) ? `<p class="muted">Daemon serves: <code>${esc(buildLabel(v.build.served!))}</code>. Reload the page to update.</p>` : ''}</section>` : ''}
    </div></div>`;
}
