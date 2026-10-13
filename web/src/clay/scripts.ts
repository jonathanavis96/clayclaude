import type { Channel, PoseKey, Script } from './pose.js';
import type { ClayStateId } from './states.js';

type Chans = Partial<Record<PoseKey, Channel>>;
/** Every state loops (round 3: there are no "plays once" states); a still state is one frame. */
export interface StateScript extends Script { still?: true }

const loop = (loopMs: number, fps: 12 | 24, channels: Chans): StateScript => ({ loopMs, fps, channels });

/**
 * One blink per loop centred at `at` (0..1), closing and opening over 170 ms each way, so at 12 fps it passes through
 * a half-shut frame each way and never snaps shut for a single frame (round 3: nothing pops).
 */
const blink = (at: number, loopMs: number, open = 1): Channel => {
  const w = 170 / loopMs;
  return { keys: [[0, open], [at - w, open], [at, 0.08], [at + w, open], [1, open]] };
};

/**
 * Typing on the laptop: both hands on the keys in every frame (round 2), arms reaching in and forward over the desk,
 * hands tapping in anti-phase. `cycles` taps per loop. TYPE_X/TYPE_Z put the hands on the keyboard (character.ts
 * KEYBOARD) at the W nod.
 */
const TYPE_X = -1.545, TYPE_Z = -0.5, W_NOD = 0.18;
/** Reaching down to the keys (`reach`), a swing of the arm moves the hand further up and down: taps scaled to keep it on the keys. */
const TYPE_AMP = 0.8;
/** W1's stretch: both arms swung forward and up over the head (aLx), opened out into a V (aLz). */
const W1_UP = -2.85, W1_OUT = 0.55;
const typing = (cycles: number, amp: number): Chans => ({
  aLx: { base: TYPE_X, sin: [[cycles, TYPE_AMP * amp, 0]] },
  aRx: { base: TYPE_X, sin: [[cycles, TYPE_AMP * amp, 0.5]] },
  aLz: { base: TYPE_Z },
  aRz: { base: TYPE_Z },
  reach: { base: 1 },
  laptop: { base: 1 },
  bits: { base: 1 },
  lookY: { base: -0.5 },
});

/** Fast, blurred hands (motion streaks or ghosted hands) and narrowed eyes: W3's look (spec §7.4.4). */
const ZONE: Chans = { fastHands: { base: 1 }, narrowEyes: { base: 1 } };
const W4_ADDS: Chans = { headphones: { base: 1 } };
const W5_ADDS: Chans = { sweat: { base: 1 }, sweatT: { saw: [1, 0.4] }, steam: { base: 1 }, steamT: { saw: [1] } }; // sweatT offset: frame 0 shows the drop
const W6_ADDS: Chans = { headband: { base: 1 } };

/** The "?" bubble of N1: every needs-you state keeps it (spec §7.4.2), frozen inside N7's ice. */
const QBUBBLE: Chans = { qbubble: { base: 0.9, sin: [[2, 0.1]] } };
const N_WATCH: Chans = { watch: { base: 1 } };
/** N4 on: a hand bell in the right hand (gallery review note A: it replaces round 3's "?" sign, so the "?" bubble is
 * the only "?"): N4 rings it gently, N5 and N6 jump and bob ringing it, N7 is frozen holding it. */
const N_BELL: Chans = { bell: { base: 1 } };
/** The bell arm angled in a little (aRz), so the bell and its ringing arcs stay inside the square. */
const BELL_OUT = -0.16;
/**
 * Jumping and bobbing with the bell held up, ringing it: N5's motion (approved in the round-3 review with the sign, N4's
 * until then), exactly as it was at k = 1. N6 is the same motion at k > 1: k more hops and swings a loop, k times as high.
 */
