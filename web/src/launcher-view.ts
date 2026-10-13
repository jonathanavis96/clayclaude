import type { LaunchOptions, RepoEntry } from '../../src/actions/types.js';
import type { AccountUsage } from '../../src/types.js';
import { esc } from './html.js';
import { BYPASS, MODE_LABELS, MORE, accountOptions, canStart, defaultMode, filterRepos, type LauncherState } from './launcher-model.js';
import type { LaunchAccountOptions } from '../../src/actions/types.js';
import { ringsSvg } from './meters.js';

export interface LView {
  opts: LaunchOptions | null; optsError?: string;
  repos: RepoEntry[] | null; reposError?: string;
  st: LauncherState; usage: AccountUsage[]; busy: boolean; error?: string;
}

export function accountsHtml(v: LView): string {
  if (v.optsError) return `<p class="warn">${esc(v.optsError)}</p>`;
  if (!v.opts) return '<p class="muted">Loading…</p>';
  return v.opts.accounts.map((a) => {
    const u = v.usage.find((x) => x.account === a.id);
    return `<button class="acct${v.st.account === a.id ? ' sel' : ''}" data-act="account" data-id="${esc(a.id)}" style="--c:${esc(a.colour)}"${a.canLaunch ? '' : ' disabled'}>
      <div class="acct-char" data-id="${esc(a.id)}"></div>
      <div class="acct-info"><b>${esc(a.label)}</b><span class="muted">${esc(a.host)}</span>${u ? ringsSvg(u) : ''}${a.canLaunch ? '' : `<small class="warn">${esc(a.reason ?? 'unavailable')}</small>`}</div></button>`;
  }).join('');
}

export function reposHtml(v: LView): string {
  if (!v.st.account) return '<p class="muted">Pick an account first.</p>';
  if (v.reposError) return `<p class="warn">${esc(v.reposError)}</p>`;
  if (!v.repos) return '<p class="muted">Looking for repositories…</p>';
  const list = filterRepos(v.repos, v.st.query);
  if (!list.length) return `<p class="muted">${v.repos.length ? 'No match.' : 'No repositories found under this host\'s repoRoots.'}</p>`;
  return list.map((r) => `<button class="repo${v.st.repo === r.path ? ' sel' : ''}" data-act="repo" data-path="${esc(r.path)}"><b>${esc(r.name)}</b><small>${esc(r.path)}</small></button>`).join('');
}

const select = (name: string, label: string, values: string[], cur: string) =>
  `<label>${label}<select data-opt="${name}"><option value="">default</option>${values.map((x) => `<option value="${esc(x)}"${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;

const opt = (value: string, label: string, cur: string) => `<option value="${esc(value)}"${value === cur ? ' selected' : ''}>${esc(label)}</option>`;

/**
 * Task 46: the newest model of each family by display name, then More ▾. Choosing More ▾ (or having a model from it)
 * lists the rest in a "More" group of the same select.
 */
function modelSelect(a: LaunchAccountOptions, st: LauncherState): string {
  const more = a.moreModels ?? [];
  const label = (id: string) => a.modelNames?.[id] ?? id;
  const open = st.moreModels || more.includes(st.model);
  return `<label>Model<select data-opt="model"><option value="">default</option>${a.models.map((id) => opt(id, label(id), st.model)).join('')}${
    !more.length ? '' : open ? `<optgroup label="More">${more.map((id) => opt(id, label(id), st.model)).join('')}</optgroup>` : `<option value="${MORE}">More ▾</option>`}</select></label>`;
}

/** Task 46: the permission mode. Bypass shows in the warning colour, with a one-line warning and a confirm tick. */
function modeHtml(a: LaunchAccountOptions, st: LauncherState): string {
  const modes = a.modes ?? [];
  if (!modes.length) return '';
  const bypass = st.permissionMode === BYPASS;
  // Task 47: the configured default (launch.defaultMode, or Manual where this claude lacks it) reads "(default)".
  const def = defaultMode(a);
  const dflt = (m: string) => (m === def ? ' (default)' : '');
  return `<label>Mode<select data-opt="permissionMode"${bypass ? ' class="warn"' : ''}><option value=""${st.permissionMode === '' ? ' selected' : ''}>Manual${dflt('')}</option>${
    // ⚠ as well as the colour: Chrome on Android draws a select's list natively, without the options' colours.
    modes.map((m) => `<option value="${esc(m)}"${m === BYPASS ? ' class="warn"' : ''}${m === st.permissionMode ? ' selected' : ''}>${m === BYPASS ? '⚠ ' : ''}${esc(MODE_LABELS[m] ?? m)}${dflt(m)}</option>`).join('')}</select></label>${
    // The owner's own bypass default keeps the warning but needs no confirm tick.
    bypass ? `<p class="warn bypass-warn">⚠ Every tool and command runs unasked.</p>${def === BYPASS ? '' : `
    <label class="check warn"><input type="checkbox" data-opt="bypassConfirmed"${st.bypassConfirmed ? ' checked' : ''}> Confirm bypass</label>`}` : ''}`;
}

export function optionsHtml(v: LView): string {
  const a = accountOptions(v.opts, v.st.account);
  if (!a) return '<p class="muted">Pick an account to see its options.</p>';
  // Task 42a: a one-line textarea, as in the rename sheet (Chrome on Android puts its autofill strip over an <input>).
  return `<label class="lname">Name<textarea id="l-name" rows="1" maxlength="40" placeholder="optional" aria-label="Session name" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">${esc(v.st.name)}</textarea></label>
    ${a.models.length ? modelSelect(a, v.st) : ''}
    ${a.efforts.length ? select('effort', 'Effort', a.efforts, v.st.effort) : ''}
    ${modeHtml(a, v.st)}
    ${a.remoteControl ? `<label class="check"><input type="checkbox" data-opt="remoteControl"${v.st.remoteControl ? ' checked' : ''}> Remote control</label>` : ''}
    <label class="check"><input type="checkbox" data-opt="openOnPc"${v.st.openOnPc ? ' checked' : ''}> Open on PC</label>
    ${v.error ? `<p class="warn">${esc(v.error)}</p>` : ''}
    <button class="primary start" data-act="start"${canStart(v.st, v.opts, v.busy) ? '' : ' disabled'}>${v.busy ? 'Starting…' : 'Start session'}</button>`;
}

export function shellHtml(v: LView): string {
  return `<div class="launcher-panel"><header><h2>New session</h2><button class="x" data-act="close" aria-label="Close">×</button></header>
    <div class="steps${v.st.account ? ' has-account' : ''}">
      <section><h3><span>1</span> Account</h3><div id="l-accts" class="accts">${accountsHtml(v)}</div></section>
      <section><h3><span>2</span> Repo</h3><input id="repo-q" type="search" placeholder="Search repositories" autocomplete="off" value="${esc(v.st.query)}"><div id="l-repos" class="repos">${reposHtml(v)}</div></section>
      <section><h3><span>3</span> Options</h3><div id="l-opts" class="opts">${optionsHtml(v)}</div></section>
    </div></div>`;
}
