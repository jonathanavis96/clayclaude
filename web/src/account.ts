import { accountHtml } from './account-view.js';
import type { BoardState } from './board.js';
import { pushOverlay } from './overlay.js';
import { initRenameGestures } from './rename.js';

export interface AccountDeps {
  getState(): BoardState | null; focus(sessionKey: string): void;
  /** Task 42a: a long-press or right-click on a session's name in the list opens the rename sheet (as on the board). */
  rename?(sessionKey: string): (() => void) | void;
}

/** A popup is open: a second tap that lands before the modal covers the meters must not stack another. */
let showing = false;

/**
 * Tapping an account meter in the top bar calls this with the account's id (spec §5.1, UI round 4): a popup with the
 * account's name and email, both windows with their resets, the sessions on it, the plan and when it last updated.
 * It redraws every second (ages and countdowns move; usage arrives every minute). Tap outside, the × or Back closes
 * it; tapping a session closes it and opens that session's focus view.
 */
export function openAccount(id: string, deps: AccountDeps): void {
  const find = () => deps.getState()?.usage.find((u) => u.account === id);
  if (showing || !find()) return;
  showing = true;
  const el = document.createElement('section');
  el.className = 'account modal';
  let timer: number | undefined;
  let stopRename: (() => void) | undefined;
  const close = pushOverlay(el, () => { showing = false; clearInterval(timer); stopRename?.(); });
  const draw = () => {
    const st = deps.getState(), u = find();
    if (!st || !u) { close(); return; }
    el.innerHTML = accountHtml(u, st.sessions, Date.now() + st.clockSkew);
  };
  // Before the click handler below: the click a long-press ends with is swallowed there, so no focus view opens.
  if (deps.rename) stopRename = initRenameGestures(el, { names: '.acct-sessions .mini span', open: deps.rename });
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (b?.dataset.act === 'close') close();
    else if (b?.dataset.act === 'focus' && b.dataset.key) {
      const key = b.dataset.key;
      close();
      deps.focus(key);
    }
  });
  draw();
  timer = window.setInterval(draw, 1000);
}
