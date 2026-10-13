import type { LaunchOptions, RepoEntry } from '../../src/actions/types.js';
import type { BoardState } from './board.js';
import type { ClayController } from './clay/index.js';
import { getJson, postAction } from './net.js';
import { BYPASS, MORE, initialLauncher, launchBody, normalise, type LauncherState } from './launcher-model.js';
import { accountsHtml, optionsHtml, reposHtml, shellHtml, type LView } from './launcher-view.js';
import { pushOverlay, toast } from './overlay.js';

export interface LauncherCtx { getState(): BoardState | null; clay: ClayController }

export function openLauncher(ctx: LauncherCtx): void {
  const el = document.createElement('section');
  el.className = 'launcher modal';
  const v: LView = { opts: null, repos: null, st: initialLauncher(), usage: ctx.getState()?.usage ?? [], busy: false };
  let stopChars: (() => void)[] = [];
  let closed = false;                // late fetch results must not draw (or mount clay) into a closed launcher
  const close = pushOverlay(el, () => { closed = true; stopChars.forEach((f) => f()); stopChars = []; });
  el.innerHTML = shellHtml(v);

  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const drawAccounts = () => {
    stopChars.forEach((f) => f());
    q('#l-accts').innerHTML = accountsHtml(v);
    q('.steps').classList.toggle('has-account', !!v.st.account);   // the compact keyboard layout hides accounts only once one is picked
    // each account card gets a waving clay character (state L1) in its own colour
    stopChars = (v.opts?.accounts ?? []).map((a) => ctx.clay.mountState(q(`.acct-char[data-id="${CSS.escape(a.id)}"]`), 'L1', { colour: a.colour }));
  };
  const drawRepos = () => { q('#l-repos').innerHTML = reposHtml(v); };
  const drawOpts = () => { q('#l-opts').innerHTML = optionsHtml(v); };

  void (async () => {
    const o = await getJson<LaunchOptions>('/api/launch/options');
    if (closed) return;
    if (o) v.opts = o; else v.optsError = 'Cannot reach the daemon.';
    drawAccounts(); drawOpts();
  })();

  const loadRepos = async (account: string) => {
    v.repos = null; v.reposError = undefined; drawRepos();
    const r = await getJson<{ ok: boolean; repos?: RepoEntry[]; message?: string }>(`/api/repos?account=${encodeURIComponent(account)}`);
    if (closed || v.st.account !== account) return; // closed, or the user picked another account meanwhile
    if (r?.ok && r.repos) v.repos = r.repos; else v.reposError = r?.message ?? 'Could not list repositories.';
    drawRepos();
  };

  el.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'close': close(); break;
      case 'account': {
        v.st = normalise({ ...v.st, account: b.dataset.id, repo: undefined, bypassConfirmed: false }, v.opts);
        v.error = undefined;                       // a failed start belongs to the previous choice
        drawAccounts(); drawOpts(); void loadRepos(b.dataset.id!);
        break;
      }
      case 'repo': v.st = { ...v.st, repo: b.dataset.path }; v.error = undefined; drawRepos(); drawOpts(); break;
      case 'start': {
        if (v.busy || !v.st.account || !v.st.repo) return;
        v.busy = true; v.error = undefined; drawOpts();
        const r = await postAction<{ message: string }>(launchBody(v.st));
        v.busy = false;
        // the toast still reports the outcome if the sheet was closed meanwhile; only the redraw is skipped
        if (r.ok) { toast(r.message); close(); } else { v.error = r.message; toast(r.message, 'error'); if (!closed) drawOpts(); }
        break;
      }
    }
  });
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.id === 'repo-q') { v.st = { ...v.st, query: t.value }; drawRepos(); }       // only the list is redrawn, so the keyboard stays up
    // The Name (Task 42a) is kept, never redrawn: the keyboard stays up, and the tap on Start that ends typing is not lost.
    if (t.id === 'l-name') v.st = { ...v.st, name: t.value };
  });
  // Task 46: bypass's two lines can leave the Options column scrolled down; with the keyboard up the compact layout puts
  // Start above the Name, so tapping the Name brings the column back to its top, Start and Name both in view.
  el.addEventListener('focusin', (e) => { if ((e.target as HTMLElement).id === 'l-name') q('#l-opts').scrollTop = 0; });
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target as HTMLElement).id === 'l-name') e.preventDefault(); });   // one line
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    const name = t.dataset.opt as keyof LauncherState | undefined;
    if (!name) return;
    const val = t instanceof HTMLInputElement && t.type === 'checkbox' ? t.checked : t.value;
    // Task 46: More ▾ is not a model. It opens the rest of the list in the same select, keeping the model chosen so far.
    if (name === 'model' && val === MORE) {
      v.st = { ...v.st, moreModels: true };
      drawOpts();
      const s = q<HTMLSelectElement>('select[data-opt="model"]');
      s.focus();
      try { (s as { showPicker?: () => void }).showPicker?.(); } catch { /* not allowed without a fresh tap here: the list is open in the select for the next one */ }
      return;
    }
    // Task 47: a mode picked by hand (Manual included) replaces the preselected default.
    v.st = normalise({ ...v.st, [name]: val, ...(name === 'permissionMode' ? { modeChosen: true } : {}) } as LauncherState, v.opts);
    drawOpts();
    // Its warning and confirm lines may push Start below a short Options column: bring the confirm and Start into view.
    if (name === 'permissionMode' && val === BYPASS) q('#l-opts .start').scrollIntoView?.({ block: 'nearest' });
  });
}
