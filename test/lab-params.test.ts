import { describe, it, expect } from 'vitest';
import { labParams } from '../web/src/clay/lab-params.js';

// The clay lab is one of the app's pages, which the request guard lets a cross-site navigation open (src/security.ts).
// Such a link must not be able to make the daemon spin up its headless PC baker, so outside the dev server the URL
// can neither pick "pc" nor force the fallback to it (`fail`, which drives Auto down to pc).
describe('clay lab URL parameters', () => {
  it('on the dev server: mode, fail and n as given', () => {
    expect(labParams('?mode=pc&fail=worker,main&n=4', true)).toEqual({ mode: 'pc', fail: new Set(['worker', 'main']), n: 4, layout: 'strips' });
    expect(labParams('?mode=bake', true)).toMatchObject({ mode: 'bake', fail: new Set() });
  });
  it('in a build: mode=pc and fail are ignored, bake and live still work', () => {
    expect(labParams('?mode=pc', false).mode).toBe('auto');
    expect(labParams('?mode=auto&fail=worker,main', false).fail).toEqual(new Set());
    expect(labParams('?mode=bake', false).mode).toBe('bake');
    expect(labParams('?mode=live', false).mode).toBe('live');
  });
  it('an unknown mode is auto, and the board row count is bounded', () => {
    expect(labParams('?mode=zzz', true).mode).toBe('auto');
    expect(labParams('', false)).toEqual({ mode: 'auto', fail: new Set(), n: 8, layout: 'strips' });
    expect(labParams('?n=100000', false).n).toBe(40);
    expect(labParams('?n=-3', false).n).toBe(1);
    expect(labParams('?n=abc', false).n).toBe(8);
  });
  // The board view is pinned to strips unless asked: its browser checks count `.row`s, and auto would switch 10 rows
  // to the grid on a short screen. layout=grid (or auto) drives the grid's own check.
  it('the board layout is strips unless the URL asks for grid or auto', () => {
    expect(labParams('?layout=grid', false).layout).toBe('grid');
    expect(labParams('?layout=auto', false).layout).toBe('auto');
    expect(labParams('?layout=strips', false).layout).toBe('strips');
    expect(labParams('?layout=zzz', false).layout).toBe('strips');
  });
});
