import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import type { Browser, Page } from 'playwright-core';
import { CHROMIUM, launch, startWeb } from './helpers/browser.js';
import { JUMP, PARTICLE_ALPHA, PARTICLE_MASS, PARTICLE_MASS_SPIKE, PARTICLE_SPIKE, POP, TILE_JUMP, particleReach } from './helpers/clay-limits.js';
import { blobs, frameDiff, injectParticle, jumpCheck, luma, particleCheck, particleMassSpike, particleSpikeCheck, renderFrame, renderLoop } from './helpers/clay-pixels.js';
import type { PoseKey } from '../web/src/clay/pose.js';
import { CLAY_STATES, type ClayStateId } from '../web/src/clay/states.js';
import { frameCount, frameTime, poseFor } from '../web/src/clay/timeline.js';

/**
 * Nothing pops (spec §7.4.7 round 2, §7.4.8 round 3): every frame of every state, rendered at board size by the real
 * renderer, is compared with the next, the last with the first (every state loops, so every loop seam is covered).
 *  - whole frame: no adjacent pair differs by more than JUMP (round 2's check);
 *  - 8x8 tiles: no tile flashes, i.e. shows something for one frame only in still surroundings (round 3: the whole-frame
 *    check missed a one-frame particle; the fixtures below prove this one does not), and no tile pops, i.e. steps far
 *    more than anything round it moves the frame before and after (a loop seam whose ends do not meet);
 *  - particle pass: every particle (0/1 bits, Zzz, sweat, steam, sparkle stars, snore bubble, ringing arcs, ice glints)
 *    fades or grows in and out, never appearing or vanishing at strength in one frame (particleCheck), and no particle
 *    shows, or goes missing, for a single frame, however busy it is round it: block matching (particleSpikeCheck) and
 *    each neighbourhood's total particle mass against the frames either side (particleMassSpike).
 */
const SIZE = 96;

