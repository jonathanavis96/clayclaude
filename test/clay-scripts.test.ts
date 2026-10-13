import { describe, it, expect } from 'vitest';
import { FACE_KEYS, POSE_KEYS, PROP_KEYS, evalScript, type Pose, type PoseKey } from '../web/src/clay/pose.js';
import { FACE_INTENSITY, FROZEN, SCRIPTS } from '../web/src/clay/scripts.js';
import { CLAY_STATES, type ClayStateId } from '../web/src/clay/states.js';
import { frameCount, frameTime, poseFor, puffCycles } from '../web/src/clay/timeline.js';

const close = (a: Pose, b: Pose, eps = 1e-6) => POSE_KEYS.filter((k) => Math.abs(a[k] - b[k]) > eps);

describe('state scripts', () => {
  it('every state has a script and only known pose keys', () => {
    for (const id of CLAY_STATES) {
      expect(SCRIPTS[id], id).toBeDefined();
      for (const k of Object.keys(SCRIPTS[id].channels)) expect(POSE_KEYS as readonly string[], `${id}.${k}`).toContain(k);
    }
  });

  it('keyframes are in order, inside 0..1, and sine/saw cycles are whole numbers', () => {
    for (const id of CLAY_STATES) for (const [k, c] of Object.entries(SCRIPTS[id].channels)) {
      const keys = c!.keys ?? [];
      keys.forEach(([t], i) => { expect(t, `${id}.${k}`).toBeGreaterThanOrEqual(0); expect(t).toBeLessThanOrEqual(1); if (i) expect(t).toBeGreaterThan(keys[i - 1][0]); });
      for (const [cy] of c!.sin ?? []) expect(Number.isInteger(cy), `${id}.${k} sin`).toBe(true);
      if (c!.saw) expect(Number.isInteger(c!.saw[0]), `${id}.${k} saw`).toBe(true);
    }
  });

  it('every state is seamless: the pose at t=1 is the pose at t=0, puffed or not (authored overrides included)', () => {
    for (const id of CLAY_STATES) {
      expect(close(evalScript(SCRIPTS[id], 0), evalScript(SCRIPTS[id], 1)), `${id} script`).toEqual([]);
      expect(close(poseFor(id, 0, false), poseFor(id, 1, false)), id).toEqual([]);
      expect(close(poseFor(id, 0, true), poseFor(id, 1, true)), `${id} puffed`).toEqual([]);
    }
  });

  it('there are no "plays once" states: every state loops, W1 and S1 included (round 3)', () => {
    for (const id of CLAY_STATES) expect(SCRIPTS[id], id).not.toHaveProperty('once');
    for (const id of ['W1', 'S1'] as const) expect(frameCount(id), id).toBeGreaterThan(20);
  });

  it('every sine has at least 4 baked frames per cycle, so nothing aliases into a jitter', () => {
    for (const id of CLAY_STATES) {
      const n = frameCount(id as ClayStateId);
      if (n === 1) continue;
      for (const [k, c] of Object.entries(SCRIPTS[id].channels)) for (const [cy] of c!.sin ?? []) expect(n / cy, `${id}.${k}`).toBeGreaterThanOrEqual(4);
      expect(n / puffCycles(id), `${id} puff`).toBeGreaterThanOrEqual(4);
    }
  });

  it('a still state (X1) is one frame and never moves', () => {
    expect(frameCount('X1')).toBe(1);
    expect(close(poseFor('X1', 0, false), poseFor('X1', 0.5, true))).toEqual([]);
  });

  it('X2 alone is the idle pose puffed, with the gauge showing', () => {
    expect(poseFor('X2', 0, false).gauge).toBe(1);
    expect(poseFor('X2', 0, false).puff).toBe(1);
    expect(poseFor('W2', 0, false).gauge).toBe(0);
    expect(poseFor('W2', 0, true).gauge).toBe(1);
  });

  // Spec §7.4 (visual requirements). The visual review gate (Task 4 Step 7, Task 11) checks the pictures; these
  // check the data the pictures come from.
  const frames = (id: ClayStateId) => Array.from({ length: frameCount(id) }, (_, i) => poseFor(id, frameTime(id, i), false));

  it('one size for every state: no pose key scales the body, and no state keeps it squashed or moved (§7.4.1)', () => {
    expect(POSE_KEYS as readonly string[]).not.toContain('scale');
    for (const id of CLAY_STATES) {
      if (id === 'X4') continue; // compacting is a squash-and-stretch press: squashing is the action itself
      const f = frames(id);
      const mean = (k: 'squash' | 'bodyY' | 'bodyX') => f.reduce((n, p) => n + p[k], 0) / f.length;
      expect(Math.abs(mean('squash')), `${id} squash`).toBeLessThanOrEqual(0.06); // S1's stretch averages 0.05
      expect(Math.abs(mean('bodyY')), `${id} bodyY`).toBeLessThanOrEqual(0.1);
      expect(Math.abs(mean('bodyX')), `${id} bodyX`).toBeLessThanOrEqual(0.05);
    }
  });

  it('every needs-you state shows the "?" bubble in every frame, and it is the only "?" (§7.4.2; gallery review note A)', () => {
    for (const id of CLAY_STATES.filter((s) => s.startsWith('N'))) {
      frames(id).forEach((p, i) => expect(p.qbubble, `${id} frame ${i}`).toBeGreaterThan(0.5));
      frames(id).forEach((p, i) => expect(p.qmark, `${id} frame ${i}: no second "?"`).toBeLessThanOrEqual(0.01));
    }
  });

  it('no armbands: no state wears sleeves (round 3: W1 is a warm-up with no sleeves; §7.4.4)', () => {
    for (const id of CLAY_STATES) expect(frames(id).some((p) => p.sleeves > 0.01), id).toBe(false);
    expect(PROP_KEYS as readonly string[]).not.toContain('sleeves');
  });

  // What a still frame shows: the props, the face keys, and the few motions that read in a still (blurred hands,
  // knock ripples, crossed arms, lying flat). Props accumulate; faces and motions do not.
  const crossed = (p: Pose) => p.aLz < -0.9 && p.aRz < -0.9;
  const FEATURES = ['fastHands', 'sleeves', 'curl', 'lie', 'grey', 'xEyes', 'sparkle'] as const; // sparkle: S1's look (no check, note C)
  const shownIn = (id: ClayStateId, ps: Pose[]) => {
    const s = new Set<string>();
    for (const p of ps) {
      for (const k of [...PROP_KEYS, ...FACE_KEYS, ...FEATURES]) if (p[k] > 0.5) s.add(k);
      if (crossed(p)) s.add('crossedArms');
    }
    return [...s].sort().join('+') || '(none)';
  };
  const snap = (id: ClayStateId) => [...new Set([0, Math.floor(frameCount(id) / 2)])].map((i) => poseFor(id, frameTime(id, i), false));

  it('within each group (W, N, S, X) no two states look the same at frames 0 and N/2 (§7.4.4–6)', () => {
    for (const g of ['W', 'N', 'S', 'X']) {
      const ids = CLAY_STATES.filter((s) => s.startsWith(g));
      const sigs = ids.map((id) => shownIn(id, snap(id)));
      expect(new Set(sigs).size, ids.map((id, i) => `${id}=${sigs[i]}`).join('  ')).toBe(ids.length);
    }
  });

  const TIMELINES = ['W', 'N', 'S'].map((g) => CLAY_STATES.filter((s) => s.startsWith(g)));

  it('props accumulate along each timeline: every prop seen in step k-1 is shown in every frame of step k (§7.2)', () => {
    for (const line of TIMELINES) {
      expect(line).toHaveLength(7);
      for (let k = 1; k < line.length; k++) {
        const before = PROP_KEYS.filter((key) => frames(line[k - 1]).some((p) => p[key] > 0.5));
        for (const key of before) expect(frames(line[k]).every((p) => p[key] > 0.5), `${line[k - 1]} -> ${line[k]} keeps ${key}`).toBe(true);
        // and adds something that shows in every frame: a prop, or (W3, N2) a new look: blurred hands, crossed arms
        const looks = (id: ClayStateId, all: boolean) => {
          const f = frames(id);
          const has = (test: (p: Pose) => boolean) => (all ? f.every(test) : f.some(test));
          return [...[...PROP_KEYS, ...FACE_KEYS, ...FEATURES].filter((key) => has((p) => p[key] > 0.5)), ...(has(crossed) ? ['crossedArms'] : [])];
        };
        const prev = looks(line[k - 1], false);
        expect(looks(line[k], true).filter((x) => !prev.includes(x)), `${line[k]} adds something`).not.toEqual([]);
      }
    }
  });

  it('N7 and S7 encase the step before in ice: every N6/S6 prop is still there, frozen', () => {
    for (const [prev, ice] of [['N6', 'N7'], ['S6', 'S7']] as const) {
      const before = PROP_KEYS.filter((key) => frames(prev).some((p) => p[key] > 0.5));
      expect(before.length).toBeGreaterThan(2);
      for (const p of frames(ice)) {
        expect(p.ice, ice).toBe(1);
        expect(p.cold, ice).toBe(1);
        for (const key of before) expect(p[key], `${ice} keeps ${key}`).toBeGreaterThan(0.5);
      }
    }
    expect([...FROZEN].sort()).toEqual(['N7', 'S7']);
  });

  it('the face escalates one way along each timeline: intensity never steps back (§7.2)', () => {
    for (const line of TIMELINES) {
      const v = line.map((id) => FACE_INTENSITY[id]);
      v.forEach((x, i) => expect(typeof x, line[i]).toBe('number'));
      for (let i = 1; i < v.length; i++) expect(v[i]!, `${line[i - 1]} -> ${line[i]}`).toBeGreaterThanOrEqual(v[i - 1]!);
      expect(v[v.length - 1]!, `${line[0][0]} timeline escalates`).toBeGreaterThan(v[0]!);
    }
    expect(TIMELINES.map((line) => line.map((id) => FACE_INTENSITY[id]))).toEqual([
      [0, 1, 2, 3, 4, 5, 6], [0, 1, 2, 3, 4, 5, 5], [0, 1, 2, 3, 4, 5, 5],
    ]);
  });

  it('the face keys follow the intensity: each shows in every frame of its band and in no other state (§7.2)', () => {
    // [timeline, key, from, to]: shown exactly when from <= intensity <= to
    const BANDS: Array<[string, (typeof FACE_KEYS)[number], number, number]> = [
      ['W', 'narrowEyes', 2, 99],
      ['N', 'flatEyes', 2, 2], ['N', 'browsDown', 3, 99], ['N', 'angerPuff', 4, 99], ['N', 'wideEyes', 5, 99],
    ];
    expect(BANDS.map((b) => b[1]).sort()).toEqual([...FACE_KEYS].sort());
    for (const id of CLAY_STATES) for (const [g, key, from, to] of BANDS) {
      const i = FACE_INTENSITY[id];
      const on = id.startsWith(g) && i !== undefined && i >= from && i <= to;
      const f = frames(id);
      if (on) expect(f.every((p) => p[key] > 0.5), `${id} shows ${key}`).toBe(true);
      else expect(f.some((p) => p[key] > 0.01), `${id} must not show ${key}`).toBe(false);
    }
  });

  it('every state shows what the spec names for it, in its still frames (§7.2, §7.4.4–5)', () => {
    const NEED: Partial<Record<ClayStateId, PoseKey[]>> = {
      W1: ['laptop'], W2: ['laptop', 'bits'], W3: ['fastHands', 'narrowEyes'], W4: ['headphones'], W5: ['sweat', 'steam'],
      W6: ['headband', 'narrowEyes'], W7: ['mug', 'blurHands', 'sweatFly', 'steam', 'headband'],
      N1: ['qbubble'], N3: ['watch', 'flatEyes'], N4: ['bell', 'browsDown'], N5: ['bell', 'angerPuff'], N6: ['hourglass', 'sweat', 'wideEyes'], N7: ['ice'],
      S1: ['sparkle'], S2: ['tea', 'stool'], S3: ['zzz', 'stool'], S4: ['bed', 'blanket'], S5: ['snore', 'curl'], S6: ['alarm', 'speech'], S7: ['ice'],
      X1: ['lie', 'grey', 'xEyes'], X3: ['battery'], X4: ['press'],
    };
    for (const [id, keys] of Object.entries(NEED) as Array<[ClayStateId, PoseKey[]]>) {
      for (const k of keys) expect(snap(id).some((p) => p[k] > 0.5), `${id} shows ${k}`).toBe(true);
    }
    expect(frames('N2').every(crossed), 'N2 arms crossed').toBe(true);
    expect(frames('N2').some((p) => p.lRx < -0.3) && frames('N2').some((p) => p.lRx > -0.05), 'N2 taps a foot').toBe(true);
    expect(poseFor('X2', 0, false).gauge, 'X2 gauge').toBe(1);
    expect(POSE_KEYS as readonly string[]).not.toContain('nightcap');
    for (const id of CLAY_STATES) expect(frames(id).some((p) => p.bed > 0.01), `${id} in bed`).toBe(['S4', 'S5', 'S6', 'S7'].includes(id));
    for (const id of ['S2', 'S3'] as const) expect(frames(id).every((p) => p.lie === 0 && Math.abs(p.bodyY) < 0.01), `${id} sits up`).toBe(true);
  });

  it('W1, W2 and W3 differ in every still frame (§7.4.4, round 2)', () => {
    // W1: at the laptop in every frame, and no 0s and 1s yet; mid-loop the hands are together for the knuckle crack
    // (round 2: just above the keys; the character test checks where the hands are)
    frames('W1').forEach((p, i) => {
      expect(p.laptop > 0.5 && p.bits < 0.5, `W1 frame ${i}: laptop, no bits`).toBe(true);
    });
    const mid = frames('W1')[Math.floor(frameCount('W1') / 2)];
    expect(mid.aLz < -1 && mid.aRz < -1, 'W1 frame N/2: hands together, cracking').toBe(true);
    expect(frames('W1')[0].squash > 0.09 && frames('W1')[0].eyeOpen < 0.2, 'W1 frame 0: stretching, tall with eyes shut').toBe(true);
    // W2: calm typing, no sweat, no streaks
    frames('W2').forEach((p, i) => expect([p.sweat, p.steam, p.fastHands, p.narrowEyes], `W2 frame ${i}`).toEqual([0, 0, 0, 0]));
    // W3: fast, blurred hands and narrowed eyes in every frame
    frames('W3').forEach((p, i) => expect(p.fastHands > 0.5 && p.narrowEyes > 0.5, `W3 frame ${i}`).toBe(true));
    // W5's sweat drop is in every frame
    frames('W5').forEach((p, i) => expect(p.sweat, `W5 frame ${i}`).toBeGreaterThan(0.5));
  });

  it('no beard: the mouth is a thin line or a tiny closed shape in every frame of every state, puffed or not (§7.4.3)', () => {
    for (const id of CLAY_STATES) for (const puffed of [false, true]) for (let i = 0; i < frameCount(id); i++) {
      expect(poseFor(id, frameTime(id, i), puffed).mouthOpen, `${id}${puffed ? ' puffed' : ''} frame ${i}`).toBeLessThanOrEqual(0.2);
    }
  });

  it('total baked frames for all 26 states stays under 800 (the memory budget assumes it)', () => {
    const total = CLAY_STATES.reduce((n, id) => n + frameCount(id), 0);
    expect(total).toBe(797); // round 3 gate: W1 is 3.6 s (43 frames), so its arms swing up and down without a jump
    expect(total).toBeLessThan(800);
  });

  it('W1 and S1 have no popping frame: every pose key changes a little per frame, round the loop seam too (rounds 2, 3)', () => {
    // radians for the limbs and the body's turn, nod and lean; body units for squash and position; the face's 0..1
    // keys. Props never switch inside a state. (The pixel checks, clay-frames.test.ts, cover every state.)
    const ANGLE = 0.3, BODY = 0.04, FACE = 0.35;
    const bound = (k: PoseKey) => (/^(a|l)[LR][xz]$/.test(k) || ['lean', 'nod', 'turn'].includes(k) ? ANGLE
      : ['squash', 'bodyY', 'bodyX'].includes(k) ? BODY : FACE);
    const pops = (a: Pose, b: Pose, at: string) =>
      // phases (sparkT, ...) are sawtooth positions that wrap by design
      POSE_KEYS.filter((k) => !k.endsWith('T') && Math.abs(a[k] - b[k]) > bound(k)).map((k) => `${at} ${k} ${a[k].toFixed(2)} -> ${b[k].toFixed(2)}`);
    const bad: string[] = [];
    for (const id of ['W1', 'S1'] as const) {
      const f = frames(id);
      for (let i = 1; i < f.length; i++) bad.push(...pops(f[i - 1], f[i], `${id} frame ${i - 1}->${i}`));
      bad.push(...pops(f[f.length - 1], f[0], `${id} loop seam`));
    }
    expect(bad).toEqual([]);
  });
});
