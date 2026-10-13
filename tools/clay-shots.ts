/**
 * Render clay states for visual review, headlessly, with the real renderer (web/clay-bake.html in Chromium).
 *
 *   tools/sem.sh npx tsx tools/clay-shots.ts <outdir> [W1,W2,...|all] [--gallery] [--size=96] [--crops]
 *
 * For each state: every frame at board size as raw PNGs (<outdir>/raw/<id>-f<i>.png), a contact sheet of every
 * frame at 2x (<outdir>/<id>-sheet.png) and frames 0 and N/2 at 3x zoom (<outdir>/<id>-3x.png, nearest-neighbour,
 * so it shows exactly the board-size pixels). --crops writes a 3x crop of the face and hands of frame 0 of every
 * state (<outdir>/crops/<id>-face-3x.png). --gallery screenshots the lab gallery at 961x601 (<outdir>/gallery.png).
 * --editor screenshots the pose editor on the first state (<outdir>/editor.png). --puffed renders with the X2 modifier.
 * --pass=particles|highlight|eyes renders a test pass (Character.setDebug) instead of the normal picture.
 * --eyes writes, for every state with a half-closed or fully closed lid frame (lidFrames, as the eye test finds them),
 * <outdir>/eyes/<id>-f<i>-<half|full>.png: the face at 3x zoom of the board-size pixels, then the same frame rendered at
 * 3x (288 px), its catch-light pass (catch-lights flat magenta) and its eyeball pass (visible eyeball flat blue).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import { CHROMIUM_ARGS, findChromium } from '../src/clay/chromium.js';
import { CLAY_STATES, type ClayStateId } from '../web/src/clay/states.js';
import { frameCount, frameTime } from '../web/src/clay/timeline.js';
import { lidFrames } from '../test/helpers/clay-pixels.js';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const out = resolve(args[0] ?? 'clay-shots');
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}`));
const size = Number(flag('size')?.split('=')[1] ?? 96);
const pick = args[1] && !args[1].startsWith('--') ? args[1] : 'all';
const ids = (pick === 'all' ? CLAY_STATES : pick.split(',')) as ClayStateId[];

const blank = (w: number, h: number, bg = [22, 26, 33, 255]) => {
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) p.data.set(bg, i * 4);
  return p;
};
/** Paste `src` scaled by integer `k` (nearest) at (x, y), alpha-blended over the background. */
const paste = (dst: PNG, src: PNG, x: number, y: number, k: number, crop = { x: 0, y: 0, w: src.width, h: src.height }) => {
  for (let sy = 0; sy < crop.h; sy++) for (let sx = 0; sx < crop.w; sx++) {
    const si = ((crop.y + sy) * src.width + crop.x + sx) * 4;
    const a = src.data[si + 3] / 255;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) {
      const X = x + sx * k + dx, Y = y + sy * k + dy;
      if (X >= dst.width || Y >= dst.height) continue;
      const di = (Y * dst.width + X) * 4;
      for (let c = 0; c < 3; c++) dst.data[di + c] = Math.round(src.data[si + c] * a + dst.data[di + c] * (1 - a)); // PNG alpha is straight
    }
  }
};

