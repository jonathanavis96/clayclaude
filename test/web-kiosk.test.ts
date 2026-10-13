// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { KioskTrigger, initKiosk, isKioskHash, kioskKey, noteUserExit, postTap, showStartOverlay } from '../web/src/kiosk.js';

describe('kiosk overlay rules', () => {
  it('shows only in a kiosk launch, in a browser tab, while not full screen', () => {
    expect(showStartOverlay({ kiosk: true, fullscreen: false, displayMode: 'browser' })).toBe(true);
    expect(showStartOverlay({ kiosk: false, fullscreen: false, displayMode: 'browser' })).toBe(false);
    expect(showStartOverlay({ kiosk: true, fullscreen: true, displayMode: 'browser' })).toBe(false);
    expect(showStartOverlay({ kiosk: true, fullscreen: false, displayMode: 'fullscreen' })).toBe(false);
    expect(showStartOverlay({ kiosk: true, fullscreen: false, displayMode: 'standalone' })).toBe(false);
    expect(isKioskHash('#kiosk')).toBe(true);
    expect(isKioskHash('')).toBe(false);
    expect(isKioskHash('#kiosk2')).toBe(false);
    expect(isKioskHash(`#kiosk=${'a1'.repeat(16)}`)).toBe(true);
    expect(isKioskHash('#kiosk=<img>')).toBe(false);
  });
});

/** Only the page the kiosk launch opened may ask for taps: it carries the launch key the daemon put in its URL. */
describe('kiosk tap request', () => {
  const KEY = 'a1'.repeat(16);
  it('reads the launch key from the fragment, and only a well-formed one', () => {
    expect(kioskKey(`#kiosk=${KEY}`)).toBe(KEY);
    expect(kioskKey('#kiosk')).toBe('');
    expect(kioskKey('#kiosk=x"y')).toBe('');
  });
  it('sends the key of the URL it has now (a relaunch may change only the fragment), and a refusal stops the asking', async () => {
    const sent: Record<string, string>[] = [];
    let status = 200;
    const fetchFn = (async (_u: string, init: RequestInit) => { sent.push(init.headers as Record<string, string>); return new Response(JSON.stringify({ tapped: true }), { status }); }) as typeof fetch;
    location.hash = `#kiosk=${KEY}`;
    expect(await postTap(fetchFn)).toEqual({ tapped: true });
    expect(sent[0]).toMatchObject({ 'x-clayclaude': '1', 'x-clayclaude-kiosk': KEY });
    location.hash = '#kiosk';
    status = 403;
    expect(await postTap(fetchFn)).toEqual({ disabled: true });
    expect(sent[1]['x-clayclaude-kiosk']).toBe('');
  });
});

describe('initKiosk', () => {
  let fsCalls: unknown[]; let fsEl: Element | null;
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"><button class="row">row</button></div>';
    fsCalls = []; fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    document.documentElement.requestFullscreen = (async (o?: unknown) => { fsCalls.push(o); fsEl = document.documentElement; }) as never;
  });

  it('does nothing outside a kiosk launch', () => {
    location.hash = '';
    initKiosk({ mode: () => 'browser', requestTap: async () => ({}) })();
    expect(document.getElementById('kiosk-start')).toBeNull();
  });

  it('covers the page, and a tap goes full screen (no orientation lock: the board follows a rotation) and hides it; leaving full screen brings it back', async () => {
    location.hash = '#kiosk';
    const results: { ok: boolean }[] = [];
    let rowClicks = 0;
    document.querySelector('.row')!.addEventListener('click', () => { rowClicks++; });
    const stop = initKiosk({ mode: () => 'browser', onResult: (r) => results.push(r), requestTap: async () => ({}) });
    const el = document.getElementById('kiosk-start') as HTMLElement;
    expect(el.style.position).toBe('fixed');
    expect(el.style.display).toBe('grid');
    el.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(fsCalls).toEqual([{ navigationUI: 'hide' }]);
    expect(results).toEqual([{ ok: true }]);
    expect(rowClicks).toBe(0);                       // the tap never reaches the board underneath
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(el.style.display).toBe('none');
    fsEl = null;                                     // Home, Back or a swipe left full screen
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(el.style.display).toBe('grid');
    stop();
    expect(document.getElementById('kiosk-start')).toBeNull();
  });

  it('stays hidden in an installed app, which is full screen already', () => {
    location.hash = '#kiosk';
    initKiosk({ mode: () => 'fullscreen', requestTap: async () => ({}) });
    expect((document.getElementById('kiosk-start') as HTMLElement).style.display).toBe('none');
  });
});