const N_JUMP = (k: number): Chans => ({
  bodyY: { base: 0.05 * k, sin: [[Math.round(2 * k), -0.05 * k, 0.25]] }, // a low stamp: the bubble stays in the square
  squash: { sin: [[Math.round(2 * k), -0.07 * k, 0.25]] },
  aRx: { base: -1.1 }, aRz: { base: BELL_OUT - 0.12 * (k - 1) }, aLz: { base: 0.3 }, // N6's bigger rocks: less out, in frame
  bellSwing: { sin: [[Math.round(k), 0.3 * k, 0.25]] }, // rings: swung one way at frame 0, the other mid-loop
  bellRing: { base: 0.8, sin: [[Math.round(2 * k), 0.15, 0.25]] }, // ringing all the time, pulsing with each hop
});
/** N6's jumping is N5's this much bigger and faster (whole cycles: 3 hops and 1.5 rocks would not close, so 3 and 2). */
const N6_JUMP = 1.5;
const ANGRY: Chans = { browsDown: { base: 1 }, angerPuff: { base: 1 } };

/** S1's sparkle: stars twinkling by its head (no check mark since gallery review note C; S1 only, not carried on). */
const SPARKLE: Chans = { sparkle: { base: 1 }, sparkT: { saw: [1] } };
/** From S3 on the tea cup is set down beside the character (the bedside from S4), still visible. */
const TEA_DOWN: Chans = { tea: { base: 1 }, teaDown: { base: 1 } };
/** S2 and S3 sit on a low stool, legs forward; from S4 it stands beside the bed with the tea cup on it. */
const STOOL: Chans = { stool: { base: 1 } };
const SEATED: Chans = { lLx: { base: -1.1 }, lRx: { base: -1.1 } };
/** In bed (S4 on): mattress, headboard, pillow and blanket. */
const BED: Chans = { bed: { base: 1 }, blanket: { base: 1 } };

const IDLE: Chans = { aLz: { base: 0.15 }, aRz: { base: 0.15 } };

/**
 * Face intensity along each timeline (spec §7.2: the face escalates one way only).
 * W: fresh 0, calm 1, narrowed 2, locked in 3, straining 4, intense focus 5, max power 6 (never tired: no bags, no droop).
 * N: polite 0, patient 1, bored 2 (flat eyes), annoyed 3 (brows down), frustrated 4 (anger puff), panicking 5 (wide eyes);
 *    N7 freezes N6's face in the ice.
 * S: just finished 0, content 1, drowsy 2, asleep 3, deep sleep 4, stirring 5; S7 freezes S6's face in the ice.
 * The face keys follow it: narrowEyes 2+ (W); flatEyes 2, browsDown 3+, angerPuff 4+, wideEyes 5+ (N).
 */
export const FACE_INTENSITY: Readonly<Partial<Record<ClayStateId, number>>> = {
  W1: 0, W2: 1, W3: 2, W4: 3, W5: 4, W6: 5, W7: 6,
  N1: 0, N2: 1, N3: 2, N4: 3, N5: 4, N6: 5, N7: 5,
  S1: 0, S2: 1, S3: 2, S4: 3, S5: 4, S6: 5, S7: 5,
};

/** N6's panicking face and pose, kept as-is (and frozen) by N7. */
const N6_FACE: Chans = {
  ...ANGRY,
  wideEyes: { base: 1 },
  eyeOpen: { base: 1 },
  mouthCurve: { base: -0.4 },
};
/** N6 on: the nearly empty hourglass stands on the floor at its left, clear of the watch (only the sand trickle loops). */
const N6_PROPS: Chans = { ...QBUBBLE, ...N_WATCH, ...N_BELL, ...ANGRY, hourglass: { base: 1 }, sandLevel: { base: 0.06 }, sweat: { base: 1 } };

/** S6's stirring face (eyes shut tight, bothered brows, a grumble), kept (frozen, asleep) by S7. */
const S6_FACE: Chans = { brow: { base: -0.6 }, mouthCurve: { base: -0.2 }, mouthOpen: { base: 0.12 } };
const S6_PROPS: Chans = { ...TEA_DOWN, ...STOOL, ...BED, zzz: { base: 1 }, zzzBig: { base: 1 }, snore: { base: 1 }, alarm: { base: 1 }, speech: { base: 1 } };