const server = await createServer({ configFile: join(ROOT, 'web', 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: findChromium()!, args: CHROMIUM_ARGS });
try {
  const page = await browser.newPage();
  await page.goto(`${url}/clay-bake.html`);
  await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 60_000 });
  const render = async (id: ClayStateId, i: number, px = size) => {
    const b64 = await page.evaluate(([state, t, s, puffed, pass]) => (window as any).__clay.frame({ state, t, puffed, colour: '#e07a4f', shadows: true }, s, pass ? { pass } : undefined),
      [id, frameTime(id, i), px, !!flag('puffed'), flag('pass')?.split('=')[1]] as const);
    return Buffer.from(b64 as string, 'base64');
  };
  mkdirSync(join(out, 'raw'), { recursive: true });
  if (flag('crops')) mkdirSync(join(out, 'crops'), { recursive: true });
  for (const id of ids) {
    const n = frameCount(id);
    const frames: PNG[] = [];
    for (let i = 0; i < n; i++) {
      const buf = await render(id, i);
      writeFileSync(join(out, 'raw', `${id}-f${i}.png`), buf);
      frames.push(PNG.sync.read(buf));
    }
    const cols = Math.min(n, 8), k2 = 2, cell = size * k2 + 4;
    const sheet = blank(cols * cell, Math.ceil(n / cols) * cell);
    frames.forEach((f, i) => paste(sheet, f, (i % cols) * cell, Math.floor(i / cols) * cell, k2));
    writeFileSync(join(out, `${id}-sheet.png`), PNG.sync.write(sheet));
    const mid = Math.floor(n / 2);
    const z = blank(2 * size * 3 + 8, size * 3);
    paste(z, frames[0], 0, 0, 3);
    paste(z, frames[mid], size * 3 + 8, 0, 3);
    writeFileSync(join(out, `${id}-3x.png`), PNG.sync.write(z));
    if (flag('crops')) {
      // face and hands: the middle of the frame, where the body sits
      const c = { x: Math.round(size * 0.22), y: Math.round(size * 0.3), w: Math.round(size * 0.56), h: Math.round(size * 0.5) };
      const crop = blank(c.w * 3, c.h * 3);
      paste(crop, frames[0], 0, 0, 3, c);
      writeFileSync(join(out, 'crops', `${id}-face-3x.png`), PNG.sync.write(crop));
    }
    console.log(`${id}: ${n} frames`);
  }
  if (flag('eyes')) {
    mkdirSync(join(out, 'eyes'), { recursive: true });
    const shot = async (id: ClayStateId, i: number, px: number, pass?: string) => PNG.sync.read(Buffer.from(await page.evaluate(
      ([state, t, s, ps]) => (window as any).__clay.frame({ state, t, puffed: false, colour: '#e07a4f', shadows: true }, s, ps ? { pass: ps } : undefined),
      [id, frameTime(id, i), px, pass] as const) as string, 'base64'));
    for (const id of ids) {
      const { half, full } = lidFrames(id);
      for (const [i, kind] of [[half, 'half'], [full, 'full']] as const) {
        if (i === undefined) continue;
        // the face: the middle of the frame, where the eyes are
        const c = (k: number) => ({ x: Math.round(96 * k * 0.24), y: Math.round(96 * k * 0.3), w: Math.round(96 * k * 0.52), h: Math.round(96 * k * 0.44) });
        const cb = c(1), cw = cb.w * 3, ch = cb.h * 3;
        const sheet = blank(4 * (cw + 6), ch);
        paste(sheet, await shot(id, i, 96), 0, 0, 3, cb);
        for (const [n, pass] of [[1, undefined], [2, 'highlight'], [3, 'eyes']] as const) paste(sheet, await shot(id, i, 288, pass), n * (cw + 6), 0, 1, c(3));
        writeFileSync(join(out, 'eyes', `${id}-f${i}-${kind}.png`), PNG.sync.write(sheet));
      }
    }
    console.log('eyes done');
  }
  if (flag('editor')) {
    const e = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await e.goto(`${url}/clay-lab.html?view=editor`);
    await e.waitForFunction('!!window.__editor', undefined, { timeout: 60_000 });
    await e.evaluate((s) => { const ed = (window as any).__editor; ed.select(s); ed.frame(0); }, ids[0]);
    await e.screenshot({ path: join(out, 'editor.png') });
    console.log('editor done');
  }
  if (flag('gallery')) {
    // board size: the tablet's 961x601 CSS viewport at its 4/3 device pixel ratio, the whole page
    const g = await browser.newPage({ viewport: { width: 961, height: 601 }, deviceScaleFactor: 4 / 3 });
    await g.goto(`${url}/clay-lab.html?view=gallery&mode=bake`);
    await g.waitForFunction('(() => { const s = window.__lab?.clay.status(); return s && s.baked >= s.total && s.total > 0; })()', undefined, { timeout: 600_000, polling: 1000 });
    // keep the board's row height of the 961x601 viewport, then make the page tall enough to show every group
    const h = await g.evaluate(() => {
      document.documentElement.style.setProperty('--row', `${Math.min(120, Math.max(72, innerHeight * 0.15))}px`); // style.css's clamp, frozen
      return document.getElementById('app')!.scrollHeight;
    });
    await g.setViewportSize({ width: 961, height: Math.max(601, h + 30) });
    await g.waitForTimeout(1500);
    await g.screenshot({ path: join(out, 'gallery.png') });
    console.log('gallery done');
  }
} finally {
  await browser.close();
  await server.close();
}
