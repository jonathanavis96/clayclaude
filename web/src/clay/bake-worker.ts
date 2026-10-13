/// <reference lib="webworker" />
import { bakeSheet, encodeSheet } from './bake.js';
import type { SheetKey } from './sheet.js';
import { Stage } from './stage.js';

/** Messages: in {id, key}; out {id, kind:'bitmap', bitmap, renderMs} then {id, kind:'png', png, encodeMs}, or {id, kind:'error', error}. */
export type BakeIn = { id: number; key: SheetKey; frames?: number; paceMs?: number };
export type BakeOut =
  | { id: number; kind: 'bitmap'; bitmap: ImageBitmap; renderMs: number }
  | { id: number; kind: 'png'; png: Blob; encodeMs: number }
  | { id: number; kind: 'error'; error: string };

declare const self: DedicatedWorkerGlobalScope;
let stage: Stage | null = null;

self.onmessage = async (e: MessageEvent<BakeIn>) => {
  const { id, key, frames, paceMs } = e.data;
  try {
    if (!stage || stage.lost()) { stage?.dispose(); stage = new Stage(new OffscreenCanvas(key.size, key.size)); }
    const sheet = await bakeSheet(stage, key, { frames, paceMs });
    const bitmap = await createImageBitmap(sheet.canvas);
    self.postMessage({ id, kind: 'bitmap', bitmap, renderMs: sheet.renderMs } satisfies BakeOut, [bitmap]);
    const t = performance.now();
    const png = await encodeSheet(sheet.canvas);
    self.postMessage({ id, kind: 'png', png, encodeMs: performance.now() - t } satisfies BakeOut);
  } catch (err) {
    self.postMessage({ id, kind: 'error', error: String((err as Error)?.message ?? err) } satisfies BakeOut);
  }
};
