// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); document.body.innerHTML = ''; });

describe('overlay root and the on-screen keyboard', () => {
  it('marks the overlay root short while the visual viewport is short, and drops it again', async () => {
    const vv = Object.assign(new EventTarget(), { height: 601, offsetTop: 0 });
    vi.stubGlobal('visualViewport', vv);
    const { overlayRoot } = await import('../web/src/overlay.js');
    const root = overlayRoot();
    expect(root.classList.contains('short')).toBe(false);
    vv.height = 160; vv.dispatchEvent(new Event('resize'));       // keyboard up in a Chrome tab
    expect(root.classList.contains('short')).toBe(true);
    expect(root.style.getPropertyValue('--vvh')).toBe('160px');
    vv.height = 480; vv.dispatchEvent(new Event('resize'));       // keyboard down
    expect(root.classList.contains('short')).toBe(false);
  });

  it('marks the keyboard (kb) only when the visual viewport is well below the layout viewport, not in a merely short window', async () => {
    vi.stubGlobal('innerHeight', 601);
    const vv = Object.assign(new EventTarget(), { height: 601, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', vv);
    const { overlayRoot } = await import('../web/src/overlay.js');
    const root = overlayRoot();
    expect(root.classList.contains('kb')).toBe(false);
    vv.height = 160; vv.dispatchEvent(new Event('resize'));       // keyboard up
    expect([...root.classList]).toEqual(expect.arrayContaining(['short', 'kb']));
    vi.stubGlobal('innerHeight', 340); vv.height = 340; vv.dispatchEvent(new Event('resize'));   // a short window, no keyboard
    expect(root.classList.contains('short')).toBe(true);
    expect(root.classList.contains('kb')).toBe(false);
    vi.stubGlobal('innerHeight', 601); vv.height = 300; vv.scale = 2; vv.dispatchEvent(new Event('resize'));   // pinch zoom
    expect(root.classList.contains('kb')).toBe(false);
  });
  it('in full screen with the keyboard up, keeps overlays above the navigation bar Android shows over the page', async () => {
    // Final tablet pass: full screen, landscape, keyboard up: Chrome reported a 329 px visual viewport, but the system
    // navigation bar (48 dp) appears with the keyboard over the page's bottom and hid the reply box and Send.
    vi.stubGlobal('innerHeight', 602);
    const vv = Object.assign(new EventTarget(), { height: 602, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', vv);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => document.documentElement });
    try {
      const { overlayRoot } = await import('../web/src/overlay.js');
      const root = overlayRoot();
      expect(root.style.getPropertyValue('--vvh')).toBe('602px');        // no keyboard: the whole screen
      vv.height = 329; vv.dispatchEvent(new Event('resize'));
      expect(root.style.getPropertyValue('--vvh')).toBe('281px');
      expect([...root.classList]).toEqual(expect.arrayContaining(['short', 'kb']));
    } finally { delete (document as { fullscreenElement?: unknown }).fullscreenElement; }
  });
});