/** Task 35: no human tap. The trigger decides when the board asks the daemon for its "tap to start" tap. */
describe('KioskTrigger', () => {
  const env = (fullscreen: boolean, visible = true) => ({ kiosk: true, fullscreen, displayMode: 'browser', visible });

  it('wants a tap on load while not full screen and visible, in a browser tab', () => {
    const k = new KioskTrigger('landscape');
    expect(k.wants(env(false))).toBe(true);
    expect(k.wants(env(true))).toBe(false);
    expect(k.wants(env(false, false))).toBe(false);                     // a background tab is never tapped for
    expect(k.wants({ ...env(false), displayMode: 'fullscreen' })).toBe(false);
    expect(k.wants({ ...env(false), kiosk: false })).toBe(false);
  });

  it('respects a double-tap exit until the next rotation; a resize alone does not end it', () => {
    const k = new KioskTrigger('landscape');
    k.userExited();
    expect(k.wants(env(false))).toBe(false);
    expect(k.cover(env(false))).toBe(false);                             // the person sees the board, not "Tap to start"
    k.viewport('landscape');                                             // Chrome's bars came back: same orientation
    expect(k.wants(env(false))).toBe(false);
    k.viewport('portrait');                                              // rotated
    expect(k.wants(env(false))).toBe(true);
    expect(k.cover(env(false))).toBe(true);
  });

  it('holds off while Back is closing a sheet: full screen lost with an overlay open, until it closes, a rotation or full screen', () => {
    const k = new KioskTrigger('landscape');
    k.left(0);                                                           // nothing open: a plain Back or swipe
    expect(k.cover(env(false))).toBe(true);
    k.left(1);                                                           // a sheet open: Chrome took the first Back
    k.overlays(1);
    expect(k.cover(env(false))).toBe(false);                             // the next Back reaches the sheet
    expect(k.wants(env(false))).toBe(false);
    k.overlays(0);                                                       // the sheet closed
    expect(k.wants(env(false))).toBe(true);
    k.left(2); k.viewport('portrait');                                   // a rotation ends the hold
    expect(k.wants(env(false))).toBe(true);
    k.left(1); k.entered();
    expect(k.wants(env(false))).toBe(true);
  });

  it('forgets a double-tap exit once full screen is entered again (by a double tap)', () => {
    const k = new KioskTrigger('landscape');
    k.userExited(); k.entered();
    expect(k.wants(env(false))).toBe(true);                              // a later exit by Back or a swipe is not deliberate
  });
});

describe('initKiosk asks for its tap', () => {
  let fsEl: Element | null; let asks: number; let orient: string; let reply: { retryMs?: number; disabled?: boolean }; let open: number;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fsChange = (on: boolean) => { fsEl = on ? document.documentElement : null; document.dispatchEvent(new Event('fullscreenchange')); };
  const start = () => initKiosk({ mode: () => 'browser', orientation: () => orient, overlays: () => open, settleMs: 5, gapMs: 40,
    requestTap: async () => { asks++; return reply; } });
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    fsEl = null; asks = 0; orient = 'landscape'; reply = {}; open = 0;
    location.hash = '#kiosk';
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fsEl });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  it('on load, once, after the cover is up', async () => {
    const stop = start();
    expect(asks).toBe(0);
    await wait(20);
    expect(asks).toBe(1);
    expect((document.getElementById('kiosk-start') as HTMLElement).style.display).toBe('grid');
    stop();
  });

  it('again when full screen is lost any way but a double tap (Back, a swipe, a tab switch), and after a rotation', async () => {
    const stop = start();
    await wait(20); fsChange(true); await wait(60);
    fsChange(false); await wait(20);
    expect(asks).toBe(2);
    fsChange(true); await wait(60);
    window.dispatchEvent(new Event('resize')); await wait(20);           // full screen: nothing to ask for
    expect(asks).toBe(2);
    stop();
  });

  it('never after a double-tap exit, until a rotation', async () => {
    const stop = start();
    await wait(20); fsChange(true); await wait(60);
    noteUserExit(); fsChange(false); await wait(60);
    expect(asks).toBe(1);
    expect((document.getElementById('kiosk-start') as HTMLElement).style.display).toBe('none');
    window.dispatchEvent(new Event('resize')); await wait(60);
    expect(asks).toBe(1);
    orient = 'portrait'; window.dispatchEvent(new Event('resize')); await wait(20);
    expect(asks).toBe(2);
    expect((document.getElementById('kiosk-start') as HTMLElement).style.display).toBe('grid');
    stop();
  });

  it('lets Back close a sheet: with one open when full screen is lost, no cover and no tap until it closes', async () => {
    const stop = start();
    const cover = () => (document.getElementById('kiosk-start') as HTMLElement).style.display;
    // overlay.ts closes the sheet in its own popstate listener, registered after the kiosk's.
    const closeOnBack = () => { open = 0; };
    window.addEventListener('popstate', closeOnBack);
    await wait(20); fsChange(true); await wait(60);
    open = 1;                                                            // a sheet or the focus view
    fsChange(false); await wait(60);                                     // the first Back: Chrome leaves full screen
    expect(cover()).toBe('none');
    expect(asks).toBe(1);
    window.dispatchEvent(new Event('resize')); await wait(60);           // Chrome's bars came back
    expect(asks).toBe(1);
    window.dispatchEvent(new PopStateEvent('popstate')); await wait(20); // the next Back closes the sheet
    expect(cover()).toBe('grid');
    expect(asks).toBe(2);
    window.removeEventListener('popstate', closeOnBack);
    stop();
  });

  it('collapses a burst of viewport changes into one request, and keeps requests apart', async () => {
    const stop = start();
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event('resize'));
    await wait(20);
    expect(asks).toBe(1);
    window.dispatchEvent(new Event('orientationchange')); await wait(10);
    expect(asks).toBe(1);                                                // within the gap
    await wait(60);
    expect(asks).toBe(2);                                                // still not full screen after the gap: asked again
    stop();
  });

  it('comes back when the daemon says so (a launch is running), and stops asking when it has no kiosk', async () => {
    reply = { retryMs: 30 };
    const stop = start();
    await wait(20); expect(asks).toBe(1);
    reply = { disabled: true };
    await wait(60); expect(asks).toBe(2);
    window.dispatchEvent(new Event('resize')); await wait(80);
    expect(asks).toBe(2);
    stop();
  });

  it('does not ask from a background tab, and asks when the tab comes to the front', async () => {
    let vis = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
    const stop = start();
    await wait(30); expect(asks).toBe(0);
    vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await wait(20);
    expect(asks).toBe(1);
    stop();
  });
});