/**
 * Every state's script (spec §7.2, approved character list). Timings and props are data; the character code
 * only reads poses. Along each timeline props accumulate (each step keeps the previous step's props and adds
 * one or a few) and the face escalates one way (FACE_INTENSITY). The mouth is a thin line or a tiny closed
 * shape everywhere (mouthOpen <= 0.2, spec §7.4.3).
 */
export const SCRIPTS: Readonly<Record<ClayStateId, StateScript>> = {
  // Working (blue): fresh -> focused -> working harder -> max power (never tired)
  // W1: a warm-up loop (round 3): stretch, crack the knuckles, stretch, crack the knuckles; never typing, no sleeves.
  // The stretch (frame 0): both arms reach up over the head in a wide V, the body drawn up tall, eyes squeezed shut, a big
  // smile, swaying one way coming up and the other going down. The crack (frame N/2): the hands together just above the
  // keys, two slow cracks, each a small jolt of the body. Round 3 gate: a stretch with the hands on the keys read as
  // typing with the eyes shut, so the stretch lifts the hands off the keys; they are back over the keys for the crack.
  // The arms swing up and down in front of the body over ~11 frames each way (no limb moves 0.3 rad in a frame).
  W1: loop(3600, 12, {
    laptop: { base: 1 },
    aLx: { keys: [[0, W1_UP], [0.08, W1_UP], [0.34, -0.9], [0.62, -0.9], [0.88, W1_UP], [1, W1_UP]] },
    aRx: { keys: [[0, W1_UP], [0.08, W1_UP], [0.34, -0.9], [0.62, -0.9], [0.88, W1_UP], [1, W1_UP]] },
    aLz: { keys: [[0, W1_OUT], [0.08, W1_OUT], [0.34, -1.22], [0.41, -1.08], [0.48, -1.22], [0.55, -1.08], [0.62, -1.22], [0.88, W1_OUT], [1, W1_OUT]] },
    aRz: { keys: [[0, W1_OUT], [0.08, W1_OUT], [0.34, -1.22], [0.41, -1.08], [0.48, -1.22], [0.55, -1.08], [0.62, -1.22], [0.88, W1_OUT], [1, W1_OUT]] },
    squash: { keys: [[0, 0.1], [0.08, 0.1], [0.28, 0], [0.34, 0], [0.41, 0.025], [0.48, 0], [0.55, 0.025], [0.62, 0], [0.82, 0.1], [1, 0.1]] },
    lean: { keys: [[0, 0], [0.04, 0.06], [0.12, 0], [0.84, 0], [0.93, -0.06], [1, 0]] },
    nod: { keys: [[0, -0.04], [0.08, -0.04], [0.3, 0.1], [0.64, 0.1], [0.86, -0.04], [1, -0.04]] },
    lookY: { keys: [[0, 0.1], [0.08, 0.1], [0.3, -0.3], [0.64, -0.3], [0.86, 0.1], [1, 0.1]] },
    eyeOpen: { keys: [[0, 0.12], [0.1, 0.12], [0.24, 1], [0.74, 1], [0.88, 0.12], [1, 0.12]] },
    mouthCurve: { keys: [[0, 0.85], [0.1, 0.85], [0.28, 0.6], [0.66, 0.6], [0.86, 0.85], [1, 0.85]] },
    brow: { keys: [[0, 0], [0.1, 0], [0.28, 0.4], [0.66, 0.4], [0.84, 0], [1, 0]] },
  }),
  // W2: calm, steady typing; no sweat, no streaks
  W2: loop(2000, 24, {
    ...typing(4, 0.1),
    nod: { base: W_NOD, sin: [[2, 0.02]] },
    squash: { sin: [[2, 0.02]] },
    eyeOpen: blink(0.62, 2000),
    mouthCurve: { base: 0.3 },
    bitsT: { saw: [3] }, // an odd count: mid-loop the 0s and 1s are on the other side of the head
  }),
  // W3: in the zone: faster, blurred hands, narrowed eyes
  W3: loop(1400, 24, {
    ...typing(6, 0.13), ...ZONE,
    nod: { base: W_NOD, sin: [[3, 0.02]] },
    squash: { sin: [[3, 0.03]] },
    mouthCurve: { base: 0.1 },
    brow: { base: 0.4 },
    bitsT: { saw: [3] }, // an odd count: mid-loop is not frame 0
  }),
  // W4: locked in: headphones on, nodding to the music
  W4: loop(1200, 24, {
    ...typing(6, 0.14), ...ZONE, ...W4_ADDS,
    nod: { base: W_NOD, sin: [[2, 0.03]] },
    lean: { sin: [[1, 0.03]] },
    squash: { sin: [[3, 0.04]] },
    brow: { base: 0.6 },
    mouthCurve: { base: 0.05 },
    bitsT: { saw: [3] }, // an odd count: mid-loop is not frame 0
  }),
  // W5: working harder: sweat drop and steam, straining
  W5: loop(1200, 24, {
    ...typing(6, 0.15), ...ZONE, ...W4_ADDS, ...W5_ADDS,
    nod: { base: W_NOD, sin: [[4, 0.022]] },
    lean: { sin: [[2, 0.03]] },
    squash: { sin: [[4, 0.035, 0.25]] },
    brow: { base: 0.7 },
    mouthCurve: { base: -0.1 },
    mouthOpen: { base: 0.1 },
    bitsT: { saw: [3] }, // an odd count: mid-loop is not frame 0
  }),
  // W6: intense focus: headband, fast typing, determined brows pressed down on the eyes
  W6: loop(1000, 24, {
    ...typing(6, 0.16), ...ZONE, ...W4_ADDS, ...W5_ADDS, ...W6_ADDS,
    sweatT: { saw: [1, 0.4] },
    nod: { base: W_NOD, sin: [[2, 0.025]] },
    lean: { sin: [[2, 0.02]] },
    squash: { sin: [[4, 0.046]] },
    brow: { base: 0.9 },
    mouthCurve: { base: -0.05 },
    bitsT: { saw: [2] },
  }),
  // W7: max power: blurred fast hands, sweat flying, steam, a coffee mug standing beside the laptop
  W7: loop(1000, 24, {
    ...typing(6, 0.16), ...ZONE, ...W4_ADDS, ...W5_ADDS, ...W6_ADDS,
    blurHands: { base: 1 },
    sweatFly: { base: 1 }, sweatT: { saw: [2, 0.25] }, steamT: { saw: [2] }, // a drop in flight on each side in every still
    mug: { base: 1 },
    nod: { base: W_NOD, sin: [[3, 0.03]] },
    squash: { sin: [[6, 0.028]] },
    lean: { sin: [[2, 0.035]] },
    brow: { base: 1 },
    mouthCurve: { base: 0.25 },
    bitsT: { saw: [3] }, // an odd count: mid-loop is not frame 0
  }),

  // Needs you (amber): polite -> patient -> bored -> annoyed -> frustrated -> panicking -> frozen
  // N1: turns to face you, small wave, "?" bubble
  N1: loop(2200, 12, {
    ...QBUBBLE,
    turn: { sin: [[1, 0.15]] },
    aRz: { base: 2.5, sin: [[3, 0.3]] },
    aLz: { base: 0.15 },
    squash: { sin: [[3, 0.015]] },
    eyeOpen: blink(0.8, 2200),
    mouthCurve: { base: 0.7 },
    lean: { sin: [[1, 0.04, 0.25]] },
  }),
  // N2: arms crossed, gentle foot tap
  N2: loop(1200, 24, {
    ...QBUBBLE,
    aLx: { base: -0.55 }, aRx: { base: -0.55 },
    aLz: { base: -1.3 }, aRz: { base: -1.3 },
    // starts with the foot down; mid-loop it is lifted, forward and out to the side, so it shows from the front
    lRx: { base: -0.4, sin: [[3, 0.4, 0.25]] },
    lRz: { base: 0.3, sin: [[3, -0.3, 0.25]] },
    squash: { sin: [[2, 0.015]] },
    eyeOpen: blink(0.7, 1200),
    mouthCurve: { base: 0.15 },
    lean: { sin: [[1, 0.04, 0.25]] }, // leans one way at frame 0, the other mid-loop
  }),
  // N3: bored: checks a wristwatch, flat eyes. Frame 0 is looking at the watch; mid-loop it looks back at you.
  // The other arm stays crossed from N2.
  N3: loop(2800, 12, {
    ...QBUBBLE, ...N_WATCH,
    flatEyes: { base: 1 },
    aLx: { keys: [[0, -1.2], [0.35, -1.2], [0.45, -0.3], [0.75, -0.3], [0.85, -1.2], [1, -1.2]] },
    aLz: { keys: [[0, 0.2], [0.35, 0.2], [0.45, 0.15], [0.75, 0.15], [0.85, 0.2], [1, 0.2]] },
    aRx: { base: -0.55 }, aRz: { base: -1.3 },
    nod: { keys: [[0, 0.2], [0.35, 0.2], [0.45, 0], [0.75, 0], [0.85, 0.2], [1, 0.2]] },
    lookX: { keys: [[0, -0.4], [0.35, -0.4], [0.45, 0], [0.75, 0], [0.85, -0.4], [1, -0.4]] },
    lookY: { keys: [[0, -0.4], [0.35, -0.4], [0.45, 0.1], [0.75, 0.1], [0.85, -0.4], [1, -0.4]] },
    squash: { keys: [[0, 0], [0.4, 0], [0.45, 0.03], [0.55, -0.08], [0.7, 0], [1, 0]] }, // a small stretch: the bubble stays in the square
    mouthCurve: { base: -0.15 },
  }),
  // N4: annoyed: rings its hand bell slowly and gently, twice a loop (frame 0 and N/2: the hand dips and the bell
  // swings out, ringing, and the head nods), brows down, glancing at it; the watch stays on its wrist
  N4: loop(2400, 12, {
    ...QBUBBLE, ...N_WATCH, ...N_BELL,
    browsDown: { base: 1 },
    aRx: { keys: [[0, -1.04], [0.1, -1.04], [0.25, -1.3], [0.4, -1.04], [0.6, -1.04], [0.75, -1.3], [0.9, -1.04], [1, -1.04]] },
    aRz: { base: 0.1 }, aLz: { base: 0.3 },
    bellSwing: { keys: [[0, 0.22], [0.12, 0], [0.4, 0], [0.5, 0.22], [0.62, 0], [0.9, 0], [1, 0.22]] },
    bellRing: { base: 0.45, sin: [[2, 0.45, 0.25]] }, // each gentle ring dies away slowly
    nod: { keys: [[0, 0.05], [0.1, 0], [0.4, 0], [0.46, 0.05], [0.6, 0], [0.9, 0], [0.96, 0.05], [1, 0.05]] },
    squash: { sin: [[1, 0.01]] },
    mouthCurve: { base: -0.3 },
    lookX: { base: 0.3 }, lookY: { base: -0.2 },
  }),
  // N5: frustrated: jumps and bobs with the bell held up, ringing it (the motion approved in the round-3 review,
  // N4's until then), anger puff
  N5: loop(1000, 24, {
    ...QBUBBLE, ...N_WATCH, ...N_BELL, ...ANGRY,
    ...N_JUMP(1),
    mouthCurve: { base: -0.3 },
    mouthOpen: { base: 0.12 },
    lookX: { base: 0.2 },
  }),
  // N6: panicking: N5's jumping and bobbing with the bell, bigger and faster; the nearly empty hourglass on the floor
  // beside it (only the sand trickle loops), sweating, wide eyes, its watch held up in front of it, trembling
  N6: loop(1000, 24, {
    ...N6_PROPS, ...N6_FACE,
    ...N_JUMP(N6_JUMP),
    // the watch held up in front of the chest (N3's reading pose), trembling: clear of the hourglass on the floor
    aLx: { base: -0.5, sin: [[6, 0.05]] }, aLz: { base: -0.6 },
    sandT: { saw: [2] },
    sweatT: { saw: [2] },
    mouthOpen: { base: 0.12, sin: [[3, 0.05]] },
    lookX: { base: 0.2 },
  }),
  // N7: frozen: N6 encased in an ice block, blue tint, the bell and the "?" bubble inside with it
  N7: loop(2400, 12, {
    ...N6_PROPS, ...N6_FACE, ...N_BELL,
    qbubble: { base: 1 }, // frozen: no bob
    ice: { base: 1 }, cold: { base: 1 },
    sparkT: { saw: [1] },
    sweatT: { base: 0.5 },
    aRx: { base: -0.7 }, aRz: { base: 0 }, aLz: { base: -0.6 }, aLx: { base: -0.5 }, // the bell held low, inside the ice
    bellSwing: { base: 0.2 },
    mouthOpen: { base: 0.12 },
    lookX: { base: 0.2 },
  }),

  // Asleep (purple): content -> drowsy -> asleep -> deep sleep -> stirring -> frozen
  // S1: a loop (round 3): stretches, arms up high, with a sparkle beside it (no check mark), then settles with a contented
  // half-closed look, and stretches again
  S1: loop(2400, 24, {
    ...SPARKLE,
    aLz: { keys: [[0, 0.15], [0.3, 2.7], [0.5, 2.7], [0.76, 0.15], [1, 0.15]] },
    aRz: { keys: [[0, 0.15], [0.3, 2.7], [0.5, 2.7], [0.76, 0.15], [1, 0.15]] },
    squash: { keys: [[0, 0], [0.15, -0.06], [0.35, 0.18], [0.5, 0.18], [0.72, 0], [1, 0]] },
    nod: { keys: [[0, 0], [0.58, 0], [0.7, 0.15], [0.84, 0.15], [1, 0]] },
    eyeOpen: { keys: [[0, 1], [0.64, 1], [0.74, 0.5], [0.86, 0.5], [1, 1]] },
    mouthCurve: { keys: [[0, 0.6], [0.35, 0.9], [0.7, 0.9], [1, 0.6]] },
  }),
  // S2: content: sitting back on a stool, legs forward, sipping tea (the cup reaches the mouth mid-loop)
  S2: loop(3000, 12, {
    ...STOOL, ...SEATED,
    tea: { base: 1 },
    aLz: { base: 0.15 },
    aRx: { keys: [[0, -0.8], [0.35, -0.8], [0.45, -1.6], [0.6, -1.6], [0.7, -0.8], [1, -0.8]] },
    aRz: { keys: [[0, -0.3], [0.35, -0.3], [0.45, -0.5], [0.6, -0.5], [0.7, -0.3], [1, -0.3]] },
    lean: { base: -0.08 },
    nod: { base: 0.1, sin: [[1, 0.03]] },
    squash: { sin: [[1, 0.02]] },
    eyeOpen: { base: 0.7 },
    mouthCurve: { base: 0.5 },
  }),
  // S3: drowsy: dozing sitting up on the stool, head nods, small Zzz; the tea is set down beside it
  S3: loop(3200, 12, {
    ...IDLE, ...TEA_DOWN, ...STOOL, ...SEATED,
    nod: { base: 0.2, sin: [[1, 0.2, -0.25]] },
    eyeOpen: { base: 0.12 },
    mouthCurve: { base: 0.3 },
    squash: { sin: [[1, 0.03]] },
    zzz: { base: 1 },
    zzzT: { saw: [1] },
  }),
  // S4: asleep: in bed with a pillow and a blanket, slow (big) Zzz
  S4: loop(3200, 12, {
    ...IDLE, ...TEA_DOWN, ...STOOL, ...BED,
    squash: { sin: [[1, 0.04]] },
    nod: { base: -0.1 },
    eyeOpen: { base: 0.04 },
    mouthCurve: { base: 0.25 },
    zzz: { base: 1 }, zzzBig: { base: 1 },
    zzzT: { saw: [1] },
  }),
  // S5: deep sleep: curled up under the blanket, pulled up to just under the eyes (knees drawn up into a hump), head
  // tilted into the pillow, a snore bubble swelling and shrinking from the sheet edge
  S5: loop(3200, 12, {
    ...IDLE, ...TEA_DOWN, ...STOOL, ...BED,
    curl: { base: 1 },
    snore: { base: 1 }, snoreT: { saw: [1] },
    zzz: { base: 1 }, zzzBig: { base: 1 },
    zzzT: { saw: [1, 0.5] },
    lean: { base: 0.22, sin: [[1, 0.02]] }, // the head tilted into the pillow
    squash: { sin: [[1, 0.04]] },
    eyeOpen: { base: 0.03 },
    mouthCurve: { base: 0.15 },
  }),
  // S6: stirring: the alarm clock rings beside the bed; it frowns, tosses to one side, an arm comes out from under the
  // blanket and swats towards the clock, one startled look, and it sinks back; a speech bubble says "!"
  S6: loop(2400, 12, {
    ...S6_PROPS, ...S6_FACE,
    snoreT: { saw: [1] },
    zzzT: { saw: [1] },
    alarmShake: { sin: [[6, 1]] },
    ringT: { saw: [2] }, // two arcs half a cycle apart: a ring every 0.6 s, each fading in and out over 7 frames
    lean: { keys: [[0, 0], [0.25, -0.1], [0.5, 0.1], [0.75, 0.04], [1, 0]] },
    squash: { keys: [[0, 0], [0.4, 0], [0.47, 0.04], [0.55, 0], [1, 0]] },
    aLz: { base: 0.15 },
    aRx: { keys: [[0, 0], [0.3, 0], [0.45, -1.05], [0.62, -1.05], [0.8, 0], [1, 0]] },
    aRz: { keys: [[0, 0.15], [0.3, 0.15], [0.45, 0.55], [0.5, 0.45], [0.55, 0.55], [0.62, 0.45], [0.8, 0.15], [1, 0.15]] },
    eyeOpen: { keys: [[0, 0.06], [0.44, 0.06], [0.5, 1], [0.58, 1], [0.64, 0.06], [1, 0.06]] },
    brow: { keys: [[0, -0.6], [0.44, -0.6], [0.5, -0.9], [0.58, -0.9], [0.64, -0.6], [1, -0.6]] },
    nod: { base: 0.05 },
  }),
  // S7: frozen: S6 encased in an ice block, asleep in bed, every S6 prop inside the ice with it
  S7: loop(2400, 12, {
    ...S6_PROPS, ...S6_FACE,
    ice: { base: 1 }, cold: { base: 1 },
    sparkT: { saw: [1] },
    snoreT: { base: 0.5 }, zzzT: { base: 0.3 }, ringT: { base: 0.5 },
    eyeOpen: { base: 0.04 },
    nod: { base: 0.05 },
    aLz: { base: 0.15 }, aRz: { base: 0.15 },
  }),

  // Other
  X1: { ...loop(1000, 12, {
    lie: { base: 1 }, grey: { base: 1 }, xEyes: { base: 1 },
    mouthCurve: { base: 0 },
    aLz: { base: 0.1 }, aRz: { base: 0.1 },
  }), still: true },
  X2: loop(1800, 12, {
    // the arms sway out and in once per loop, so mid-loop is not frame 0 (the strain sine is 0 at both)
    aLz: { base: 0.15, sin: [[1, 0.12, 0.25]] }, aRz: { base: 0.15, sin: [[1, 0.12, 0.75]] },
    squash: { sin: [[1, 0.015]] },
    eyeOpen: blink(0.7, 1800),
  }),
  // X3: a nearly empty battery (round 3): the whole character is the battery, a cap on its head; an orange charge band
  // fills the lowest 35-40 % of its height from the feet up (gallery review note B: ~20 % sat too low to read) (legs, then the bottom of the body) under a bright fill line,
  // grey above, dimming and brightening once a loop (2.4 s); it sags, arms hanging, swaying a little
  X3: loop(2400, 12, {
    battery: { base: 1 }, charge: { base: 0.52 }, chargeT: { saw: [1] },
    grey: { base: 0.9 },
    aLz: { base: 0.06, sin: [[1, 0.04, 0.25]] }, aRz: { base: 0.06, sin: [[1, 0.04, 0.75]] },
    aLx: { base: 0.12 }, aRx: { base: 0.12 },
    nod: { base: 0.12 },
    lean: { sin: [[1, 0.03, 0.25]] },
    lookY: { base: -0.4 },
    brow: { base: -0.7 },
    mouthCurve: { base: -0.5 },
    squash: { base: -0.03, sin: [[1, 0.02, 0.25]] },
    eyeOpen: blink(0.6, 2400),
  }),
  // X4: compacting: a slow press with strong squash (loop length, squash depth and the eyes are authored in
  // overrides.json). The release is eased over ~6 frames: the press lifts, the body springs up, the squeezed face
  // (brows down, eyes shut) relaxes as the eyes open (round 3 gate: it snapped in ~3 frames).
  X4: loop(1600, 12, {
    squash: { keys: [[0, 0], [0.35, -0.34], [0.5, -0.38], [0.64, 0.12], [0.78, -0.04], [0.9, 0.02], [1, 0]] },
    press: { base: 1 },
    aLz: { keys: [[0, 0.15], [0.3, -0.7], [0.55, -0.7], [0.76, 0.4], [0.92, 0.15], [1, 0.15]] },
    aRz: { keys: [[0, 0.15], [0.3, -0.7], [0.55, -0.7], [0.76, 0.4], [0.92, 0.15], [1, 0.15]] },
    aLx: { keys: [[0, 0], [0.3, -0.5], [0.55, -0.5], [0.76, 0], [1, 0]] },
    aRx: { keys: [[0, 0], [0.3, -0.5], [0.55, -0.5], [0.76, 0], [1, 0]] },
    eyeOpen: { keys: [[0, 1], [0.35, 0.3], [0.55, 0.3], [0.74, 1], [1, 1]] },
    brow: { keys: [[0, 0], [0.35, 0.8], [0.55, 0.8], [0.74, 0], [1, 0]] },
    mouthCurve: { keys: [[0, 0.3], [0.35, -0.3], [0.55, -0.3], [0.74, 0.6], [1, 0.3]] },
    mouthOpen: { keys: [[0, 0], [0.66, 0], [0.76, 0.2], [0.88, 0], [1, 0]] },
  }),
  L1: loop(1800, 12, {
    aRz: { base: 2.6, sin: [[3, 0.4, 0.25]] }, // from the top of a wave: mid-loop the hand is at the bottom
    aLz: { base: 0.15 },
    turn: { sin: [[1, 0.12]] },
    squash: { sin: [[2, 0.02]] },
    eyeOpen: blink(0.55, 1800),
    mouthCurve: { base: 0.85 },
  }),
};

/** States whose body is frozen in ice: X2 puffs them without straining. */
export const FROZEN: ReadonlySet<ClayStateId> = new Set<ClayStateId>(['N7', 'S7']);
