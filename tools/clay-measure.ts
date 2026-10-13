/**
 * Measure clay states with the real renderer (web/clay-bake.html in headless Chromium), as the round-3 tests do
 * (spec §7.4.8): each state's motion (mean frame-to-frame difference per second of animation), the worst adjacent
 * frame pair (loop seam included), the worst 8x8 tile, and the frame-jump check's pops and flashes, on the normal
 * render and on the particle-only pass.
 *
 *   tools/sem.sh npx tsx tools/clay-measure.ts [W1,W2,...|all] [--md=<file>]
 *
 * --md writes the motion table to <file>.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { CHROMIUM_ARGS, findChromium } from '../src/clay/chromium.js';
import { SCRIPTS } from '../web/src/clay/scripts.js';
import { CLAY_STATES, type ClayStateId } from '../web/src/clay/states.js';
import { frameCount, loopMs } from '../web/src/clay/timeline.js';
import { JUMP, MOTION_ORDERS, MOTION_STEP, PARTICLE_ALPHA, PARTICLE_MASS, TILE_JUMP } from '../test/helpers/clay-limits.js';
import { jumpCheck, luma, motionPerSecond, particleCheck, renderLoop } from '../test/helpers/clay-pixels.js';

const ROOT = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const pick = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const ids = (pick === 'all' ? CLAY_STATES : pick.split(',')) as ClayStateId[];
const md = args.find((a) => a.startsWith('--md='))?.slice(5);

const server = await createServer({ configFile: join(ROOT, 'web', 'vite.config.ts'), server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = `http://127.0.0.1:${(server.httpServer!.address() as { port: number }).port}`;
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ executablePath: findChromium()!, args: CHROMIUM_ARGS });
const pairs: number[] = [];
const rows: Array<{ id: ClayStateId; motion: number; worst: string; tile: string; spikes: number; pspikes: number }> = [];
try {
  const page = await browser.newPage();
  await page.goto(`${url}/clay-bake.html`);
  await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 60_000 });
  for (const id of ids) {
    if (frameCount(id) < 2) { console.log(`${id}: still`); continue; }
    const r = jumpCheck((await renderLoop(page, id, 96)).map(luma), TILE_JUMP);
    pairs.push(...r.diffs);
    const p = particleCheck(await renderLoop(page, id, 96, { pass: 'particles' }), PARTICLE_MASS, PARTICLE_ALPHA);
    const motion = motionPerSecond(r.mean, SCRIPTS[id].fps) * 1000;
    rows.push({ id, motion, worst: `${r.worst.pair} ${(r.worst.diff * 1000).toFixed(2)}`, tile: `${r.worstTile.pair} ${r.worstTile.diff.toFixed(3)}`, spikes: r.spikes.length, pspikes: p.events.length });
    console.log(`${id} ${frameCount(id)}f@${SCRIPTS[id].fps} ${loopMs(id)}ms  motion ${motion.toFixed(2)}  worst pair ${rows.at(-1)!.worst} (limit ${(JUMP * 1000).toFixed(1)})  worst tile ${rows.at(-1)!.tile}  flashes ${r.spikes.length}  particle pops ${p.events.length} (worst appear/vanish mass ${p.worst.toFixed(1)})`);
    for (const s of r.spikes.slice(0, 4)) console.log(`    ${s}`);
    for (const s of p.events.slice(0, 4)) console.log(`    particles: ${s}`);
  }
} finally {
  await browser.close();
  await server.close();
}
pairs.sort((a, b) => a - b);
const p99 = pairs[Math.min(pairs.length - 1, Math.floor(pairs.length * 0.99))] ?? 0;
console.log(`adjacent pairs: ${pairs.length}, 99th percentile ${(p99 * 1000).toFixed(2)}, x2 = ${(p99 * 2000).toFixed(2)}, max ${((pairs.at(-1) ?? 0) * 1000).toFixed(2)} (limit ${(JUMP * 1000).toFixed(1)})`);

if (md) {
  const by = new Map(rows.map((r) => [r.id, r]));
  const order = (line: readonly ClayStateId[]) => line.map((id, i) => {
    const m = by.get(id)?.motion ?? NaN, prev = i ? by.get(line[i - 1])?.motion ?? NaN : NaN;
    return `| ${id} | ${m.toFixed(2)} | ${i ? `${(m / prev).toFixed(2)}x` : '—'} |`;
  }).join('\n');
  const lines = [
    '# Round 3: measured motion (spec §7.4.8)',
    '',
    `Measured by \`tools/clay-measure.ts\` with the real renderer at board size (96 px), every baked frame of one loop,`,
    'seam included. Motion is the mean absolute luminance difference between adjacent frames (frames composited over the',
    'board background), scaled to 24 frames a second, ×1000. The test (`test/clay-motion.test.ts`) requires each step to be',
    `at least ${MOTION_STEP}× the one before.`,
    '',
    ...MOTION_ORDERS.flatMap((line) => [`| State | Motion | × previous |`, '|---|---|---|', order(line), '']),
    '## Every state',
    '',
    `Worst adjacent pair: mean frame difference ×1000 (limit ${(JUMP * 1000).toFixed(1)}; over all ${pairs.length} adjacent pairs the 99th`,
    `percentile is ${(p99 * 1000).toFixed(2)}, the largest ${((pairs.at(-1) ?? 0) * 1000).toFixed(2)}). Worst tile: the largest 8×8 tile`,
    `difference between adjacent frames. Flashes: one-frame flashes found by the tile check on the normal render (tile`,
    `threshold ${TILE_JUMP}, limit 0). Particle pops: particles that appear or vanish between two frames both big (over`,
    `${PARTICLE_MASS} fully opaque pixels' worth) and strong (a pixel over ${PARTICLE_ALPHA} alpha), on the particle-only pass (limit 0).`,
    '',
    '| State | Motion | Worst pair | Worst tile | Flashes | Particle pops |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.motion.toFixed(2)} | ${r.worst} | ${r.tile} | ${r.spikes} | ${r.pspikes} |`),
    '',
  ];
  writeFileSync(resolve(md), lines.join('\n'));
  console.log(`wrote ${md}`);
}
