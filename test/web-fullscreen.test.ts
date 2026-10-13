import { describe, it, expect } from 'vitest';
import { enterFullscreen } from '../web/src/fullscreen.js';

describe('full-screen fallback', () => {
  it('goes full screen with the navigation UI hidden, and locks no orientation (the board follows a rotation, Task 35)', async () => {
    const calls: string[] = [];
    const doc = { documentElement: { requestFullscreen: async (o?: { navigationUI?: string }) => { calls.push(`fs:${o?.navigationUI}`); } } };
    expect(await enterFullscreen(doc)).toEqual({ ok: true });
    expect(calls).toEqual(['fs:hide']);
  });
  it('reports a refused full screen', async () => {
    const doc = { documentElement: { requestFullscreen: async () => { throw new Error('Permissions check failed'); } } };
    expect(await enterFullscreen(doc)).toEqual({ ok: false, error: 'Permissions check failed' });
  });
});
