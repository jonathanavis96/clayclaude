import type { LaunchAccountOptions, LaunchOptions, RepoEntry } from '../../src/actions/types.js';
import { fuzzyFilter } from './fuzzy.js';

/**
 * `name` (Task 42a): optional; passed to claude as `--name` and the session's board name. Task 46: `moreModels` opens the
 * model select's More ▾ list; `permissionMode` ('' is Manual); `bypassConfirmed` is the bypass confirm tick. Task 47:
 * `modeChosen` is set once the Mode select is changed by hand; until then the account's default mode is preselected.
 */
export interface LauncherState {
  account?: string; query: string; repo?: string; model: string; effort: string; remoteControl: boolean; openOnPc: boolean; name: string;
  moreModels: boolean; permissionMode: string; bypassConfirmed: boolean; modeChosen: boolean;
}

export const initialLauncher = (): LauncherState => ({ query: '', model: '', effort: '', remoteControl: false, openOnPc: false, name: '',
  moreModels: false, permissionMode: '', bypassConfirmed: false, modeChosen: false });

export const BYPASS = 'bypassPermissions';
/** The select's value that opens More ▾; never a model id (ids are checked against the account's list). */
export const MORE = '__more';

/** Task 46: how each permission mode reads in the Mode select. */
export const MODE_LABELS: Record<string, string> = {
  acceptEdits: 'Accept edits', auto: 'Auto', plan: 'Plan', dontAsk: 'Don\'t ask', bypassPermissions: 'Bypass permissions',
};

export const accountOptions = (o: LaunchOptions | null, id?: string): LaunchAccountOptions | undefined => o?.accounts.find((a) => a.id === id);

/** Task 47: the account's preselected mode (launch.defaultMode where its claude lists it), '' (Manual) otherwise. */
export const defaultMode = (a: LaunchAccountOptions): string => (a.modes ?? []).includes(a.defaultMode ?? '') ? a.defaultMode! : '';

/** Drop choices the chosen account's CLI does not offer. An option the CLI lacks is hidden, so its value must reset too. */
export function normalise(st: LauncherState, o: LaunchOptions | null): LauncherState {
  const a = accountOptions(o, st.account);
  if (!a) return st;
  // Task 47: the default until a mode is picked by hand; a picked mode this account lacks falls back to its default.
  const permissionMode = st.modeChosen && (st.permissionMode === '' || (a.modes ?? []).includes(st.permissionMode)) ? st.permissionMode : defaultMode(a);
  return {
    ...st,
    model: a.models.includes(st.model) || (a.moreModels ?? []).includes(st.model) ? st.model : '',
    effort: a.efforts.includes(st.effort) ? st.effort : '',
    remoteControl: a.remoteControl && st.remoteControl,
    permissionMode,
    // The confirm belongs to one bypass choice: any change of mode (or account) asks for it again.
    bypassConfirmed: permissionMode === BYPASS && st.permissionMode === BYPASS && st.bypassConfirmed,
  };
}

export function canStart(st: LauncherState, o: LaunchOptions | null, busy: boolean): boolean {
  const a = accountOptions(o, st.account);
  // Task 47: bypass that is the owner's configured default needs no tick; chosen by hand it does (the daemon checks the same).
  return !busy && !!a?.canLaunch && !!st.repo && (st.permissionMode !== BYPASS || st.bypassConfirmed || defaultMode(a) === BYPASS);
}

export const filterRepos = (repos: RepoEntry[], q: string) => fuzzyFilter(repos, q, (r) => r.name);

/** The request body for the start button. Empty model/effort mean "the CLI's default" and are left out, as is a blank name. */
export function launchBody(st: LauncherState) {
  const name = st.name.trim();
  return {
    action: 'launch' as const, account: st.account!, repo: st.repo!,
    options: { ...(st.model ? { model: st.model } : {}), ...(st.effort ? { effort: st.effort } : {}), ...(name ? { name } : {}),
      ...(st.permissionMode ? { permissionMode: st.permissionMode } : {}), ...(st.permissionMode === BYPASS && st.bypassConfirmed ? { confirmBypass: true } : {}),
      remoteControl: st.remoteControl, openOnPc: st.openOnPc },
  };
}
