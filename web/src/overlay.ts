let root: HTMLElement | null = null;
/** Below this visual-viewport height (CSS px) the overlays use their compact layout. */
export const SHORT_PX = 360;
/** The visual viewport this much shorter than the layout viewport (CSS px) means the on-screen keyboard is up. */
export const KEYBOARD_PX = 100;
/** In full screen Android shows its navigation bar (48 dp, 48 CSS px in Chrome) over the page with the keyboard, and
 *  the visual viewport does not leave room for it (final tablet pass). */
export const FULLSCREEN_KB_NAV_PX = 48;

/** One container for every overlay, outside `.strips`, so the board's re-rendering never touches them. */
export function overlayRoot(): HTMLElement {
  if (root) return root;
  root = document.createElement('div');
  root.id = 'overlays';
  document.body.appendChild(root);
  const vv = window.visualViewport;
  const fit = () => {
    // With the on-screen keyboard open the visual viewport is shorter; keep overlays inside it.
    const kb = !!vv && window.innerHeight - vv.height > KEYBOARD_PX && (vv.scale ?? 1) < 1.05;
    const h = (vv ? vv.height : window.innerHeight) - (kb && document.fullscreenElement ? FULLSCREEN_KB_NAV_PX : 0);
    root!.style.setProperty('--vvh', `${h}px`);
    root!.style.setProperty('--vvt', `${vv ? vv.offsetTop : 0}px`);
    // In a Chrome tab the keyboard leaves about 160 CSS px: overlays switch to a compact layout (overlay.css `.short`).
    // `kb` marks the keyboard itself (Chrome shrinks only the visual viewport for it), not just a small window or a
    // pinch zoom, so layouts that drop controls while typing never drop them in a window that is merely short.
    root!.classList.toggle('short', h < SHORT_PX);
    root!.classList.toggle('kb', kb);
  };
  vv?.addEventListener('resize', fit); vv?.addEventListener('scroll', fit); window.addEventListener('resize', fit);
  fit();
  return root;
}

export function toast(msg: string, kind: 'ok' | 'error' = 'ok'): void {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  overlayRoot().appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2500);
}

interface Entry { el: HTMLElement; onClose: () => void }
const stack: Entry[] = [];
let ignorePops = 0;

function closeTop(fromPopstate: boolean) {
  const top = stack.pop();
  if (!top) return;
  top.el.remove();
  top.onClose();
  if (!fromPopstate) { ignorePops++; history.back(); }
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('popstate', () => {
    if (ignorePops > 0) { ignorePops--; return; }
    closeTop(true);        // Android Back
  });
}

/** Show `el` as an overlay and make Back close it. Returns a function that closes it (and anything opened above it). */
export function pushOverlay(el: HTMLElement, onClose: () => void): () => void {
  listen();
  const entry: Entry = { el, onClose };
  stack.push(entry);
  overlayRoot().appendChild(el);
  history.pushState({ cc: stack.length }, '');
  el.addEventListener('pointerdown', (e) => { if (e.target === el && el.classList.contains('modal')) closeTo(entry); });
  return () => closeTo(entry);
}

function closeTo(entry: Entry) {
  while (stack.includes(entry)) closeTop(false);
}

export const overlayCount = () => stack.length;
