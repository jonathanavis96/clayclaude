import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { Character, INFLATE, KEYBOARD } from '../web/src/clay/character.js';
import { authoredFor } from '../web/src/clay/overrides.js';
import { CLAY_STATES } from '../web/src/clay/states.js';
import { frameCount, frameTime, poseFor } from '../web/src/clay/timeline.js';
import { FACE_KEYS, NEUTRAL, PROP_KEYS, type Pose, type PoseKey } from '../web/src/clay/pose.js';

describe('clay character (spec §7.4)', () => {
  const ch = new Character();
  const r3 = (n: number) => Math.round(n * 1000) / 1000 + 0; // + 0 turns -0 into 0
  /** The body's box for `id` at frame `i`, with the in-loop motion (bounce, squash, nod, lean, turn) taken out. */
  const box = (id: (typeof CLAY_STATES)[number], i: number, puffed: boolean) => {
    ch.apply({ ...poseFor(id, frameTime(id, i), puffed), squash: 0, bodyY: 0, bodyX: 0, nod: 0, turn: 0, lean: 0 }, '#e07a4f');
    const b = ch.inspect().body;
    return { x: [r3(b.min.x), r3(b.max.x)], y: [r3(b.min.y), r3(b.max.y)], z: [r3(b.min.z), r3(b.max.z)] };
  };
  /** Every baked frame of `id`, posed on the character as the stage poses it. */
  const each = (id: (typeof CLAY_STATES)[number], puffed: boolean, fn: (i: number, p: Pose) => void) => {
    for (let i = 0; i < frameCount(id); i++) {
      const p = poseFor(id, frameTime(id, i), puffed);
      ch.apply(p, '#e07a4f', authoredFor(id)); // as the stage renders it: authored prop and glyph overrides included
      fn(i, p);
    }
  };

  it('one body bounding box for every state and frame; X2 (and the X2 modifier) alone is the same body uniformly inflated (§7.4.1, round 2)', () => {
    const ref = box('W2', 0, false);
    expect(ref.x[1] - ref.x[0]).toBeCloseTo(1, 3);
    const size = (r: [number, number]) => r[1] - r[0];
    for (const id of CLAY_STATES) {
      if (id === 'X1') continue; // stopped: lying flat on its side (spec §7.2)
      for (let i = 0; i < frameCount(id); i++) {
        for (const puffed of [false, true]) {
          const b = box(id, i, puffed);
          const at = `${id} frame ${i}${puffed ? ' puffed' : ''}`;
          if (!puffed && id !== 'X2') { expect([b.x, b.y, b.z], at).toEqual([ref.x, ref.y, ref.z]); continue; }
          // inflated: every axis scaled alike, within 2 % (the same shape, not deformed), standing where it stood
          const scale = [size(b.x) / size(ref.x), size(b.y) / size(ref.y), size(b.z) / size(ref.z)];
          for (const s of scale) expect(Math.abs(s / scale[0] - 1), `${at}: uniform`).toBeLessThanOrEqual(0.02);
          expect(scale[0], `${at}: 10–15 % bigger`).toBeGreaterThanOrEqual(1.1);
          expect(scale[0], `${at}: 10–15 % bigger`).toBeLessThanOrEqual(1.15);
          expect(b.y[0] + b.y[1], `${at}: inflated about its middle, where it stood`).toBeCloseTo(ref.y[0] + ref.y[1], 3);
          expect(b.x[0] + b.x[1], `${at}: centred`).toBeCloseTo(0, 3);
        }
      }
    }
    expect(INFLATE).toBeGreaterThanOrEqual(1.1);
  });

  it('nothing on the character receives a shadow, so no dark patch falls under the face or the arms (§7.4.3)', () => {
    for (const id of CLAY_STATES) {
      ch.apply(poseFor(id, 0, false), '#e07a4f');
      expect(ch.inspect().shadowed, id).toEqual([]);
    }
  });

  it('one small mouth and nothing dark below it, in every state and frame, puffed or not (§7.4.3, review round 2)', () => {
    for (const id of CLAY_STATES) {
      for (const puffed of [false, true]) {
        each(id, puffed, (i) => {
          const { face } = ch.inspect();
          const at = `${id} frame ${i}${puffed ? ' puffed' : ''}`;
          expect(face.mouths, `${at}: mouth shapes`).toBeLessThanOrEqual(1);
          expect(face.mouthWidth, `${at}: mouth width`).toBeLessThanOrEqual(0.26);
          expect(face.belowMouth, `${at}: dark meshes below the mouth`).toEqual([]);
          // a thin curved line, or a tiny closed shape: never a dark "o" (the goatee of the first gallery)
          if (face.mouthKind === 'o') {
            expect(face.mouthWidth, `${at}: tiny closed mouth`).toBeLessThanOrEqual(0.12);
            expect(face.mouthHeight, `${at}: tiny closed mouth`).toBeLessThanOrEqual(0.08);
          } else expect(face.lineThickness, `${at}: thin mouth line`).toBeLessThanOrEqual(0.05);
        });
      }
    }
  });

  /** The hands apart on the keys, tapping (W2 on). */
  const typing = (p: Pose) => p.laptop > 0.5 && p.aLz < 0 && p.aRz < 0 && p.aLz > -0.9 && p.aRz > -0.9 && p.aLx < -0.6 && p.aRx < -0.6;
  /** Inside the keyboard's area seen from above, and from the keys up to `above`. */
  const onKeys = (h: Vector3, above: number) => h.x >= KEYBOARD.x[0] && h.x <= KEYBOARD.x[1] && h.z >= KEYBOARD.z[0] && h.z <= KEYBOARD.z[1]
    && h.y >= KEYBOARD.y && h.y <= KEYBOARD.y + above;

  it('in every W2-W7 frame both hands are on the laptop keys; W1\'s knuckle crack is just above them (round 2)', () => {
    // W1's stretch lifts the hands over the head (round 3 gate: a stretch with the hands on the keys read as typing with
    // the eyes shut); its crack frames are checked just above the keys in the W1 test below.
    for (const id of ['W2', 'W3', 'W4', 'W5', 'W6', 'W7'] as const) {
      each(id, false, (i) => {
        const { hands, props } = ch.inspect();
        hands.forEach((h, s) => expect(onKeys(h, 0.2), `${id} frame ${i} ${s ? 'right' : 'left'} hand on the keys: ${h.toArray().map((v) => v.toFixed(2))}`).toBe(true));
        expect(props.laptop, `${id} frame ${i} laptop`).toBeDefined();
      });
    }
  });

  it('W1, W2 and W3 differ in every still frame (§7.4.4, review rounds 2 and 3)', () => {
    // W1: a warm-up at the laptop with no sleeves (round 3). Frame 0 is the stretch: drawn up tall, eyes shut, both hands
    // up above the head (round 3 gate). While it cracks its knuckles (0.34-0.62, frame N/2 included) the hands are
    // together just above the keys, not typing.
    const n1 = frameCount('W1');
    each('W1', false, (i, p) => {
      const { shown, hands, body } = ch.inspect();
      expect(shown, `W1 frame ${i} no sleeves`).not.toContain('sleeves');
      expect(shown, `W1 frame ${i} no bits yet`).not.toContain('bits');
      const t = frameTime('W1', i);
      if (t <= 0.08 || t >= 0.88) {
        expect(p.squash >= 0.09 && p.eyeOpen < 0.2, `W1 frame ${i}: stretching, tall with eyes shut`).toBe(true);
        for (const hand of hands) expect(hand.y, `W1 frame ${i}: hands up over the head`).toBeGreaterThan(body.max.y);
        expect(typing(p), `W1 frame ${i} typing`).toBe(false);
      }
      if (t < 0.34 || t > 0.62) return;
      expect(typing(p), `W1 frame ${i} typing`).toBe(false);
      expect(hands[0].distanceTo(hands[1]), `W1 frame ${i} hands together`).toBeLessThan(0.3);
      for (const hand of hands) expect(onKeys(hand, 0.2) && hand.y > KEYBOARD.y + 0.12, `W1 frame ${i} hands just above the keys`).toBe(true);
    });
    expect(n1).toBeGreaterThan(20);
    // W2: calm typing, no sweat, no motion streaks, no sleeves (W1's pose cue only: no armbands, §7.4.4)
    each('W2', false, (i, p) => {
      const { shown } = ch.inspect();
      expect(typing(p), `W2 frame ${i} typing`).toBe(true);
      expect(shown.filter((s) => s === 'sweat' || s === 'steam' || s === 'fastHands' || s === 'narrowEyes' || s === 'sleeves'), `W2 frame ${i}`).toEqual([]);
    });
    // W3: narrowed eyes and fast, blurred (ghosted) hands in every frame (spec §7.2 v2: the sweat drop is W5's)
    each('W3', false, (i, p) => {
      const { shown } = ch.inspect();
      expect(typing(p), `W3 frame ${i} typing`).toBe(true);
      expect(shown, `W3 frame ${i}`).toEqual(expect.arrayContaining(['fastHands', 'narrowEyes']));
    });
    // W5: the sweat drop shows in every frame
    each('W5', false, (i) => expect(ch.inspect().shown, `W5 frame ${i}`).toContain('sweat'));
  });

  /** Every key the character has geometry for: the accumulating props, the face keys and the looks that read in a still. */
  const DRAWN = [...PROP_KEYS, ...FACE_KEYS, 'fastHands', 'blurHands', 'sleeves', 'sparkle'] as const satisfies readonly PoseKey[];

  it('has geometry for every prop and face key, and nothing else (no nightcap)', () => {
    expect(ch.inspect().parts).toEqual([...new Set(DRAWN)].sort());
    ch.apply(NEUTRAL, '#e07a4f');
    expect(ch.inspect().shown, 'neutral pose').toEqual([]);
    for (const k of DRAWN) {
      ch.apply({ ...NEUTRAL, [k]: 1 }, '#e07a4f');
      expect(ch.inspect().shown, k).toEqual([k]);
    }
  });

  it('draws exactly what each frame of each state turns on, puffed or not (props accumulate on screen, spec §7.2)', () => {
    for (const id of CLAY_STATES) {
      for (const puffed of [false, true]) {
        each(id, puffed, (i, p) => {
          const { shown } = ch.inspect();
          const at = `${id} frame ${i}${puffed ? ' puffed' : ''}`;
          for (const k of DRAWN) {
            if (p[k] > 0.5) expect(shown, `${at} shows ${k}`).toContain(k);
            if (p[k] <= 0.01) expect(shown, `${at} hides ${k}`).not.toContain(k);
          }
        });
      }
    }
  });

  it('a prop the pose cannot hold is put down beside the character, still visible (tea from S3, stool from S4); N4-N7 hold a hand bell', () => {
    const at = (pose: Partial<Pose>) => {
      ch.apply({ ...NEUTRAL, ...pose }, '#e07a4f');
      return ch.inspect();
    };
    const cup = at({ tea: 1, teaDown: 1 });
    expect(cup.props.tea.min.y, 'tea cup on the floor').toBeLessThan(0.03);
    expect(cup.props.tea.max.y, 'tea cup low, nowhere near the face').toBeLessThan(cup.body.min.y + 0.25);
    // gallery review note A: a hand bell (no glyph on it) replaces the "?" sign; N4 rings it gently, N5 and N6 jump
    // and bob ringing it, N7 is frozen holding it: in the right hand, off the floor, below the eyes, inside the square
    for (const id of ['N4', 'N5', 'N6', 'N7'] as const) {
      const swings: number[] = [];
      each(id, false, (i, p) => {
        const { props, hands, eyes, glyphs, marks } = ch.inspect();
        expect(props.bell, `${id} frame ${i} shows the bell`).toBeDefined();
        expect(props.bell.min.y, `${id} frame ${i} bell held up off the floor`).toBeGreaterThan(0.05);
        expect(props.bell.containsPoint(hands[1]) || props.bell.distanceToPoint(hands[1]) < 0.08, `${id} frame ${i} bell in the right hand`).toBe(true);
        // the brass bell clear of the eyes: no bead (radius 0.05) inside its box, seen from the front
        const bb = marks.bellBody[0];
        for (const e of eyes) {
          const inside = e.at.x > bb.min.x - 0.05 && e.at.x < bb.max.x + 0.05 && e.at.y > bb.min.y - 0.05 && e.at.y < bb.max.y + 0.05;
          expect(inside, `${id} frame ${i} bell clear of the eyes`).toBe(false);
        }
        expect(props.bell.max.x, `${id} frame ${i} bell inside the square`).toBeLessThan(1.2);
        expect(glyphs.q?.length ?? 0, `${id} frame ${i}: one "?" (the bubble's)`).toBe(1);
        swings.push(p.bellSwing);
      });
      if (id !== 'N7') expect(Math.max(...swings) - Math.min(...swings), `${id}: the bell swings (rings)`).toBeGreaterThan(0.15);
    }
    ch.apply(poseFor('S3', 0, false), '#e07a4f');
    expect(ch.inspect().props.tea.min.y, 'S3 tea down on the floor').toBeLessThan(0.03);
    // S2 and S3 sit on the stool; from S4 (in bed) it stands beside the bed with the tea cup on it
    for (const id of ['S2', 'S3'] as const) {
      ch.apply(poseFor(id, 0, false), '#e07a4f');
      const { props, body } = ch.inspect();
      expect(props.stool.max.y, `${id} sits on the stool: its seat is at hip height, under the body`).toBeCloseTo(0.24, 2);
      expect(props.stool.getCenter(new Vector3()).x, `${id} stool centred under the body`).toBeCloseTo((body.min.x + body.max.x) / 2, 0);
      expect(props.stool.max.x - props.stool.min.x, `${id} stool under the body`).toBeGreaterThan(0.6);
    }
    for (const id of ['S4', 'S5', 'S6', 'S7'] as const) {
      ch.apply(poseFor(id, 0, false), '#e07a4f');
      const { props } = ch.inspect();
      expect(props.stool.min.y, `${id} stool on the floor`).toBeLessThan(0.03);
      expect(props.stool.getCenter(new Vector3()).x, `${id} stool by the bed's front left corner`).toBeLessThan(-0.5); // the body is 1 wide
      expect(Math.abs(props.tea.min.y - props.stool.max.y), `${id} tea on the stool`).toBeLessThan(0.03);
      expect(props.tea.max.y, `${id} tea low, nowhere near the face`).toBeLessThan(0.24 + 0.25); // hip height + 0.25
    }
  });

  it('N6 and N7: the hourglass stands on the floor clear of the watch; nobody knocks on the glass any more (round 3)', () => {
    for (const id of ['N6', 'N7'] as const) {
      each(id, false, (i) => {
        const { props, shown } = ch.inspect();
        expect(shown, `${id} frame ${i}`).toEqual(expect.arrayContaining(['bell', 'watch', 'hourglass']));
        expect(shown, `${id} frame ${i}`).not.toContain('knock');
        expect(props.hourglass.min.y, `${id} frame ${i} hourglass on the floor`).toBeLessThan(0.03);
        expect(props.hourglass.intersectsBox(props.watch), `${id} frame ${i} watch clear of the hourglass`).toBe(false);
        if (id === 'N7') expect(props.ice.containsBox(props.bell), `N7 frame ${i} bell frozen in the ice`).toBe(true);
      });
    }
  });

  it('S5 is curled up under the blanket, pulled up over the mouth to just under the closed eyes, a snore bubble at the sheet edge (round 2)', () => {
    ch.apply(poseFor('S4', 0, false), '#e07a4f');
    const s4 = ch.inspect();
    expect(s4.props.blanket.max.y, 'S4: the face is above the blanket').toBeLessThan(s4.mouth.y - 0.05);
    each('S5', false, (i) => {
      const { props, marks, mouth, eyes, body } = ch.inspect();
      const edge = marks.sheetEdge[0];
      expect(edge.max.y, `S5 frame ${i}: the sheet edge over the mouth`).toBeGreaterThan(mouth.y);
      for (const e of eyes) expect(e.at.y, `S5 frame ${i}: the eyes show above the sheet edge`).toBeGreaterThan(edge.max.y + 0.02);
      expect(props.blanket.max.y, `S5 frame ${i}: the top of the head shows`).toBeLessThan(body.max.y - 0.2);
      // the snore bubble swells from the sheet edge in front of the face, below the eyes
      expect(props.snore.min.y, `S5 frame ${i}: snore bubble at the sheet edge`).toBeLessThan(edge.max.y);
      expect(props.snore.max.y, `S5 frame ${i}: snore bubble below the eyes`).toBeLessThan(Math.max(...eyes.map((e) => e.at.y)));
      expect(props.snore.max.z, `S5 frame ${i}: snore bubble in front of the face`).toBeGreaterThan(body.max.z);
    });
  });

  it('frozen, the Zzz stays inside the ice block with the character (S7, review of Task 4)', () => {
    each('S7', false, (i) => {
      const { props } = ch.inspect();
      expect(props.zzz, `S7 frame ${i} shows the Zzz`).toBeDefined();
      expect(props.zzz.max.y, `S7 frame ${i}: Zzz top inside the ice`).toBeLessThanOrEqual(props.ice.max.y - 0.02);
      expect(props.zzz.max.x, `S7 frame ${i}: Zzz right side inside the ice`).toBeLessThanOrEqual(props.ice.max.x - 0.02);
    });
  });

  it('W7\'s coffee mug stands on the desk beside the laptop in every frame (round 2: both hands stay on the keys)', () => {
    each('W7', false, (i) => {
      const { props } = ch.inspect();
      expect(props.mug.min.y, `W7 frame ${i}: mug on the desk`).toBeCloseTo(props.laptop.min.y + 0.3, 2); // the desk top
      expect(props.mug.min.x, `W7 frame ${i}: mug beside the laptop's keys`).toBeGreaterThan(KEYBOARD.x[1]);
      expect(props.mug.max.x, `W7 frame ${i}: mug on the desk`).toBeLessThan(props.laptop.max.x);
    });
  });

  it('the tea cup (S2) reaches the mouth mid-loop', () => {
    for (const [id, key] of [['S2', 'tea']] as const) {
      let best = Infinity;
      each(id, false, () => {
        const { props, mouth } = ch.inspect();
        const c = props[key].getCenter(new Vector3());
        best = Math.min(best, c.distanceTo(mouth));
      });
      expect(best, `${id} ${key} reaches the mouth`).toBeLessThan(0.45);
    }
  });

  it('the same bead eyes in every state and frame: never eye whites or sclera rings, the bead never shrinks (round 2)', () => {
    for (const id of CLAY_STATES) for (const puffed of [false, true]) {
      each(id, puffed, (i) => {
        const { eyes, nearEyes } = ch.inspect();
        const at = `${id} frame ${i}${puffed ? ' puffed' : ''}`;
        expect(nearEyes, `${at}: light meshes round the eyes`).toEqual([]);
        for (const e of eyes) expect(e.bead, `${at}: bead width`).toBe(1);
      });
    }
  });

  it('the "?" is centred in its bubble, in every N frame (round 2; the bubble is the only "?" since note A)', () => {
    for (const id of ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7'] as const) {
      for (let i = 0; i < frameCount(id); i++) {
        // measured in the prop's own plane: the body's tilt taken out (it moves the "?" and its back together)
        ch.apply({ ...poseFor(id, frameTime(id, i), false), nod: 0, lean: 0, turn: 0 }, '#e07a4f', authoredFor(id));
        const { glyphs, marks } = ch.inspect();
        const backs = marks.bubble ?? [];
        expect(glyphs.q?.length, `${id} frame ${i}: a "?" for the bubble`).toBe(backs.length);
        for (const q of glyphs.q!) {
          const c = q.getCenter(new Vector3());
          const back = backs.map((b) => b.getCenter(new Vector3())).sort((a, b) => a.distanceTo(c) - b.distanceTo(c))[0];
          expect(Math.abs(c.x - back.x), `${id} frame ${i}: "?" centred across`).toBeLessThan(0.02);
          expect(Math.abs(c.y - back.y), `${id} frame ${i}: "?" centred up and down`).toBeLessThan(0.02);
        }
      }
    }
  });

  it('N3 reads its watch on a wrist held in front of the body at chest height, never a raised arm (round 2)', () => {
    ch.apply(poseFor('N3', 0, false), '#e07a4f');
    const { props, body, mouth } = ch.inspect();
    const w = props.watch.getCenter(new Vector3());
    expect(w.z, 'in front of the face').toBeGreaterThan(mouth.z);
    expect(w.x, 'within the body\'s width').toBeGreaterThan(body.min.x);
    expect(w.x).toBeLessThan(body.max.x);
    // round 3, gate 2: held up where it can be read, beside the mouth, not low at the hip (round 2's watch sat 85 % of
    // the way down the body, near the legs) and clear of the eyes; its forearm comes in from the shoulder above it
    const eyeY = Math.min(...ch.inspect().eyes.map((e) => e.at.y));
    expect(w.y, 'chest height: at the mouth\'s height, not low at the hip').toBeGreaterThan(mouth.y - 0.03);
    expect(w.y, 'chest height: below the eyes, clear of them').toBeLessThan(eyeY - 0.1);
    each('N3', false, (i) => {
      const { hands, body: b } = ch.inspect();
      for (const h of hands) expect(h.y, `N3 frame ${i}: no hand raised above the chest`).toBeLessThan(b.min.y + 0.5 * (b.max.y - b.min.y));
    });
  });

  it('no check mark in any state (gallery review note C): S1 sparkles, and no S state after it carries the sparkle', () => {
    for (const id of CLAY_STATES) {
      each(id, false, (i) => {
        const { glyphParts, shown } = ch.inspect();
        expect(glyphParts as string[], `${id} frame ${i}: no check mark`).not.toContain('check');
        if (id === 'S1') expect(shown, `S1 frame ${i}`).toContain('sparkle');
        else expect(shown, `${id} frame ${i}`).not.toContain('sparkle');
      });
    }
  });

  it('S7: every S6 prop is frozen inside the ice block with the character (round 2)', () => {
    each('S7', false, (i) => {
      const { props, body } = ch.inspect();
      const ice = props.ice.clone().expandByScalar(0.02);
      for (const k of ['bed', 'blanket', 'stool', 'tea', 'alarm', 'speech', 'snore', 'zzz'] as const) {
        expect(props[k], `S7 frame ${i} shows ${k}`).toBeDefined();
        expect(ice.containsBox(props[k]), `S7 frame ${i}: ${k} inside the ice`).toBe(true);
      }
      expect(ice.containsBox(body), `S7 frame ${i}: the body inside the ice`).toBe(true);
    });
  });

  it('X3 is a nearly empty battery: a cap on the head, the whole character filled from the feet up, legs and the bottom of the body, blinking slowly; no fuel can (round 3)', () => {
    const levels: number[] = [];
    each('X3', false, (i, p) => {
      ch.apply({ ...p, nod: 0, lean: 0 }, '#e07a4f'); // upright, so the body's box top is the top of the head
      const { props, body, charge } = ch.inspect();
      expect(props.battery.min.y, `X3 frame ${i}: cap on top of the head`).toBeGreaterThan(body.max.y - 0.05);
      expect(charge, `X3 frame ${i}: charge shown`).toBeDefined();
      // the legs (hips down) are below the fill line and so is the bottom of the body, but not its middle: it reads as
      // low (the pixel test, clay-battery.test.ts, measures the band on screen: 35-40 % of the character's height)
      expect(charge!.level, `X3 frame ${i}: legs filled, then the bottom of the body`).toBeGreaterThan(body.min.y + 0.03);
      expect(charge!.level, `X3 frame ${i}: only the bottom of the body`).toBeLessThan(body.min.y + 0.5 * (body.max.y - body.min.y));
      expect(charge!.feet).toBeLessThanOrEqual(0);
      levels.push(p.chargeT);
    });
    ch.apply(poseFor('W2', 0, false), '#e07a4f');
    expect(ch.inspect().charge, 'no charge outside X3').toBeUndefined();
    expect(Math.max(...levels) - Math.min(...levels), 'one slow blink per loop').toBeGreaterThan(0.9);
    expect(ch.inspect().parts).not.toContain('fuel');
  });
});
