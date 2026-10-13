/**
 * Headless bake page (web/clay-bake.html). The daemon's PC baker and the snapshot tests drive it
 * through a headless Chromium: same renderer code as the tablet, so a PC-baked sheet matches.
 */
import { bakeSheet, encodeSheet, makeCanvas } from './bake.js';
import { layoutFor, type SheetKey } from './sheet.js';
import type { DebugPass } from './character.js';
import { Stage, type RenderSpec } from './stage.js';
import { RENDERER_VERSION } from './version.js';

const stage = new Stage(document.createElement('canvas'));

async function toBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export interface BakePageApi {
  version: string;
  /** One frame as a base64 PNG (snapshot tests). `debug`: a test pass (round 3's eye and particle checks). */
  frame(spec: RenderSpec, size: number, debug?: DebugPass): Promise<string>;
  /** A whole sheet as a base64 PNG with its layout (PC baker). */
  sheet(key: SheetKey): Promise<{ png: string; frames: number; cols: number; rows: number }>;
}

const api: BakePageApi = {
  version: RENDERER_VERSION,
  async frame(spec, size, debug) {
    stage.setSize(size);
    stage.render(spec, debug);
    const c = makeCanvas(size, size);
    (c.getContext('2d') as CanvasRenderingContext2D).drawImage(stage.canvas as CanvasImageSource, 0, 0);
    return toBase64(await encodeSheet(c));
  },
  async sheet(key) {
    const s = await bakeSheet(stage, key);
    const l = layoutFor(key);
    return { png: await toBase64(await encodeSheet(s.canvas)), frames: l.frames, cols: l.cols, rows: l.rows };
  },
};

Object.assign(window, { __clay: api, __clayReady: true });
