/**
 * A pose is a flat record of numbers. A script describes each number over one loop as the sum
 * of three parts: a base value or smooth keyframes, sine terms with whole-number cycles (so they
 * close exactly), and a sawtooth phase (for props that spawn, travel and fade). Everything is a
 * pure function of the loop position t in [0, 1], so nothing can build up between loops.
 */
export const POSE_KEYS = [
  // body. squash: height = 1 + squash, width keeps the volume. lie: 1 = flat on its side. puff: 1 = the X2
  // inflated body: the same body uniformly scaled up (all axes alike) and rounder. X2 is the one deliberate exception
  // to one body size (spec §7.4.1, round 2): looking inflated is its meaning. There is no other scale key.
  'squash', 'puff', 'bodyY', 'bodyX', 'lean', 'nod', 'turn', 'lie',
  // limbs (radians). x: swing forward when negative. z: outward when positive, across the body when negative.
  // lRz: the right leg swung out sideways (N2's foot tap, so the lifted foot shows from the front).
  // reach (W typing, round 3): the shoulders come down and forward, so the arms reach down to the keys from the
  // chest instead of rising beside the head.
  'aLx', 'aLz', 'aRx', 'aRz', 'lLx', 'lRx', 'lRz', 'reach',
  // face. brow: -1 worried, +1 determined. mouthOpen stays <= 0.2: the mouth is a thin line or a tiny closed
  // shape, never a dark "o" (spec §7.4.3, no beard).
  'eyeOpen', 'lookX', 'lookY', 'xEyes', 'mouthCurve', 'mouthOpen', 'brow',
  // face keys (0 off, 1 on), escalating one way along each timeline (scripts.ts FACE_INTENSITY). The eyes are the
  // same bead eyes in every state (round 2): expressions come from brows and lid shape only, never eye whites,
  // bags or droopy lids. narrowEyes (W3+, a focused slit), flatEyes (N3, bored half-lids), browsDown (N4+),
  // angerPuff (N5+, a cartoon puff by the head, above the eyes), wideEyes (N6+, arched lids lifted off the beads).
  'narrowEyes', 'flatEyes', 'browsDown', 'angerPuff', 'wideEyes',
  // tint: 1 = fully grey (stopped) / fully frosted (ice).
  'grey', 'cold',
  // motion that reads in a still: fastHands = W3+'s blurred hands (motion streaks), blurHands = W7's ghosted hands,
  // sweatFly = W7's sweat flying off the head instead of dripping.
  'fastHands', 'blurHands', 'sweatFly',
  // pose cues, not props: sleeves (W1 only: sleeves pushed up for the knuckle crack; never carried on, so they
  // never read as armbands, spec §7.4.4), roll (how far they are pushed up), curl (S5: curled up under the
  // blanket, pulled up so only the top of the head shows).
  'sleeves', 'roll', 'curl',
  // props: 0 hidden, 1 shown. *T keys are phases in 0..1. A prop the pose cannot hold is put down beside the
  // character, still visible: teaDown (the cup on the floor; from S4 on the stool by the bed).
  // battery (X3): the cap on the head and the whole character's charge, orange from the feet up to `charge` (0..1 of
  // its height) under a fill line, grey above; chargeT the slow blink's phase. speech (S6+): a speech bubble, startled by the alarm.
  'laptop', 'bits', 'bitsT', 'sweat', 'sweatT', 'steam', 'steamT', 'headphones', 'headband', 'mug',
  'watch', 'hourglass', 'sandLevel', 'sandT', 'bell', 'bellSwing', 'bellRing',
  'tea', 'teaDown', 'stool', 'alarm', 'alarmShake', 'ringT', 'bed', 'blanket', 'ice', 'sparkT', 'battery', 'charge', 'chargeT', 'press',
  'zzz', 'zzzT', 'zzzBig', 'snore', 'snoreT', 'speech', 'qbubble', 'qmark', 'qmarkT', 'sparkle', 'knock', 'knockT', 'gauge', 'gaugeV',
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];

/**
 * Props that accumulate along a timeline (spec §7.2): once a W, N or S step shows one, every later step of
 * that timeline shows it too (the ice of N7/S7 encases them). `bed` includes the headboard and pillow. `knock` (ripples
 * on the glass) is no longer used by any state (round 3: N5 jumps with its bell instead of knocking); `stool` is what S2
 * and S3 sit on (from S4 it stands beside the bed with the tea on it). The sleeves are not a prop, and since round 3 no
 * state wears them (W1 is a warm-up with no sleeves).
 */
