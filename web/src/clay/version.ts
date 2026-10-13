declare const __CLAY_VERSION__: string | undefined;

/**
 * Renderer version: a hash of the files that decide what a frame looks like, injected at build time
 * by `web/clay-version.ts` (Vite and Vitest `define`). Baked sheets and the stored Auto choice are
 * keyed by it, so changing the character re-bakes and re-measures by itself.
 */
export const RENDERER_VERSION: string = typeof __CLAY_VERSION__ === 'string' ? __CLAY_VERSION__ : 'dev';