describe.skipIf(!CHROMIUM)('clay frame-jump check: every state, every adjacent pair, every loop seam (rounds 2 and 3)', () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  let page: Page;
  const normal = new Map<ClayStateId, PNG[]>();
  const particles = new Map<ClayStateId, PNG[]>();
  beforeAll(async () => {
    web = await startWeb();
    browser = await launch();
    page = await browser.newPage();
    await page.goto(`${web.url}/clay-bake.html`);
    await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 60_000 });
    for (const id of CLAY_STATES) {
      normal.set(id, await renderLoop(page, id, SIZE));
      particles.set(id, await renderLoop(page, id, SIZE, { pass: 'particles' }));
    }
  }, 300_000);
  afterAll(async () => { await browser?.close(); await web?.close(); });

  /** The centre of an 8x8 spot, clear of the frame edge, that never changes over the loop (`frames` stand still there). */
  const stillSpot = (frames: PNG[]) => {
    const L = frames.map(luma);
    for (let y = 60; y < SIZE - 12; y += 4) for (let x = 8; x < SIZE - 16; x += 4) {
      let still = true;
      for (let k = 1; k < L.length && still; k++) for (let dy = -6; dy < 14 && still; dy++) for (let dx = -6; dx < 14 && still; dx++) {
        const i = (y + dy) * SIZE + x + dx;
        still = Math.abs(L[k].v[i] - L[0].v[i]) < 0.002;
      }
      if (still) return { x: x + 4, y: y + 4 };
    }
    throw new Error('no still spot');
  };
  /** A spot with no particle within 12 px in any frame of the particle pass. */
  const emptySpot = (frames: PNG[]) => {
    for (let y = 14; y < SIZE - 14; y += 4) for (let x = 14; x < SIZE - 14; x += 4) {
      let empty = true;
      for (const f of frames) for (let dy = -12; dy <= 12 && empty; dy++) for (let dx = -12; dx <= 12 && empty; dx++) {
        empty = f.data[((y + dy) * SIZE + x + dx) * 4 + 3] === 0;
      }
      if (empty) return { x, y };
    }
    throw new Error('no empty spot');
  };

  it('regression fixture: a particle shown for one frame fails the tile check, mid-loop and at the loop seam; round 2\'s whole-frame limit alone misses it', () => {
    const frames = normal.get('W2')!;
    const spot = stillSpot(frames);
    expect(jumpCheck(frames.map(luma), TILE_JUMP).spikes, 'the real W2 passes').toEqual([]);
    for (const k of [10, 0]) { // frame 0: its neighbours are the last frame (the seam) and frame 1
      const L = frames.map((f, i) => luma(i === k ? injectParticle(f, spot.x, spot.y) : f));
      // the particle itself is a tiny part of the frame, and the whole-frame check passes with it in
      expect(frameDiff(L[k], luma(frames[k])), 'the particle\'s own share of the frame').toBeLessThan(JUMP / 20);
      const r = jumpCheck(L, TILE_JUMP);
      expect(r.worst.diff, 'round 2\'s whole-frame check passes it').toBeLessThanOrEqual(JUMP);
      expect(r.spikes.filter((s) => s.startsWith(`flash at frame ${k} `)), `one-frame particle at frame ${k}`).not.toEqual([]);
    }
  });

  it('regression fixture: on the particle pass, a particle shown for one frame, or popping in and out at full strength, fails the particle check', () => {
    const frames = particles.get('W2')!;
    expect(particleCheck(frames, PARTICLE_MASS, PARTICLE_ALPHA).events, 'the real W2 passes').toEqual([]);
    const spot = emptySpot(frames);
    const n = frames.length;
    const once = frames.map((f, i) => (i === 5 ? injectParticle(f, spot.x, spot.y) : f));
    expect(particleCheck(once, PARTICLE_MASS, PARTICLE_ALPHA).events.map((e) => e.split(' (')[0])).toEqual(['appears at 4->5', 'vanishes at 5->6']);
    const stays = frames.map((f, i) => (i >= 5 && i <= 20 ? injectParticle(f, spot.x, spot.y) : f));
    expect(particleCheck(stays, PARTICLE_MASS, PARTICLE_ALPHA).events.map((e) => e.split(' (')[0])).toEqual(['appears at 4->5', 'vanishes at 20->21']);
    const seam = frames.map((f, i) => (i === 0 ? injectParticle(f, spot.x, spot.y) : f));
    expect(particleCheck(seam, PARTICLE_MASS, PARTICLE_ALPHA).events.map((e) => e.split(' (')[0]).sort()).toEqual([`appears at ${n - 1}->0`, 'vanishes at 0->1']);
  });

  /** `f` with the particle pixels of `extra` laid over it (the more opaque wins). */
  const over = (f: PNG, extra: PNG) => {
    const out = PNG.sync.read(PNG.sync.write(f));
    for (let i = 0; i < f.data.length; i += 4) if (extra.data[i + 3] > out.data[i + 3]) extra.data.copy(out.data, i, i, i + 4);
    return out;
  };
  const spikesAt = (frames: PNG[], id: ClayStateId, kind: 'flash' | 'gap', k: number) =>
    particleSpikeCheck(frames, PARTICLE_SPIKE, particleReach(id)).events.filter((e) => e.startsWith(`${kind} at frame ${k} `));
  const massAt = (frames: PNG[], id: ClayStateId, kind: 'flash' | 'gap', k: number) =>
    particleMassSpike(frames, PARTICLE_MASS_SPIKE, particleReach(id)).events.filter((e) => e.startsWith(`mass ${kind} at frame ${k} `));

  it('regression fixture: a particle shown for one frame right beside another (touching a W2 bit; an extra Z beside S3\'s Zzz) fails both spike checks in every frame of the loop, seam included; the blob check alone misses it', () => {
    const w2 = particles.get('W2')!;
    expect(particleSpikeCheck(w2, PARTICLE_SPIKE, particleReach('W2')).events, 'the real W2 passes').toEqual([]);
    expect(particleMassSpike(w2, PARTICLE_MASS_SPIKE, particleReach('W2')).events, 'the real W2 passes the mass check').toEqual([]);
    const missed: number[] = [], massMissed: number[] = [], blobMissed: number[] = [];
    w2.forEach((f, k) => {
      const bit = blobs(f).sort((a, b) => b.mass - a.mass)[0]; // a whole bit; the stand-in touches its right side
      const once = w2.map((g, i) => (i === k ? injectParticle(g, bit.x + 7, bit.y) : g));
      if (!spikesAt(once, 'W2', 'flash', k).length) missed.push(k);
      if (!massAt(once, 'W2', 'flash', k).length) massMissed.push(k);
      if (!particleCheck(once, PARTICLE_MASS, PARTICLE_ALPHA).events.length) blobMissed.push(k);
    });
    expect(missed, 'W2 frames where the spike check missed it').toEqual([]);
    expect(massMissed, 'W2 frames where the mass check missed it').toEqual([]);
    expect(blobMissed.length, 'the blob check alone misses most of them (it counts a blob touching a bit as moving)').toBeGreaterThan(w2.length / 2);

    // S3: frame k gets the Zzz of the frame a sixth of a loop on laid over its own, so an extra Z shows beside each Z
    const s3 = particles.get('S3')!;
    expect(particleSpikeCheck(s3, PARTICLE_SPIKE, particleReach('S3')).events, 'the real S3 passes').toEqual([]);
    expect(particleMassSpike(s3, PARTICLE_MASS_SPIKE, particleReach('S3')).events, 'the real S3 passes the mass check').toEqual([]);
    const shift = Math.round(s3.length / 6), zMissed: number[] = [], zMassMissed: number[] = [];
    s3.forEach((f, k) => {
      const once = s3.map((g, i) => (i === k ? over(g, s3[(k + shift) % s3.length]) : g));
      if (!spikesAt(once, 'S3', 'flash', k).length) zMissed.push(k);
      if (!massAt(once, 'S3', 'flash', k).length) zMassMissed.push(k);
    });
    expect(zMissed, 'S3 frames where the spike check missed the extra Z').toEqual([]);
    expect(zMassMissed, 'S3 frames where the mass check missed the extra Z').toEqual([]);
    }, 120_000);

  it('regression fixture (the round-3 review\'s case): S3\'s middle Z rendered at full strength and size for one frame, merged with its neighbouring Zs, fails the mass check in every frame of the loop, seam included', async () => {
    const s3 = particles.get('S3')!;
    const massMissed: string[] = [], blobCaught: number[] = [];
    let least = Infinity;
    for (let k = 0; k < s3.length; k++) {
      const flashed = await renderFrame(page, 'S3', frameTime('S3', k), SIZE, { pass: 'particles', zFlash: true });
      const once = s3.map((g, i) => (i === k ? flashed : g));
      const r = particleMassSpike(once, PARTICLE_MASS_SPIKE, particleReach('S3'));
      least = Math.min(least, r.flash);
      if (!r.events.some((e) => e.startsWith(`mass flash at frame ${k} `))) massMissed.push(`frame ${k}: ${r.flash.toFixed(1)}`);
      if (particleCheck(once, PARTICLE_MASS, PARTICLE_ALPHA).events.length) blobCaught.push(k);
    }
    console.log(`S3 middle Z flashed for one frame: least mass spike over the loop ${least.toFixed(1)} (limit ${PARTICLE_MASS_SPIKE}); blob check caught ${blobCaught.length} of ${s3.length}`);
    expect(massMissed, 'S3 frames where the mass check missed the flashed Z').toEqual([]);
  }, 120_000);

  it('regression fixture: a W2 bit missing for one frame fails the particle checks in every frame, seam included', () => {
    const w2 = particles.get('W2')!;
    const missed: number[] = [], spikeMissed: number[] = [];
    w2.forEach((f, k) => {
      const bit = blobs(f).sort((a, b) => b.mass - a.mass)[0];
      const gone = PNG.sync.read(PNG.sync.write(f));
      for (const j of bit.px) gone.data[j * 4 + 3] = 0;
      const frames = w2.map((g, i) => (i === k ? gone : g));
      const spike = spikesAt(frames, 'W2', 'gap', k).length > 0 || massAt(frames, 'W2', 'gap', k).length > 0;
      if (!spike) spikeMissed.push(k);
      if (!spike && !particleCheck(frames, PARTICLE_MASS, PARTICLE_ALPHA).events.length) missed.push(k);
    });
    expect(missed, 'W2 frames where both checks missed the missing bit').toEqual([]);
    // the spike check alone misses only a bit still fading in the frame before (its gap is the smaller side's mass);
    // the blob check sees that one vanish and come back
    expect(spikeMissed.length, `frames the spike check alone missed: ${spikeMissed.join(', ')}`).toBeLessThanOrEqual(w2.length / 8);
    }, 120_000);

  it('regression fixture: a loop whose ends do not meet pops at the seam (W1\'s squash, S1\'s eyes, X2\'s body), which the whole-frame limit misses', async () => {
    const cases: Array<[ClayStateId, PoseKey, number]> = [['W1', 'squash', 0.1], ['S1', 'eyeOpen', -0.5], ['X2', 'bodyX', 0.15]];
    for (const [id, key, by] of cases) {
      // the key drifts by `by` over the loop, so the last frame is `by` away from the first: a seam that jumps
      const n = frameCount(id), frames: PNG[] = [];
      for (let i = 0; i < n; i++) {
        const t = frameTime(id, i);
        frames.push(await renderFrame(page, id, t, SIZE, { pass: 'normal', pose: { [key]: poseFor(id, t, false)[key] + (by * i) / (n - 1) } }));
      }
      const r = jumpCheck(frames.map(luma), TILE_JUMP, POP);
      expect(r.worst.diff, `${id}: round 2's whole-frame check passes it`).toBeLessThanOrEqual(JUMP);
      expect(r.pops.filter((p) => p.startsWith(`pop at ${n - 1}->0 `)), `${id} ${key} ${by > 0 ? '+' : ''}${by} at the seam`).not.toEqual([]);
      expect(jumpCheck(normal.get(id)!.map(luma), TILE_JUMP, POP).pops, `the real ${id} passes`).toEqual([]);
    }
  }, 120_000);

  it('every state loops: the seam (last frame -> first) is checked like any other pair', () => {
    for (const id of CLAY_STATES) expect(normal.get(id)!.length, id).toBe(frameCount(id));
  });

  it('no adjacent pair of any state, seam included, jumps more than the whole-frame limit; no tile flashes or pops; no particle pops, flashes or gaps', () => {
    const bad: string[] = [];
    const report: string[] = [];
    for (const id of CLAY_STATES) {
      if (frameCount(id) < 2) continue; // X1 is still
      const r = jumpCheck(normal.get(id)!.map(luma), TILE_JUMP, POP);
      const p = particleCheck(particles.get(id)!, PARTICLE_MASS, PARTICLE_ALPHA);
      const q = particleSpikeCheck(particles.get(id)!, PARTICLE_SPIKE, particleReach(id));
      const ms = particleMassSpike(particles.get(id)!, PARTICLE_MASS_SPIKE, particleReach(id));
      report.push(`${id} worst pair ${r.worst.pair} ${r.worst.diff.toFixed(4)}, worst pop ${r.worstPop.pair} ${r.worstPop.ratio.toFixed(2)}x `
        + `(seam ${r.popRatios[r.popRatios.length - 1].toFixed(2)}x), particle flash ${q.flash.toFixed(1)} gap ${q.gap.toFixed(1)}, mass flash ${ms.flash.toFixed(1)} gap ${ms.gap.toFixed(1)}`);
      if (r.worst.diff > JUMP) bad.push(`${id}: pair ${r.worst.pair} differs by ${r.worst.diff.toFixed(4)} (limit ${JUMP})`);
      bad.push(...r.spikes.map((s) => `${id}: ${s}`), ...r.pops.map((s) => `${id}: ${s}`), ...p.events.map((e) => `${id}: particle ${e}`),
        ...q.events.map((e) => `${id}: particle ${e}`), ...ms.events.map((e) => `${id}: particle ${e}`));
    }
    console.log(`per state (limits: pair ${JUMP}, pop ${POP.any}x, seam pop ${POP.seam}x, particle spike ${PARTICLE_SPIKE}, mass spike ${PARTICLE_MASS_SPIKE}):\n  ${report.join('\n  ')}`);
    expect(bad).toEqual([]);
  }, 120_000);
});