export const PROP_KEYS = [
  'laptop', 'bits', 'headphones', 'sweat', 'steam', 'headband', 'mug',
  'qbubble', 'qmark', 'watch', 'bell', 'knock', 'hourglass',
  'tea', 'stool', 'zzz', 'bed', 'blanket', 'snore', 'alarm', 'speech',
  'ice', 'battery', 'press', 'gauge',
] as const satisfies readonly PoseKey[];

/** Face keys: shown by intensity band, not accumulated (spec §7.2: the face escalates one way). */
export const FACE_KEYS = ['narrowEyes', 'flatEyes', 'browsDown', 'angerPuff', 'wideEyes'] as const satisfies readonly PoseKey[];
export type Pose = Record<PoseKey, number>;

export const NEUTRAL: Readonly<Pose> = Object.freeze({
  ...(Object.fromEntries(POSE_KEYS.map((k) => [k, 0])) as Pose),
  eyeOpen: 1, mouthCurve: 0.5, gaugeV: 0.5, sandLevel: 0.5, charge: 1, aLz: 0.15, aRz: 0.15,
});

export interface Channel {
  base?: number;
  /** Smooth keyframes [t, value], t ascending in 0..1, cosine-eased between keys. Replaces `base`. */
  keys?: ReadonlyArray<readonly [number, number]>;
  /** Sine terms [cycles (whole number), amplitude, phase 0..1]. */
  sin?: ReadonlyArray<readonly [number, number, number?]>;
  /** Sawtooth [cycles (whole number), offset 0..1]: adds fract(cycles * t + offset). */
  saw?: readonly [number, number?];
}

export interface Script {
  /** Length of one pass in ms. */
  loopMs: number;
  /** Baked frames per second of animation (12 = claymation "on twos"; 24 for fast motion). */
  fps: 12 | 24;
  channels: Partial<Record<PoseKey, Channel>>;
}

const TAU = Math.PI * 2;
const ease = (x: number) => (1 - Math.cos(Math.PI * x)) / 2;

export function evalChannel(c: Channel, t: number, fallback: number): number {
  let v = c.base ?? fallback;
  const k = c.keys;
  if (k && k.length) {
    if (t <= k[0][0]) v = k[0][1];
    else if (t >= k[k.length - 1][0]) v = k[k.length - 1][1];
    else {
      let i = 0;
      while (k[i + 1][0] < t) i++;
      const [t0, v0] = k[i];
      const [t1, v1] = k[i + 1];
      v = v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
    }
  }
  if (c.sin) for (const [cy, amp, ph = 0] of c.sin) v += amp * Math.sin(TAU * (cy * t + ph));
  if (c.saw) {
    const x = c.saw[0] * t + (c.saw[1] ?? 0);
    v += x - Math.floor(x);
  }
  return v;
}

export function evalScript(s: Script, t: number): Pose {
  const pose = { ...NEUTRAL } as Pose;
  for (const k of POSE_KEYS) {
    const c = s.channels[k];
    if (c) pose[k] = evalChannel(c, t, NEUTRAL[k]);
  }
  return pose;
}

/**
 * The X2 modifier: body inflated and straining, a small "full" gauge. Pure and seamless
 * (`cycles` whole strain cycles per loop). Frozen states (inside the ice) inflate without straining.
 * The inflated body is the same body uniformly scaled up and rounder, never deformed (spec §7.4.1, round 2).
 */
const spread = (az: number) => 0.3 * Math.max(0, Math.min(1, (1.4 - az) / 0.4));

export function applyPuff(p: Pose, t: number, cycles: number, frozen: boolean): Pose {
  const strain = frozen ? 0 : Math.sin(TAU * cycles * t);
  return {
    ...p,
    puff: 1,
    squash: p.squash + 0.015 * strain,
    // the arms spread with the strain, unless they are typing (round 2: in W both hands stay on the keys); raised arms
    // spread less, so the hands stay in the frame round the inflated body
    aLz: p.laptop > 0.5 ? p.aLz : p.aLz + spread(p.aLz),
    aRz: p.laptop > 0.5 ? p.aRz : p.aRz + spread(p.aRz),
    mouthCurve: Math.min(p.mouthCurve, -0.3),
    brow: Math.min(p.brow, -0.6),
    gauge: 1,
    gaugeV: 0.94 + 0.04 * strain,
  };
}
