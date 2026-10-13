import {
  Box3, BoxGeometry, Euler, CapsuleGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture, ExtrudeGeometry, Group,
  LatheGeometry, LinearFilter, type Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D, OctahedronGeometry, Path,
  Quaternion, RepeatWrapping, RGBAFormat, Shape, SphereGeometry, TorusGeometry, UnsignedByteType, Vector2, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { glyphGeometry, type GlyphName } from './glyphs.js';
import { clayNoise } from './noise.js';
import type { GlyphKey } from './override-schema.js';
import type { Authored } from './overrides.js';
import type { Pose } from './pose.js';

const LEG = 0.24;      // hip height above the floor
const BODY_H = 0.95;
const BODY_W = 1.0;
const BODY_D = 0.8;
const SHOULDER = 0.7;  // shoulder height as a fraction of body height
const ARM_LEN = 0.5;
const FACE_Z = BODY_D / 2;
/** X2: the same body uniformly scaled up (all axes alike) and rounder; spec §7.4.1's one deliberate exception. */
export const INFLATE = 1.12;
/**
 * The laptop's keyboard in the character's own space (round 2: in every W state both hands stay on the keys). The
 * laptop stands on a low desk in front of the body, so short arms reach the keys and the lid stays below the mouth.
 */
export const KEYBOARD = { x: [-0.36, 0.36], y: 0.35, z: [0.45, 0.87] } as const;
const DESK_TOP = 0.3;
/** The hand bell's scale (N4-N7) and the angle its ringing arcs span. */
const BELL_SCALE = 1.1, BELL_ARC = Math.PI / 2.6;
/** W typing (round 3): how far `reach` brings the shoulders in, down and forward. */
export const REACH = { in: 0.05, down: 0.2, fwd: 0.05 };
const FEET = -0.02;     // the soles' height: the legs' capsules reach just below the floor line
/** X3's charge band (round 3): battery orange, a pale fill line on top of it CHARGE_LINE thick (world units). */
const CHARGE_COL = new Color('#f2802c');
const CHARGE_LINE_COL = new Color('#ffd9a0');
const CHARGE_LINE = '0.035';
const MOUTH_TUBE = 0.016; // the mouth line's half-thickness: one thin line (spec §7.4.3)
/** S4 on: the stool stands by the bed's front left corner, smaller, with the tea cup on it. */
const STOOL_BY_BED = { x: -0.62, z: 0.78, scale: 0.5 };

const EYE_R = 0.085;   // the bead eye's radius (scaled 1 × eyeOpen × 0.6)
/** The half-lids over the beads (face units from the bead's centre): the upper lid's edge height and tilt towards the
 * outer corner, and the lower lid's edge height. */
const LIDS = {
  narrowEyes: { up: 0.022, tilt: -0.15, low: -0.03 as number | undefined },
  flatEyes: { up: 0.03, tilt: 0, low: undefined as number | undefined },
};
const HI_R = EYE_R * 1.02, HI_ANGLE = 0.31;           // the catch-light: a cap a hair above the bead's surface
const HI_DIR = new Vector3(0.03, 0.035, 0.075).normalize(); // where it sits on an open eye (up and to the right)
/** Under a half-lid: the catch-light's size (across, up) and its gap below the lid's edge, about a board pixel. */
const HI_LIDDED = { sx: 0.75, sy: 0.4, gap: 0.026 };
const _hiE = new Euler(0, 0, 0, 'YXZ'), _hiV = new Vector3();
/** The catch-light's extent on the face (x and y from the bead's centre) with its apex along `dir` (bead space). */
function hiExtent(dir: Vector3, sx: number, sy: number, open: number) {
  _hiE.set(-Math.asin(dir.y), Math.atan2(dir.x, dir.z), 0);
  const k = Math.min(sx, sy) ** 2;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * Math.PI * 2;
    _hiV.set(sx * HI_R * Math.sin(HI_ANGLE) * Math.cos(t), sy * HI_R * Math.sin(HI_ANGLE) * Math.sin(t), k * HI_R * (Math.cos(HI_ANGLE) - 1))
      .applyEuler(_hiE).addScaledVector(dir, HI_R);
    x0 = Math.min(x0, _hiV.x); x1 = Math.max(x1, _hiV.x);
    y0 = Math.min(y0, _hiV.y * open); y1 = Math.max(y1, _hiV.y * open);
  }
  return { x0, x1, y0, y1 };
}
/**
 * Set an eye's catch-light on its bead (round 3, gate 2). An open eye: up and to the right (HI_DIR). Under a half-lid
 * (W3+'s narrowed eyes, N3's flat lids): a smaller, flatter glint, moved down the bead until its top is HI_LIDDED.gap
 * below the lid's edge over its whole width, so it sits inside the visible slit and the lid never cuts it.
 */
function placeHighlight(h: Mesh, side: number, open: number, p: Pose) {
  const lid = p.narrowEyes > 0.5 ? LIDS.narrowEyes : p.flatEyes > 0.5 ? LIDS.flatEyes : null;
  const dir = HI_DIR.clone();
  let sx = 1, sy = 1;
  if (lid) {
    ({ sx, sy } = HI_LIDDED);
    const edge = (x: number) => lid.up + Math.tan(-side * lid.tilt) * x;
    for (let it = 0; it < 4; it++) {
      const e = hiExtent(dir, sx, sy, open);
      const dy = Math.min(edge(e.x0), edge(e.x1)) - HI_LIDDED.gap - e.y1;
      if (Math.abs(dy) < 1e-4 || (it === 0 && dy > 0)) break;
      const v = (dir.y * HI_R * open + dy) / open / HI_R;
      dir.set(dir.x, v, Math.sqrt(Math.max(0.05, 1 - dir.x * dir.x - v * v))).normalize();
    }
  }
  h.position.copy(dir).multiplyScalar(HI_R);
  h.rotation.set(-Math.asin(dir.y), Math.atan2(dir.x, dir.z), 0, 'YXZ');
  h.scale.set(sx, sy, Math.min(sx, sy) ** 2);
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => { const c = clamp01(x); return c * c * (3 - 2 * c); };
const fract = (x: number) => x - Math.floor(x);
const tiny = (x: number) => Math.max(0.001, x);
/**
 * A particle's strength over its life `ph` (0..1): eases up from 0 over the first `rise` of it and back down to 0
 * over the last `fall` (squared, so the first and last frames of a ramp are faint), so it never appears or vanishes in
 * one frame (round 3, spec §7.4.8). Every particle's alpha (and most sizes) go through it; the scripts keep at least
 * ~10 baked frames per particle life, so each ramp spans 3+ frames.
 */
export const fadeInOut = (ph: number, rise = 0.3, fall = 0.3) => (ease(ph / rise) * (1 - ease((ph - (1 - fall)) / fall))) ** 2;

/**
 * sx: horizontal scale of the body (squash and X2's inflation), sy: its squash, k: X2's inflation, top: the top of the
 * head above the hips. fx: sx without the inflation, for props floating beside the head (bubbles, Zzz, gauge), so an
 * inflated (X2) body does not push them out of the frame; sink: how far the inflated head's top rose, which props
 * floating above the head come back down by.
 */
interface Ctx { sx: number; sy: number; k: number; fx: number; top: number; sink: number }

/** What `Character.inspect()` reports, for the spec §7.4 tests. Coordinates are the character's own space. */
export interface Inspection {
  /** The body's bounding box. */
  body: Box3;
  /** Meshes that receive a shadow (none may). */
  shadowed: string[];
  /** Props and face keys that can be seen in this pose, by pose key name (`fastHands` for the smear of fast hands). */
  shown: string[];
  /** Every pose key the character has geometry for, seen or not. */
  parts: string[];
  /** World box of each prop on show (the union of its visible meshes). */
  props: Record<string, Box3>;
  /** World positions of the left and right hands. */
  hands: Vector3[];
  /** World boxes of named meshes on show (`bubble`: the "?" bubble, `bellBody`: the hand bell's brass bell), for centring tests. */
  marks: Record<string, Box3[]>;
  /** World boxes of the glyphs on show, by glyph name (`q` for every "?"). */
  glyphs: Partial<Record<GlyphKey, Box3[]>>;
  /** Every glyph name the character draws, seen or not. */
  glyphParts: GlyphKey[];
  /** World positions of the bead eyes on show, and how wide each bead is (the same bead in every state, round 2). */
  eyes: Array<{ at: Vector3; bead: number }>;
  /** Light, eye-sized meshes on the face right round an eye: eye whites or sclera rings (round 2: none may show). */
  nearEyes: string[];
  /** World position of the mouth's centre. */
  mouth: Vector3;
  /** X3's charge (round 3): the fill line's height, the soles' and the top of the head (world y), when it shows. */
  charge?: { level: number; feet: number; head: number };
  /**
   * Mouth shapes on show, which one (`line`: a thin curved line, `o`: a tiny closed shape), its width and height,
   * the line's thickness, and any dark mesh on the face below the mouth (none may be).
   */
  face: { mouths: number; mouthKind: 'line' | 'o' | 'none'; mouthWidth: number; mouthHeight: number; lineThickness: number; belowMouth: string[] };
}

const worldBox = (m: Mesh) => {
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  return m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
};
/** Dark enough to read as a beard or a chin strap: perceived lightness of the material colour under 0.3. */
const lightness = (m: Mesh) => {
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as Material & { color?: Color };
  if (!mat.color) return 0;
  const hex = mat.color.getHex();
  return (0.2126 * (hex >> 16) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255;
};
const dark = (m: Mesh) => {
  const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as Material & { color?: Color };
  if (!mat.color || (mat.transparent && mat.opacity < 0.3)) return false;
  const hex = mat.color.getHex();
  return (0.2126 * (hex >> 16) + 0.7152 * ((hex >> 8) & 255) + 0.0722 * (hex & 255)) / 255 < 0.3;
};
/** The test passes of `Character.setDebug`. */
export interface DebugPass {
  pass: 'normal' | 'highlight' | 'eyes' | 'particles';
  /** Test fixture: round 2's catch-light (a sphere proud of the bead). */
  legacyHighlight?: boolean;
  /** Test fixture: the `highlight` pass shows the catch-light however far the lid is down (it normally fades out by
   * 0.25 open), so the lid's clipping is tested on shut eyes too, not only the fade. */
  forceGlint?: boolean;
  /** Test fixture: the middle Z of the Zzz at full strength and full size (the frame checks' one-frame particle beside
   * other particles, rendered for one frame of a loop). */
  zFlash?: boolean;
  /** Test fixture: pose keys set on top of the state's pose (the frame checks' seam-pop fixtures). */
  pose?: Partial<Pose>;
}
/** Layer of every particle mesh (0/1 bits, sweat, steam, Zzz, snore bubble, sparkle stars, ringing arcs, ice glints). */
export const PARTICLE_LAYER = 1;
/** Props whose every mesh is a particle. */
const PARTICLE_PROPS = ['bits', 'sweat', 'steam', 'zzz', 'snore'];
interface Prop { group: Group; update(p: Pose, c: Ctx): void }
/** A transform as built, restored before each pose so authored offsets never build up between frames. */
interface Rest { pos: Vector3; quat: Quaternion; scale: Vector3 }
const rest = (o: Object3D): Rest => ({ pos: o.position.clone(), quat: o.quaternion.clone(), scale: o.scale.clone() });
const restore = (o: Object3D, r: Rest) => { o.position.copy(r.pos); o.quaternion.copy(r.quat); o.scale.copy(r.scale); };
const GLYPH_KEY: Record<GlyphName, GlyphKey> = { '?': 'q', '0': '0', '1': '1', Z: 'Z', F: 'F', '!': 'bang' };

/**
 * The clay character: a rounded-cube body, bead eyes, small mouth, capsule limbs and every prop,
 * built from three.js primitives. `apply(pose, colour)` poses it; nothing else changes it.
 */
export class Character {
  readonly root = new Group();
  private figure = new Group();
  private upper = new Group();
  private body: Mesh;
  private bodyGeo!: RoundedBoxGeometry;
  private puffGeo!: RoundedBoxGeometry;
  private cheeks: Mesh[] = [];
  /** X3's charge (round 3): the clay itself is orange below a level (world y), grey above it. */
  private chargeU = { on: { value: 0 }, y: { value: 0 }, col: { value: new Color() }, line: { value: new Color() } };
  private chargeY = 0;
  private ghost!: MeshStandardMaterial;
  private smear!: MeshStandardMaterial;
  private top = new Group(); // rides on top of the body and follows its squash
  private armL = new Group();
  private armR = new Group();
  private handL = new Group();
  private handR = new Group();
  private legL = new Group();
  private legR = new Group();
  private face = new Group();
  private eyes: Array<{ bead: Mesh; cross: Group; side: number }> = [];
  private ink!: MeshStandardMaterial;
  private beadMat!: MeshStandardMaterial;
  private highlights: Array<{ h: Mesh; legacy: Mesh; mat: MeshBasicMaterial }> = [];
  private debugPass: DebugPass = { pass: 'normal' };
  private flat = new Map<string, MeshBasicMaterial>();
  private brows: Mesh[] = [];
  private mouth: Mesh;
  private mouthO: Mesh;
  private props: Prop[] = [];
  private glyphMeshes: Array<{ m: Mesh; key: GlyphKey }> = [];
  private rests = new Map<Object3D, Rest>();
  private clay: MeshStandardMaterial;
  private base = new Color('#e07a4f');
  private tint = new Color();
  private grey = new Color('#8b8b8f');
  private frost = new Color('#a9dcff');
  private owned: Array<{ dispose(): void }> = [];
  private noise: DataTexture;

  constructor() {
    this.noise = new DataTexture(clayNoise(), 128, 128, RGBAFormat, UnsignedByteType);
    this.noise.wrapS = this.noise.wrapT = RepeatWrapping;
    this.noise.magFilter = this.noise.minFilter = LinearFilter;
    this.noise.repeat.set(2, 2);
    this.noise.needsUpdate = true;
    this.owned.push(this.noise);
    this.clay = new MeshStandardMaterial({ color: this.base, roughness: 0.92, metalness: 0, bumpMap: this.noise, bumpScale: 0.45 });
    this.owned.push(this.clay);
    // X3 (round 3, spec §7.2): the whole character is one battery. Every clay surface (body, arms, legs) below the
    // charge level is the charge colour, grey above it, with a bright fill line on top of the band: a level in the
    // world, so legs, then the bottom of the body, fill from the feet up. Off (uChargeOn 0) in every other state.
    this.clay.onBeforeCompile = (sh) => {
      sh.uniforms.uChargeOn = this.chargeU.on;
      sh.uniforms.uChargeY = this.chargeU.y;
      sh.uniforms.uChargeCol = this.chargeU.col;
      sh.uniforms.uChargeLine = this.chargeU.line;
      sh.vertexShader = 'varying float vChargeY;\n' + sh.vertexShader.replace('#include <project_vertex>',
        '#include <project_vertex>\n\tvChargeY = (modelMatrix * vec4(transformed, 1.0)).y;');
      sh.fragmentShader = 'uniform float uChargeOn;\nuniform float uChargeY;\nuniform vec3 uChargeCol;\nuniform vec3 uChargeLine;\nvarying float vChargeY;\n'
        + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
\tif (uChargeOn > 0.5) {
\t\tfloat d = vChargeY - uChargeY;
\t\tdiffuseColor.rgb = mix(diffuseColor.rgb, uChargeCol, 1.0 - step(0.0, d));
\t\tdiffuseColor.rgb = mix(diffuseColor.rgb, uChargeLine, step(-${CHARGE_LINE}, d) * (1.0 - step(0.0, d)));
\t}`);
    };
    this.clay.customProgramCacheKey = () => 'clay-charge';

    this.root.add(this.figure);
    this.figure.add(this.upper);
    this.upper.position.y = LEG;

    // One body for every state (spec §7.4.1). X2's inflated body is the same shape with rounder edges, scaled up
    // uniformly (INFLATE) in apply(): looking inflated is its meaning (round 2).
    this.bodyGeo = this.geo(new RoundedBoxGeometry(BODY_W, BODY_H, BODY_D, 6, 0.27));
    this.puffGeo = this.geo(new RoundedBoxGeometry(BODY_W, BODY_H, BODY_D, 6, 0.4));
    this.body = new Mesh(this.bodyGeo, this.clay);
    this.body.castShadow = true;
    this.upper.add(this.body);
    this.ghost = new MeshStandardMaterial({ color: this.base, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false });
    this.owned.push(this.ghost);
    this.upper.add(this.top);
    this.body.add(this.face);

    // Bead eyes with a catch-light, and X eyes for the stopped state. The catch-light is part of the eyeball (round 3,
    // spec §7.4.8): a thin patch of the bead's own surface, a hair above it, so it is squashed with the bead when the
    // eye closes and anything in front of the eyeball (a lid, a bell) hides it by depth, exactly as it hides the
    // bead. It can never sit on or above a lid line. (Round 2's catch-light was a small sphere standing proud of the
    // bead, in front of the half-lids of W3+ and N3.) It fades out as the eye closes: a shut eye shows no catch-light.
    // Under a half-lid it is not left to the lid to cut (round 3, gate 2: a catch-light cut by the lid sat on the lid
    // line as a white chip): placeHighlight moves it down the bead into the visible slit, a clear gap below the lid's
    // edge, and makes it a smaller, flatter glint that fits there.
    const ink = this.std('#17151a', 0.25, false);
    this.ink = ink;
    this.beadMat = this.std('#17151a', 0.25, false); // the beads' own material, so a test pass can paint them alone
    const eyeGeo = this.geo(new SphereGeometry(EYE_R, 16, 12));
    // a cap about +z, its apex at the origin: placeHighlight sets it on the bead's surface where it should sit
    const hiGeo = this.geo(new SphereGeometry(HI_R, 12, 4, 0, Math.PI * 2, 0, HI_ANGLE).rotateX(Math.PI / 2).translate(0, 0, -HI_R));
    const legacyGeo = this.geo(new SphereGeometry(0.026, 8, 6));
    const bar = this.geo(new BoxGeometry(0.18, 0.04, 0.03));
    for (const side of [-1, 1]) {
      const bead = new Mesh(eyeGeo, this.beadMat);
      // one material per eye: it fades with that eye's lid. Depth-tested, so whatever covers the bead covers it too.
      const mat = new MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      this.owned.push(mat);
      const h = new Mesh(hiGeo, mat);
      h.name = 'catchlight';
      bead.add(h);
      // test fixture only (debug legacyHighlight): round 2's catch-light, a small sphere proud of the bead
      const legacy = new Mesh(legacyGeo, mat);
      legacy.position.set(0.03, 0.035, 0.075);
      legacy.visible = false;
      bead.add(legacy);
      this.highlights.push({ h, legacy, mat });
      this.face.add(bead);
      const cross = new Group();
      for (const a of [Math.PI / 4, -Math.PI / 4]) { const b = new Mesh(bar, ink); b.rotation.z = a; cross.add(b); }
      cross.position.set(side * 0.2, 0.1, FACE_Z + 0.02);
      this.face.add(cross);
      this.eyes.push({ bead, cross, side });
      const brow = new Mesh(this.geo(new CapsuleGeometry(0.022, 0.12, 4, 8)), ink);
      brow.rotation.z = Math.PI / 2;
      this.face.add(brow);
      this.brows.push(brow);
    }

    // puffed cheeks (X2): flattened blush beads either side of the mouth
    const blush = this.std('#ef7a63', 0.8, false);
    for (const side of [-1, 1]) {
      const ch = new Mesh(this.geo(new SphereGeometry(0.075, 12, 8)), blush);
      ch.scale.set(1, 0.75, 0.45);
      ch.position.set(side * 0.3, -0.1, FACE_Z + 0.005);
      this.face.add(ch);
      this.cheeks.push(ch);
    }

    // One mouth, never two: a single thin curved line, or (open) a tiny closed oval in its place. Never a
    // second dark shape, crease or shadow under it (spec §7.4.3: a dark "o" with a smudge below read as a goatee).
    const lip = this.std('#2a1d1a', 0.6, false);
    this.mouth = new Mesh(this.geo(new TorusGeometry(0.1, MOUTH_TUBE, 8, 18, Math.PI)), lip);
    this.mouth.position.z = FACE_Z + 0.005;
    this.face.add(this.mouth);
    this.mouthO = new Mesh(this.geo(new SphereGeometry(0.05, 12, 8)), lip);
    this.mouthO.position.z = FACE_Z;
    this.face.add(this.mouthO);

    // capsule arms and stubby legs, hanging from pivots
    const armGeo = this.geo(new CapsuleGeometry(0.078, ARM_LEN - 0.15, 5, 10));
    const legGeo = this.geo(new CapsuleGeometry(0.1, 0.06, 5, 10));
    for (const [g, hand, x] of [[this.armL, this.handL, -0.55], [this.armR, this.handR, 0.55]] as const) {
      const m = new Mesh(armGeo, this.clay);
      m.position.y = -ARM_LEN / 2;
      m.castShadow = true;
      g.add(m);
      hand.position.y = -ARM_LEN;
      g.add(hand);
      g.position.x = x;
      this.upper.add(g);
    }
    for (const [g, x] of [[this.legL, -0.22], [this.legR, 0.22]] as const) {
      const m = new Mesh(legGeo, this.clay);
      m.position.y = -(LEG + 0.02) / 2;
      m.castShadow = true;
      g.add(m);
      g.position.x = x;
      this.upper.add(g);
    }
    this.buildProps();
    this.buildFace();
    for (const pr of this.props) if (PARTICLE_PROPS.includes(pr.group.name)) pr.group.traverse((o) => o.layers.enable(PARTICLE_LAYER));
    for (const pr of this.props) this.rests.set(pr.group, rest(pr.group));
    for (const { m } of this.glyphMeshes) this.rests.set(m, rest(m));
  }

  // ---------- test passes ----------

  /**
   * Test passes (spec §7.4.8, round 3), never used on the board: `highlight` paints the eyes' catch-lights flat
   * magenta (shown at full strength wherever they are drawn at all), `eyes` hides them and paints the visible eyeball
   * flat blue, `particles` is drawn by the stage from PARTICLE_LAYER alone. `legacyHighlight` swaps in round 2's
   * catch-light (a regression fixture: the eye test must fail on it). Applies from the next `apply`.
   */
  setDebug(d: DebugPass = { pass: 'normal' }): void { this.debugPass = d; }

  private flatMat(color: string): MeshBasicMaterial {
    let m = this.flat.get(color);
    if (!m) { m = new MeshBasicMaterial({ color }); this.flat.set(color, m); this.owned.push(m); }
    return m;
  }

  // ---------- helpers ----------

  private geo<G extends { dispose(): void }>(g: G): G { this.owned.push(g); return g; }
  private std(color: string, rough = 0.88, bump = true): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...(bump ? { bumpMap: this.noise, bumpScale: 0.3 } : {}) });
    this.owned.push(m);
    return m;
  }
  private basic(color: string, opacity = 1): MeshBasicMaterial {
    const m = new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
    this.owned.push(m);
    return m;
  }
  private glass(color: string, opacity: number): MeshStandardMaterial {
    const m = new MeshStandardMaterial({ color, roughness: 0.15, metalness: 0, transparent: true, opacity, depthWrite: false });
    this.owned.push(m);
    return m;
  }
  private mesh(geo: { dispose(): void }, mat: Material, parent: Group | Mesh, shadow = true): Mesh {
    const m = new Mesh(this.geo(geo) as never, mat);
    m.castShadow = shadow;
    parent.add(m);
    return m;
  }
  private glyph(name: GlyphName, mat: Material, parent: Group, scale: number, r?: number): Mesh {
    const m = new Mesh(glyphGeometry(name, r), mat); // glyph geometry is shared and cached; not owned
    m.scale.setScalar(scale);
    parent.add(m);
    this.glyphMeshes.push({ m, key: GLYPH_KEY[name] });
    return m;
  }
  /** `name` is what `inspect().shown` reports while the prop can be seen. */
  private prop(name: string, group: Group, parent: Group, update: Prop['update']) {
    group.name = name;
    parent.add(group);
    this.props.push({ group, update });
  }

  // ---------- props ----------

  private buildProps() {
    const f = this.figure;

    // Laptop on a low wooden desk in front of the body, lid towards the character (round 2: both hands on the keys;
    // the arms are short, so the keys come up to them). Narrower than the body and slate blue, with a light logo; the
    // lid is short, so from the front it covers only the lower body and never the face (spec §7.4.3: a lid under the
    // mouth read as a beard in the prototype). The hands rest on the keys just behind the lid's top edge.
    {
      const g = new Group();
      const slate = this.std('#7489b3', 0.7), keys = this.std('#c9d3e3', 0.7), wood = this.std('#b07a4c'), top = this.std('#c99563');
      this.mesh(new RoundedBoxGeometry(1.32, 0.04, 0.5, 3, 0.015), top, g).position.set(0, DESK_TOP - 0.02, 0.67);
      for (const [x, z] of [[-0.6, 0.47], [0.6, 0.47], [-0.6, 0.87], [0.6, 0.87]] as const) {
        this.mesh(new CylinderGeometry(0.022, 0.026, DESK_TOP - 0.04, 8), wood, g).position.set(x, (DESK_TOP - 0.04) / 2, z);
      }
      const kx = KEYBOARD.x[1] - KEYBOARD.x[0], kz = KEYBOARD.z[1] - KEYBOARD.z[0];
      this.mesh(new RoundedBoxGeometry(kx, KEYBOARD.y - DESK_TOP, kz, 3, 0.02), keys, g)
        .position.set(0, (KEYBOARD.y + DESK_TOP) / 2, (KEYBOARD.z[0] + KEYBOARD.z[1]) / 2);
      const hinge = new Group();
      hinge.position.set(0, KEYBOARD.y, KEYBOARD.z[1]);
      hinge.rotation.x = 0.2; // opened a little past upright, leaning away from the character
      g.add(hinge);
      this.mesh(new RoundedBoxGeometry(kx, 0.17, 0.04, 3, 0.02), slate, hinge).position.set(0, 0.085, 0.02);
      const logo = this.mesh(new SphereGeometry(0.04, 12, 8), this.basic('#e8f1ff'), hinge, false);
      logo.scale.z = 0.3;
      logo.position.set(0, 0.09, 0.045);
      this.prop('laptop', g, f, (p) => { g.visible = p.laptop > 0.01; g.scale.setScalar(tiny(ease(p.laptop))); });
    }

    // 0s and 1s rising off the laptop.
    {
      const g = new Group();
      // they rise beside the head, never over the face
      const items = [-0.62, 0.66, -0.78, 0.8, -0.68, 0.72].map((x, i) => {
        const mat = this.basic(i % 2 ? '#5aa9ff' : '#8fd8ff');
        return { m: this.glyph(i % 2 ? '1' : '0', mat, g, 0.17, 0.08), mat, x, i, n: 6 };
      });
      this.prop('bits', g, f, (p) => {
        g.visible = p.bits > 0.01;
        for (const { m, mat, x, i, n } of items) {
          const ph = fract(p.bitsT + i / n);
          const a = fadeInOut(ph, 0.35, 0.45); // long ramps: W4-W7 give a 0/1 under ten frames of life
          m.position.set(x + Math.sign(x) * ph * 0.12, 0.55 + ph * 1.1, 0.6);
          m.scale.setScalar(tiny(0.17 * (0.5 + 0.5 * a) * p.bits));
          mat.opacity = a * p.bits;
        }
      });
    }

    // Sweat drops: each forms on the head, drips and fades. Two drops half a cycle apart, so one is always
    // clearly visible (spec §7.4.4: W3's sweat shows in every still frame).
    {
      const g = new Group();
      const pts = [[0, -0.1], [0.05, -0.07], [0.075, 0], [0.05, 0.07], [0.02, 0.15], [0, 0.2]].map(([x, y]) => new Vector2(x, y));
      const geo = this.geo(new LatheGeometry(pts, 14));
      // A drop fades out mostly by shrinking away (and paling a little), staying fairly opaque until it is tiny: a
      // light drop thinned by alpha alone reads over the dark board as a dark drop-shaped smudge (round 3 gate: W5,
      // W6, N6). `a` is its fadeInOut strength.
      const DROP = new Color('#8fd3ff'), PALE = new Color('#eaf7ff');
      const dropFade = (mat: MeshStandardMaterial, a: number) => {
        mat.opacity = 0.9 * a ** 0.35;
        mat.color.copy(DROP).lerp(PALE, 0.6 * (1 - a ** 0.35));
      };
      const drops = [0, 0.5].map((off) => {
        const mat = this.glass('#8fd3ff', 0.9);
        const m = new Mesh(geo, mat);
        g.add(m);
        return { m, mat, off };
      });
      this.prop('sweat', g, this.top, (p, c) => {
        g.visible = p.sweat > 0.01;
        const fly = p.sweatFly > 0.5;
        for (const { m, mat, off } of drops) {
          const ph = fract(p.sweatT + off);
          if (fly) {
            // W7: flung off the top corners of the head, one drop to each side, in an arc
            const side = off < 0.25 ? 1 : -1, a = fadeInOut(ph, 0.3, 0.35);
            m.scale.setScalar(tiny((0.1 + 0.9 * Math.sqrt(a)) * 1.1));
            m.position.set(side * (0.42 * c.fx + 0.42 * ph), -0.12 + 0.3 * ph - 0.42 * ph * ph, 0.25);
            m.rotation.z = -side * (0.6 + 0.9 * ph);
            dropFade(mat, a);
            continue;
          }
          const grow = ease(ph / 0.3), drip = ease((ph - 0.3) / 0.55), a = fadeInOut(ph, 0.2, 0.25);
          // it dries up as it fades: smaller and paler, never a dark ghost of a drop (round 3 gate)
          m.scale.setScalar(tiny(grow * 1.25 * (0.1 + 0.9 * (1 - ease((ph - 0.7) / 0.3)))));
          m.position.set(0.56 * c.sx, -0.1 - drip * 0.55, 0.3);
          m.rotation.z = 0;
          dropFade(mat, a);
        }
      });
    }

    // Fast, blurred hands (W3 on): no speed-line glyphs (round 3: the white dashes read as random marks). Fast typing
    // shows in the hand motion itself: a faster typing cycle (scripts.ts) and a soft smear on each hand, a pale
    // translucent stretch of the hand's own clay along its up-and-down tapping path, just behind it. W7 adds ghosted
    // hands (blurHands): fainter copies of each hand above it.
    {
      const smearGeo = this.geo(new SphereGeometry(0.085, 14, 10));
      this.smear = new MeshStandardMaterial({ color: this.base, roughness: 0.9, metalness: 0, transparent: true, opacity: 0.42, depthWrite: false });
      this.owned.push(this.smear);
      const ghostGeo = this.geo(new SphereGeometry(0.085, 12, 8));
      for (const [hand, arm] of [[this.handL, this.armL], [this.handR, this.armR]] as const) {
        const out = hand === this.handL ? -1 : 1;
        const h = new Group();
        const sm = new Mesh(smearGeo, this.smear);
        sm.scale.set(1.05, 1.9, 0.8);
        sm.position.set(0, 0.07, -0.03);
        h.add(sm);
        this.prop('fastHands', h, hand, (p) => {
          h.visible = p.fastHands > 0.01;
          h.quaternion.copy(arm.quaternion).invert(); // upright in the character's space, whatever the arm does
          h.scale.setScalar(tiny(clamp01(p.fastHands)));
        });
        const gh = new Group();
        for (const [dx, dy, s] of [[out * 0.05, 0.13, 1], [out * 0.1, 0.23, 0.85]] as const) {
          const m = new Mesh(ghostGeo, this.ghost);
          m.position.set(dx, dy, -0.02);
          m.scale.setScalar(s);
          gh.add(m);
        }
        this.prop('blurHands', gh, hand, (p) => {
          gh.visible = p.blurHands > 0.01;
          gh.quaternion.copy(arm.quaternion).invert();
        });
      }
    }

    // Steam rising off the head.
    {
      const g = new Group();
      const puffs = [0, 1, 2].map((i) => { const mat = this.basic('#ffffff', 0.5); return { i, mat, m: this.mesh(new SphereGeometry(1, 12, 8), mat, g, false) }; });
      this.prop('steam', g, this.top, (p, c) => {
        g.visible = p.steam > 0.01;
        for (const { i, mat, m } of puffs) {
          const ph = fract(p.steamT + i / 3);
          m.position.set((i - 1) * 0.2 + Math.sin(ph * Math.PI * 2 + i * 2) * 0.05, 0.1 - c.sink + ph * 0.5, 0);
          // it grows as it rises, then thins away mostly by shrinking: a big faint puff reads as a dark grey disc over the
          // dark board (round 3 gate, as the sweat drops)
          m.scale.setScalar((0.05 + 0.09 * ph) * (0.3 + 0.7 * (1 - ease((ph - 0.6) / 0.4))));
          mat.opacity = 0.7 * fadeInOut(ph, 0.35, 0.45) ** 0.4;
        }
      });
    }

    // Headphones.
    {
      const g = new Group();
      const band = this.std('#2f3b4d'), pad = this.std('#e8b54a');
      this.mesh(new TorusGeometry(0.58, 0.045, 8, 28, Math.PI), band, g).position.y = -0.34;
      for (const x of [-1, 1]) {
        const cup = this.mesh(new CylinderGeometry(0.18, 0.18, 0.14, 18), pad, g);
        cup.rotation.z = Math.PI / 2;
        cup.position.set(x * 0.6, -0.34, 0);
        const cap = this.mesh(new CylinderGeometry(0.12, 0.12, 0.05, 14), band, g);
        cap.rotation.z = Math.PI / 2;
        cap.position.set(x * 0.69, -0.34, 0);
      }
      this.prop('headphones', g, this.top, (p, c) => { g.visible = p.headphones > 0.01; g.scale.set(c.sx, c.k, c.sx); });
    }

    // Headband: a flat rounded ring round the head with two tails.
    {
      const g = new Group();
      const red = this.std('#d6403b');
      const rr = (s: Shape | Path, w: number, d: number, r: number) => {
        s.moveTo(-w / 2 + r, -d / 2);
        s.lineTo(w / 2 - r, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
        s.lineTo(w / 2, d / 2 - r); s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
        s.lineTo(-w / 2 + r, d / 2); s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
        s.lineTo(-w / 2, -d / 2 + r); s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
      };
      const outer = new Shape();
      rr(outer, BODY_W + 0.07, BODY_D + 0.07, 0.3);
      const hole = new Path();
      rr(hole, BODY_W - 0.02, BODY_D - 0.02, 0.26);
      outer.holes.push(hole);
      // high on the forehead, clear of the brows, so W6/W7's determined brows show under it
      const ring = this.mesh(new ExtrudeGeometry(outer, { depth: 0.1, bevelEnabled: false }), red, g);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = -0.23;
      ring.scale.set(0.985, 0.985, 1); // hugs the body where its top edge starts to round
      for (const [i, rz] of [[0, 0.5], [1, -0.2]] as const) {
        const tail = this.mesh(new BoxGeometry(0.34, 0.08, 0.025), red, g);
        tail.position.set(0.6 + i * 0.02, -0.18 - i * 0.07, -0.34);
        tail.rotation.set(0, 0.5, rz);
      }
      this.prop('headband', g, this.top, (p, c) => { g.visible = p.headband > 0.01; g.scale.set(c.sx, c.k, c.sx); });
    }

    // Shirt sleeves, pushed up in W1 only (a pose cue for the knuckle crack, not carried on: on bare arms they read as
    // armbands, spec §7.4.4). A blue sleeve covers the upper arm; its fat rolled edge slides from the elbow (roll = 0)
    // up to the shoulder.
    {
      const mat = this.std('#5f8fd6', 0.85);
      for (const arm of [this.armL, this.armR]) {
        const g = new Group();
        const sleeve = this.mesh(new CapsuleGeometry(0.098, 0.12, 4, 10), mat, g);
        const rollEdge = this.mesh(new TorusGeometry(0.1, 0.045, 8, 16), mat, g);
        rollEdge.rotation.x = Math.PI / 2;
        this.prop('sleeves', g, arm, (p) => {
          g.visible = p.sleeves > 0.01;
          const r = clamp01(p.roll);
          const edge = -0.3 + 0.17 * r;          // where the rolled edge sits on the arm
          rollEdge.position.y = edge;
          sleeve.scale.y = Math.max(0.05, (-edge - 0.02) / 0.32);
          sleeve.position.y = edge / 2;
          g.scale.setScalar(tiny(ease(p.sleeves)));
        });
      }
    }

    // Wristwatch on the left wrist; N3 holds that wrist up in front of its chest to read it.
    {
      const g = new Group();
      // big enough to read at board size: a white dial in a gold rim
      // a tan leather strap and brown hands: held in front of the body (N3), nothing on it is dark (spec §7.4.3)
      const strap = this.std('#9a6a44'), hands = this.std('#6b5a4a', 0.6, false), dial = this.std('#f5f3ea', 0.4), rim = this.std('#d9b24a', 0.4);
      this.mesh(new TorusGeometry(0.095, 0.03, 8, 16), strap, g).rotation.x = Math.PI / 2;
      const fc = this.mesh(new CylinderGeometry(0.14, 0.14, 0.04, 20), dial, g);
      fc.rotation.x = Math.PI / 2;
      fc.position.z = 0.12;
      this.mesh(new TorusGeometry(0.14, 0.022, 6, 20), rim, g, false).position.z = 0.14;
      this.mesh(new BoxGeometry(0.016, 0.08, 0.01), hands, g, false).position.set(0, 0.03, 0.145);
      this.mesh(new BoxGeometry(0.06, 0.016, 0.01), hands, g, false).position.set(0.022, 0, 0.145);
      g.position.y = -0.4;
      this.prop('watch', g, this.armL, (p) => { g.visible = p.watch > 0.01; });
    }

    // Hourglass, nearly empty, standing on the floor at the character's left (N6, N7): clear of the watch on the
    // left wrist (at board size a held hourglass and the watch merged into one blob), inside N7's ice.
    {
      const g = new Group();
      const wood = this.std('#8a5a3b'), sand = this.std('#e8b54a', 0.7), glassMat = this.glass('#cfe9ff', 0.4);
      const prof = [[0.02, 0], [0.2, 0], [0.2, 0.05], [0.16, 0.2], [0.04, 0.3], [0.03, 0.34], [0.04, 0.38], [0.16, 0.48], [0.2, 0.63], [0.2, 0.68], [0.02, 0.68]].map(([x, y]) => new Vector2(x, y));
      const inner = new Group();
      inner.scale.setScalar(0.72);
      inner.position.y = 0.05 * 0.72; // the bottom cap on the floor
      g.add(inner);
      g.position.set(-0.76, 0, 0.3);
      this.mesh(new LatheGeometry(prof, 18), glassMat, inner, false);
      for (const y of [-0.025, 0.705]) this.mesh(new CylinderGeometry(0.24, 0.24, 0.05, 18), wood, inner).position.y = y;
      for (const a of [0, Math.PI]) this.mesh(new CylinderGeometry(0.018, 0.018, 0.7, 6), wood, inner).position.set(Math.cos(a) * 0.22, 0.34, Math.sin(a) * 0.22);
      const topSand = this.mesh(new ConeGeometry(0.15, 0.2, 14), sand, inner, false);
      topSand.rotation.x = Math.PI;
      const pile = this.mesh(new ConeGeometry(0.17, 0.2, 14), sand, inner, false);
      const stream = this.mesh(new CylinderGeometry(0.012, 0.012, 0.3, 6), sand, inner, false);
      stream.position.y = 0.2;
      this.prop('hourglass', g, f, (p) => {
        g.visible = p.hourglass > 0.01;
        const lvl = clamp01(p.sandLevel), fill = 1 - lvl;
        topSand.scale.setScalar(tiny(lvl));
        topSand.position.y = 0.5 + 0.1 * lvl;
        pile.scale.set(tiny(0.5 + 0.5 * fill), tiny(fill), tiny(0.5 + 0.5 * fill));
        pile.position.y = 0.1 * fill + 0.03;
        stream.visible = lvl > 0;
        stream.scale.y = 0.6 + 0.4 * Math.sin(p.sandT * Math.PI * 2);
      });
    }

    // Hand bell (N4 on; gallery review note A, 2026-10-13: it replaces the "?" sign, which doubled the "?" of the
    // bubble): a brass bell on a wooden handle held upright in the right hand, swinging from the hand (bellSwing) as it
    // rings, with a clapper peeking under the rim and two short ringing arcs on its outer side. No glyph on it.
    {
      const g = new Group();
      const pivot = new Group();
      pivot.scale.setScalar(BELL_SCALE);
      g.add(pivot);
      const wood = this.std('#a47148'), brass = this.std('#e9b949', 0.35), clap = this.std('#8a5a3b', 0.6);
      // a short handle in the fist, a round knob on top; the bell hangs right under the fist
      this.mesh(new CylinderGeometry(0.04, 0.05, 0.2, 10), wood, pivot).position.y = 0.02;
      this.mesh(new SphereGeometry(0.06, 10, 8), wood, pivot).position.y = 0.13;
      const prof = [[0, -0.06], [0.06, -0.06], [0.09, -0.09], [0.11, -0.15], [0.13, -0.22], [0.17, -0.29], [0.215, -0.33], [0.225, -0.35], [0.2, -0.355]]
        .map(([x, y]) => new Vector2(x, y));
      this.mesh(new LatheGeometry(prof, 24), brass, pivot).name = 'bellBody'; // inspect().marks: the eyes test
      const clapper = new Group();
      clapper.position.y = -0.1;
      pivot.add(clapper);
      this.mesh(new CylinderGeometry(0.012, 0.012, 0.22, 6), clap, clapper, false).position.y = -0.11;
      this.mesh(new SphereGeometry(0.05, 10, 8), clap, clapper).position.y = -0.27;
      const arcs = [0, 1].map((k) => {
        const mat = this.basic('#fff1c4');
        const a = this.mesh(new TorusGeometry(0.3 + 0.08 * k, 0.017, 6, 10, BELL_ARC), mat, pivot, false);
        a.position.y = -0.22;
        a.layers.enable(PARTICLE_LAYER);
        return { a, mat, k };
      });
      this.prop('bell', g, this.handR, (p) => {
        g.visible = p.bell > 0.01;
        g.quaternion.copy(this.armR.quaternion).invert(); // upright whatever the arm does
        pivot.rotation.z = p.bellSwing;
        clapper.rotation.z = -0.6 * p.bellSwing; // the clapper lags the swing and strikes the far side
        // the arcs show on the outer side (away from the body and the face), level, as strong as the ringing
        // (bellRing: a slow envelope, so they never flash on and off with each swing), the outer one a little fainter
        for (const { a, mat, k } of arcs) {
          const v = clamp01(p.bellRing * (1 - 0.3 * k));
          a.visible = v > 0.01 && p.cold < 0.5; // frozen (N7) the bell is still: no ringing
          a.scale.setScalar(tiny(0.75 + 0.25 * v));
          a.rotation.z = 0.25 - BELL_ARC / 2 - p.bellSwing; // centred a little above level, on the bell's right
          mat.opacity = v * v;
        }
      });
    }

    // Coffee mug (W7) standing on the desk beside the laptop (round 2: both hands stay on the keys). Cream with a blue
    // band and the handle facing out; the coffee is a mid brown, never dark.
    {
      const g = new Group();
      const cream = this.std('#f1ead8', 0.6), band = this.std('#5f8fd6', 0.7), coffee = this.std('#8a5a3b', 0.4, false);
      g.position.set(0.48, DESK_TOP, 0.72);
      this.mesh(new CylinderGeometry(0.095, 0.085, 0.2, 18), cream, g).position.y = 0.1;
      this.mesh(new CylinderGeometry(0.097, 0.093, 0.05, 18), band, g, false).position.y = 0.11;
      this.mesh(new CylinderGeometry(0.08, 0.08, 0.01, 16), coffee, g, false).position.y = 0.196;
      const handle = this.mesh(new TorusGeometry(0.05, 0.02, 6, 12), cream, g);
      handle.position.set(0.1, 0.1, 0);
      this.prop('mug', g, f, (p) => { g.visible = p.mug > 0.01; });
    }

    // Tea cup on a saucer (S2), in the right hand, kept upright and sipped mid-loop; from S3 on it is set down on the
    // floor at the front left (teaDown), mirroring the alarm clock; from S4 on it sits on the stool beside the bed.
    {
      const china = this.std('#f7f4ee', 0.5), band = this.std('#7e6bd1', 0.7), tea = this.std('#c98a4b', 0.4, false);
      const cup = (parent: Group) => {
        const g = new Group();
        parent.add(g);
        this.mesh(new CylinderGeometry(0.13, 0.11, 0.025, 20), china, g).position.y = 0.012; // saucer
        const c = this.mesh(new CylinderGeometry(0.085, 0.06, 0.1, 18), china, g);
        c.position.y = 0.075;
        this.mesh(new CylinderGeometry(0.087, 0.083, 0.022, 18), band, g, false).position.y = 0.1;
        this.mesh(new CylinderGeometry(0.075, 0.075, 0.008, 16), tea, g, false).position.y = 0.122;
        const handle = this.mesh(new TorusGeometry(0.035, 0.013, 6, 10), china, g);
        handle.position.set(0.095, 0.08, 0);
        return g;
      };
      const held = new Group();
      const heldCup = cup(held);
      heldCup.position.set(-0.08, 0.02, 0.06);
      this.prop('tea', held, this.handR, (p) => {
        held.visible = p.tea > 0.01 && p.teaDown <= 0.5;
        held.quaternion.copy(this.armR.quaternion).invert();
        heldCup.scale.setScalar(tiny(ease(p.tea)));
      });
      const down = new Group();
      cup(down).scale.setScalar(1.25);
      this.prop('tea', down, f, (p) => {
        down.visible = p.tea > 0.01 && p.teaDown > 0.5;
        down.position.set(STOOL_BY_BED.x, p.stool > 0.5 && p.bed > 0.5 ? 0.24 * STOOL_BY_BED.scale : 0, STOOL_BY_BED.z);
      });
    }

    // A low wooden stool. S2 and S3 sit on it, legs forward (its seat is at hip height, so the body stays where it
    // is in every state); from S4 on it stands beside the bed, smaller, with the tea cup on it (props accumulate).
    {
      const g = new Group();
      const wood = this.std('#b07a4c'), top = this.std('#c99563');
      this.mesh(new CylinderGeometry(0.42, 0.4, 0.06, 24), top, g).position.y = 0.21;
      // legs left, right, front and back: from the front they stand clear of the character's own legs
      for (const [x, z] of [[0.34, 0], [-0.34, 0], [0, 0.34], [0, -0.34]] as const) {
        const leg = this.mesh(new CylinderGeometry(0.035, 0.045, 0.2, 8), wood, g);
        leg.position.set(x, 0.1, z);
        leg.rotation.set(z * 0.25, 0, -x * 0.25); // splayed out a little
      }
      this.prop('stool', g, f, (p) => {
        g.visible = p.stool > 0.01;
        const by = p.bed > 0.5;
        g.position.set(by ? STOOL_BY_BED.x : 0, 0, by ? STOOL_BY_BED.z : -0.05);
        g.scale.setScalar(tiny(ease(p.stool) * (by ? STOOL_BY_BED.scale : 1)));
      });
    }

    // Alarm clock ringing beside the bed (S6, S7): on the floor at the bed's front right corner, in front of the
    // blanket, so the whole clock and its ringing arcs show at board size (spec §7.4.5).
    {
      const g = new Group();
      const red = this.std('#d6564f'), dial = this.std('#f6f1e4', 0.5), ink = this.std('#2a1d1a', 0.6, false), bell = this.std('#d9b24a', 0.4);
      const inner = new Group();
      inner.position.y = 0.34;
      g.add(inner);
      this.mesh(new CylinderGeometry(0.3, 0.3, 0.2, 24), red, inner).rotation.x = Math.PI / 2;
      const fc = this.mesh(new CylinderGeometry(0.23, 0.23, 0.04, 24), dial, inner, false);
      fc.rotation.x = Math.PI / 2;
      fc.position.z = 0.1;
      this.mesh(new BoxGeometry(0.025, 0.17, 0.02), ink, inner, false).position.set(0, 0.07, 0.125);
      this.mesh(new BoxGeometry(0.13, 0.025, 0.02), ink, inner, false).position.set(0.05, 0, 0.125);
      for (const x of [-1, 1]) {
        const b = this.mesh(new SphereGeometry(0.11, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), bell, inner);
        b.position.set(x * 0.2, 0.26, 0);
        b.rotation.z = -x * 0.5;
        const leg = this.mesh(new CylinderGeometry(0.03, 0.03, 0.14, 6), ink, inner);
        leg.position.set(x * 0.17, -0.3, 0);
        leg.rotation.z = x * 0.4;
      }
      const arcs = [0, 1].map((i) => {
        const mat = this.basic('#ffd86b');
        const a = this.mesh(new TorusGeometry(0.1, 0.014, 6, 10, Math.PI / 2), mat, g, false);
        a.layers.enable(PARTICLE_LAYER);
        return { a, mat, i };
      });
      g.position.set(0.6, 0.025, 0.84); // feet on the floor, far enough back that they stay inside the square
      g.scale.setScalar(0.72);
      this.prop('alarm', g, f, (p) => {
        g.visible = p.alarm > 0.01;
        inner.rotation.z = p.alarmShake * 0.12;
        for (const { a, mat, i } of arcs) {
          const ph = fract(p.ringT + i / 2);
          a.position.set(0.1 + ph * 0.18, 0.75 + ph * 0.05, 0.1);
          a.rotation.z = -Math.PI / 4;
          a.scale.setScalar(0.7 + 0.6 * ph);
          mat.opacity = fadeInOut(ph, 0.35, 0.45);
        }
      });
    }

    // Bed (S4 on): a mattress at hip height (so the body stays where it is in every state), a wooden
    // headboard behind and a pillow behind the head that shows above and either side of the body.
    {
      const g = new Group();
      const wood = this.std('#a47148'), sheet = this.std('#eef0f6', 0.9), pillow = this.std('#fbfbff', 0.9);
      this.mesh(new RoundedBoxGeometry(1.5, 0.24, 1.3, 3, 0.06), sheet, g).position.set(0, 0.12, 0.1);
      const head = this.mesh(new RoundedBoxGeometry(1.62, 1.25, 0.1, 4, 0.05), wood, g);
      head.position.set(0, 0.62, -0.62);
      for (const x of [-1, 1]) this.mesh(new SphereGeometry(0.08, 10, 8), wood, g).position.set(x * 0.79, 1.28, -0.62);
      this.mesh(new RoundedBoxGeometry(1.42, 0.42, 0.22, 4, 0.1), pillow, g).position.set(0, 1.08, -0.5);
      this.prop('bed', g, f, (p) => { g.visible = p.bed > 0.01; });
    }

    // Blanket over the lower body, with a turned-down sheet edge. Curled up (S5) it is pulled up into a rounded mound
    // (knees drawn up) to just under the eyes: the mouth is under it, the closed eyes and the head show above it.
    {
      const g = new Group();
      const main = this.std('#7e6bd1', 0.95), edge = this.std('#eef0f6', 0.9);
      const flat = new Group(), mound = new Group();
      g.add(flat, mound);
      this.mesh(new RoundedBoxGeometry(1.56, 0.3, 1.0, 5, 0.12), main, flat).position.set(0, 0.36, 0.28);
      this.mesh(new RoundedBoxGeometry(1.6, 0.08, 0.2, 3, 0.035), edge, flat).position.set(0, 0.5, -0.05);
      this.mesh(new RoundedBoxGeometry(1.56, 0.44, 1.12, 6, 0.22), main, mound).position.set(0, 0.42, 0.2);
      const knees = this.mesh(new SphereGeometry(0.42, 18, 12), main, mound);
      knees.scale.set(1.2, 0.4, 0.7);
      knees.position.set(0.12, 0.5, 0.58); // the curled-up knees make a round hump on the blanket's front
      const turned = this.mesh(new RoundedBoxGeometry(1.5, 0.07, 0.3, 3, 0.03), edge, mound);
      turned.position.set(0, 0.64, 0.36); // turned down over the mouth, under the eyes
      turned.name = 'sheetEdge';
      this.prop('blanket', g, f, (p) => {
        g.visible = p.blanket > 0.01;
        const curled = p.curl > 0.5;
        flat.visible = !curled;
        mound.visible = curled;
      });
    }

    // Ice block with glints.
    {
      const g = new Group();
      const block = this.mesh(new RoundedBoxGeometry(1.9, 1.72, 1.3, 4, 0.14), this.glass('#bfe8ff', 0.42), g, false); // wide enough for the props beside it
      block.position.y = 0.84;
      const glints = [[-0.55, 1.4], [0.5, 0.5], [0.2, 1.55]].map(([x, y], i) => {
        const m = this.mesh(new OctahedronGeometry(0.08), this.basic('#ffffff'), g, false);
        m.position.set(x, y, 0.68);
        m.layers.enable(PARTICLE_LAYER);
        return { m, i };
      });
      this.prop('ice', g, f, (p) => {
        g.visible = p.ice > 0.01;
        // S7: deep enough for the whole bed and everything beside it (round 2: all S6 props inside the ice)
        const deep = p.bed > 0.5;
        block.scale.set(deep ? 0.97 : 1, deep ? 0.98 : 1, deep ? 1.78 / 1.3 : 1); // its front stops where the floor leaves the frame
        block.position.set(0, deep ? 0.84 * 0.98 : 0.84, deep ? 0.09 : 0);
        for (const { m, i } of glints) {
          m.position.z = deep ? 1.0 : 0.68;
          const s = Math.max(0, Math.sin((p.sparkT + i / 3) * Math.PI * 2)) ** 2; // eased in and out: no glint pops
          m.scale.set(tiny(s), tiny(2.2 * s), tiny(0.4 * s));
          (m.material as MeshBasicMaterial).opacity = s;
        }
      });
    }

    // Battery cap (X3): a metal terminal on top of the head; the body below it is the battery, its charge shown as
    // body colour over grey (the charge mesh, in apply()).
    {
      const g = new Group();
      const metal = this.std('#c3c8d2', 0.35, false), rim = this.std('#8b93a1', 0.45, false);
      this.mesh(new CylinderGeometry(0.17, 0.19, 0.1, 24), metal, g).position.y = 0.04;
      this.mesh(new TorusGeometry(0.18, 0.02, 6, 24), rim, g, false).rotation.x = Math.PI / 2;
      this.prop('battery', g, this.top, (p, c) => { g.visible = p.battery > 0.01; g.scale.set(c.sx, c.k, c.sx); });
    }

    // The compacting press (X4): a teal plate on a rod that comes down on the head and squashes it.
    {
      const g = new Group();
      const teal = this.std('#4fd1c5', 0.6), steel = this.std('#8b93a1', 0.5);
      this.mesh(new RoundedBoxGeometry(1.2, 0.12, 0.8, 3, 0.05), teal, g).position.y = 0.06;
      this.mesh(new CylinderGeometry(0.06, 0.06, 0.28, 10), steel, g).position.y = 0.26; // short, so it stays in frame
      this.prop('press', g, f, (p, c) => {
        g.visible = p.press > 0.01;
        // it rests just above the head and touches it while the body is squashed
        g.position.y = LEG + p.bodyY + c.top - c.sink + 0.24 * clamp01(1 + p.squash / 0.3);
      });
    }

    // Zzz. The big ones (S4 on) rise less, so the top Z stays inside the 96 px square, and frozen (S7) they
    // are smaller and lower again, inside the ice block with the character.
    {
      const g = new Group();
      const items = [0, 1, 2].map((i) => { const mat = this.basic('#cbbcff'); return { m: this.glyph('Z', mat, g, 0.2, 0.09), mat, i }; });
      this.prop('zzz', g, this.top, (p, c) => {
        g.visible = p.zzz > 0.01;
        const cold = clamp01(p.cold);
        const big = (1 + 0.6 * p.zzzBig) * (1 - 0.3 * cold);
        const rise = (0.55 - 0.15 * p.zzzBig) * (1 - 0.5 * cold);
        for (const { m, mat, i } of items) {
          const ph = fract(p.zzzT + i / 3);
          m.position.set((0.42 + ph * 0.3 * (1 - 0.5 * cold)) * c.fx, 0.05 - c.sink + ph * rise, 0.2);
          m.rotation.z = 0.2 - ph * 0.3;
          m.scale.setScalar(tiny((0.1 + 0.14 * ph) * big * p.zzz));
          mat.opacity = fadeInOut(ph, 0.25, 0.3);
          if (i === 1 && this.debugPass.zFlash) { mat.opacity = 1; m.scale.setScalar(tiny(0.24 * big * p.zzz)); }
        }
      });
    }

    // "?" speech bubble.
    {
      const g = new Group();
      const white = this.std('#fbf8f0', 0.5), ink = this.std('#2a1d1a', 0.6, false);
      const ball = this.mesh(new SphereGeometry(0.32, 20, 14), white, g);
      ball.scale.set(1, 1, 0.38);
      ball.name = 'bubble';
      const tail = this.mesh(new ConeGeometry(0.09, 0.24, 10), white, g);
      tail.position.set(-0.2, -0.3, 0);
      tail.rotation.z = 0.7;
      this.glyph('?', ink, g, 0.3, 0.075).position.z = 0.13;
      this.prop('qbubble', g, this.top, (p, c) => {
        g.visible = p.qbubble > 0.01;
        // frozen (N7): smaller and lower, inside the ice with the character
        const cold = clamp01(p.cold);
        g.position.set(0.56 * c.fx + 0.06 - 0.06 * cold, 0.27 - 0.05 * cold - c.sink, 0.15); // low enough to stay in the square as it bobs
        g.scale.setScalar(tiny(ease(p.qbubble) * (1 - 0.2 * cold)));
      });
    }

    // S6 on: a speech bubble, startled by the alarm ("!"), up by the head on the left, its tail towards the mouth.
    // Frozen (S7) it is smaller and lower, inside the ice with everything else.
    {
      const g = new Group();
      const white = this.std('#fbf8f0', 0.5), ink = this.std('#2a1d1a', 0.6, false);
      const ball = this.mesh(new SphereGeometry(0.27, 20, 14), white, g);
      ball.scale.set(1.15, 0.9, 0.38);
      ball.name = 'speech';
      const tail = this.mesh(new ConeGeometry(0.08, 0.22, 10), white, g);
      tail.position.set(0.2, -0.25, 0);
      tail.rotation.z = -0.7;
      this.glyph('!', ink, g, 0.36, 0.085).position.z = 0.11;
      this.prop('speech', g, this.top, (p, c) => {
        g.visible = p.speech > 0.01;
        const cold = clamp01(p.cold);
        g.position.set(-0.62 * c.fx, 0.18 - 0.12 * cold, 0.3);
        g.scale.setScalar(tiny(ease(p.speech) * (1 - 0.15 * cold)));
      });
    }

    // A floating "?" over the head (spare: every N state carries the "?" bubble; spec §7.4.2).
    {
      const g = new Group();
      const amber = this.std('#f5b544', 0.5, false);
      this.glyph('?', amber, g, 0.34, 0.12);
      this.prop('qmark', g, this.top, (p, c) => {
        g.visible = p.qmark > 0.01;
        g.position.set(0.3 * c.fx, 0.3 - 0.14 * clamp01(p.cold) + 0.05 * Math.sin(p.qmarkT * Math.PI * 2), 0.2); // inside the ice when frozen
        g.rotation.z = -0.15;
        g.scale.setScalar(tiny(ease(p.qmark)));
      });
    }

    // Sparkle (S1 only): a cluster of four-point stars over the middle of its head, between the stretching arms, the
    // big one always lit and pulsing, the small ones twinkling in turn. No check mark (gallery review note C,
    // 2026-10-13: no tick in any S state), so it is S1's own look, not a prop carried along the asleep timeline. (Round 3
    // gate: a star by the head's corner sat on the raised left arm, and one below it on the head read as a decal.)
    {
      const g = new Group();
      const star = (x: number, y: number, r: number) => {
        const mat = this.basic('#fff6c2');
        const s = new Group();
        s.position.set(x, y, 0.05);
        for (const [sx, sy] of [[1, 2.4], [2.4, 1]]) this.mesh(new OctahedronGeometry(r), mat, s, false).scale.set(sx, sy, 0.3);
        s.traverse((o) => o.layers.enable(PARTICLE_LAYER));
        g.add(s);
        return { s, mat };
      };
      const big = star(0, 0.1, 0.05);
      const small = [[-0.3, 0.0], [0.3, 0.04], [0.14, 0.26]].map(([x, y], i) => ({ ...star(x, y, 0.032), i }));
      this.prop('sparkle', g, this.top, (p) => {
        g.visible = p.sparkle > 0.01;
        g.position.set(-0.04, 0.24 - 0.16 * clamp01(p.cold), 0.2);
        const pop = ease(p.sparkle);
        // whole cycles per loop, so the loop seam never pops a star (round 3)
        const pulse = (0.75 + 0.25 * Math.cos(p.sparkT * Math.PI * 4)) * pop;
        big.s.scale.setScalar(tiny(pulse));
        big.mat.opacity = pop;
        for (const { s, mat, i } of small) {
          const tw = Math.max(0, Math.sin((p.sparkT + i / 3) * Math.PI * 2)) ** 2 * pop; // one slow twinkle a loop, eased
          s.scale.setScalar(tiny(tw));
          mat.opacity = tw * tw; // a star twinkles in and out: it fades as it grows and shrinks
        }
      });
    }

    // Knock ripples on the "glass" between the character and you.
    {
      const g = new Group();
      // three rings a third of a cycle apart, so one is always fresh enough to see in a still
      const rings = [0, 1, 2].map((i) => { const mat = this.basic('#ffffff'); return { r: this.mesh(new TorusGeometry(0.14, 0.016, 6, 24), mat, g, false), mat, i }; });
      this.prop('knock', g, f, (p) => {
        g.visible = p.knock > 0.01;
        g.position.set(0.6, 0.78, 0.98 - 0.36 * clamp01(p.cold)); // frozen (N7): just inside the ice's front face
        for (const { r, mat, i } of rings) {
          const ph = fract(p.knockT + i / 3);
          r.scale.setScalar(0.5 + ph);
          mat.opacity = 0.9 * fadeInOut(ph, 0.2, 0.6);
        }
      });
    }

    // "Full" gauge for the X2 modifier.
    {
      const g = new Group();
      const dial = this.std('#f6f1e4', 0.5), rim = this.std('#4b5160'), ink = this.std('#2a1d1a', 0.6, false);
      this.mesh(new CylinderGeometry(0.27, 0.27, 0.06, 24), dial, g).rotation.x = Math.PI / 2;
      this.mesh(new TorusGeometry(0.27, 0.035, 8, 24), rim, g).position.z = 0.02;
      for (const [c, a, b] of [['#59c97b', 0, 0.5], ['#f5b544', 0.5, 0.78], ['#d6403b', 0.78, 1]] as const) {
        const arc = this.mesh(new TorusGeometry(0.19, 0.035, 6, 12, (b - a) * Math.PI * (2 / 3)), this.std(c, 0.6, false), g, false);
        arc.rotation.z = Math.PI * (5 / 6) - b * Math.PI * (2 / 3);
        arc.position.z = 0.04;
      }
      const needle = new Group();
      this.mesh(new BoxGeometry(0.2, 0.03, 0.02), ink, needle, false).position.x = 0.09;
      this.mesh(new SphereGeometry(0.035, 8, 6), ink, needle, false);
      needle.position.z = 0.06;
      g.add(needle);
      this.glyph('F', ink, g, 0.1, 0.07).position.set(0, -0.12, 0.05);
      this.prop('gauge', g, this.top, (p, c) => {
        g.visible = p.gauge > 0.01;
        // top right, or (N states) top left, so it never hides the "?" bubble; a squashed (X4) body is wide: the gauge
        // stays in the frame
        const fx = Math.min(c.fx, 1.1);
        const nq = p.qbubble > 0.5;
        if (nq) g.position.set(-0.72 * fx, 0.3 - 0.22 * clamp01(p.cold), 0.25);
        else g.position.set(0.7 * fx, 0.14, 0.25);
        g.scale.setScalar(nq ? 0.56 : 0.72); // smaller beside the "?" states' other props
        needle.rotation.z = Math.PI * (5 / 6) - clamp01(p.gaugeV) * Math.PI * (2 / 3);
      });
    }
  }

  // ---------- face keys (spec §7.2: the face escalates one way along each timeline) ----------

  /**
   * Face keys are drawn as small clay pieces on the face: lids in the body's own clay (so they follow its colour
   * and tint), soft bags lighter than the body, angry brows, a red anger puff by the head, white eye whites, and a
   * snore bubble. None is dark below the mouth (spec §7.4.3).
   */
  private buildFace() {
    const lidGeo = this.geo(new SphereGeometry(0.096, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)); // top cap, flat edge at y = 0
    /** One lid set per eye. `upper`: [edge y, tilt towards the outer corner]; `lower`: edge y of a lower lid, if any. */
    const lids = (name: 'narrowEyes' | 'flatEyes', upper: [number, number], lower?: number) => {
      const g = new Group();
      const per = this.eyes.map(({ side }) => {
        const eye = new Group();
        g.add(eye);
        const up = new Mesh(lidGeo, this.clay);
        up.scale.set(1.08, 1, 0.6);
        up.position.y = upper[0];
        up.rotation.z = -side * upper[1];
        eye.add(up);
        if (lower !== undefined) {
          const lo = new Mesh(lidGeo, this.clay);
          lo.scale.set(1.08, 1, 0.6);
          lo.rotation.z = Math.PI;
          lo.position.y = lower;
          eye.add(lo);
        }
        return eye;
      });
      this.prop(name, g, this.face, (p) => {
        g.visible = p[name] > 0.5 && p.xEyes <= 0.5;
        per.forEach((eye, i) => eye.position.copy(this.eyes[i].bead.position).setZ(FACE_Z + 0.002));
      });
    };
    // W3+ in the zone: a slit between an upper lid (inner corners down, focused) and a lower lid
    lids('narrowEyes', [LIDS.narrowEyes.up, LIDS.narrowEyes.tilt], LIDS.narrowEyes.low);
    // N3 bored: flat half-lids
    lids('flatEyes', [LIDS.flatEyes.up, LIDS.flatEyes.tilt]);

    // N6+ wide eyes: the same bead eyes (round 2: never eye whites), with thin arched lids lifted off them
    {
      const g = new Group();
      const geo = this.geo(new TorusGeometry(0.115, 0.014, 6, 16, Math.PI * 0.8));
      const arcs = this.eyes.map(() => {
        const m = new Mesh(geo, this.ink);
        m.rotation.z = Math.PI * 0.1; // the arc's middle at the top
        g.add(m);
        return m;
      });
      this.prop('wideEyes', g, this.face, (p) => {
        g.visible = p.wideEyes > 0.5 && p.xEyes <= 0.5;
        arcs.forEach((m, i) => m.position.copy(this.eyes[i].bead.position).add(new Vector3(0, -0.01, 0.006)));
      });
    }

    // N4+ brows down: thick angry brows, inner ends low (they replace the normal brows)
    {
      const g = new Group();
      const geo = this.geo(new CapsuleGeometry(0.028, 0.14, 4, 8));
      const brows = this.eyes.map(({ side }) => {
        const m = new Mesh(geo, this.ink);
        m.rotation.z = Math.PI / 2 + side * 0.5;
        g.add(m);
        return { m, side };
      });
      this.prop('browsDown', g, this.face, (p, c) => {
        g.visible = p.browsDown > 0.5 && p.xEyes <= 0.5;
        for (const { m, side } of brows) m.position.set(side * 0.19, 0.235 * c.sy, FACE_Z + 0.012);
      });
    }

    // N5+ anger puff: the cartoon cross of four red arcs, floating by the top left corner of the head
    {
      const g = new Group();
      const red = this.std('#e0453c', 0.6, false);
      const arc = this.geo(new TorusGeometry(0.07, 0.02, 6, 8, Math.PI / 2));
      for (const [qx, qy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
        const m = new Mesh(arc, red);
        m.position.set(qx * 0.1, qy * 0.1, 0);
        m.rotation.z = Math.atan2(-qy, -qx) - Math.PI / 4; // each arc bows away from the centre
        g.add(m);
      }
      this.prop('angerPuff', g, this.top, (p, c) => {
        g.visible = p.angerPuff > 0.5;
        g.position.set(-0.47 * c.sx, 0.02, FACE_Z * c.sx - 0.05);
      });
    }

    // S5+ snore bubble: a big pale-blue bubble with a darker blue rim and a white glint, swelling and shrinking once
    // per loop. Curled up (S5) the face is under the blanket, so it swells from the sheet edge, in front of the
    // purple blanket and clear of the white pillow; otherwise (S6, S7) it sits beside the mouth.
    {
      const bubble = () => {
        const g = new Group();
        this.mesh(new SphereGeometry(1, 18, 14), this.glass('#9fdcff', 0.8), g, false);
        const rim = this.mesh(new TorusGeometry(1, 0.07, 6, 28), this.basic('#2f7fd0', 0.95), g, false);
        rim.position.z = 0.02;
        const hi = this.mesh(new SphereGeometry(0.24, 8, 6), this.basic('#ffffff', 0.95), g, false);
        hi.position.set(-0.4, 0.4, 0.8);
        return { g };
      };
      const size = (t: number) => 0.1 + 0.08 * (0.5 - 0.5 * Math.cos(Math.PI * 2 * t));
      const byMouth = bubble();
      this.prop('snore', byMouth.g, this.face, (p, c) => {
        byMouth.g.visible = p.snore > 0.5 && p.curl <= 0.5;
        // small, at the corner of the mouth and out past the cheek, so it never covers the face
        const r = 0.75 * size(p.snoreT);
        byMouth.g.scale.setScalar(r);
        byMouth.g.position.set(0.2 + r, -0.08 * c.sy, FACE_Z + 0.04);
      });
      const fromSheet = bubble();
      this.prop('snore', fromSheet.g, this.figure, (p) => {
        fromSheet.g.visible = p.snore > 0.5 && p.curl > 0.5;
        const r = 0.9 * size(p.snoreT);
        fromSheet.g.scale.setScalar(r);
        fromSheet.g.position.set(0.1 + r, 0.6 + 0.3 * r, 0.56); // swells from the sheet edge, where the mouth is under it
      });
    }
  }

  // ---------- posing ----------

  /**
   * Pose the character for one frame. `colour` is the body colour, "#rrggbb". `authored`: the state's prop and glyph
   * overrides (spec §7.4.7), applied after the character places them itself.
   */
  apply(p: Pose, colour: string, authored?: Authored): void {
    const puffed = p.puff > 0.5;
    const k = puffed ? INFLATE : 1; // X2: the same body uniformly inflated (round 2)
    const sy = Math.max(0.3, 1 + p.squash);
    const sx = (1 / Math.sqrt(sy)) * k; // keep the volume: squash wide, stretch thin
    const top = BODY_H * sy * k;
    const sink = ((k - 1) * BODY_H * sy) / 2; // X2 inflates about the body's middle: it stays where it stood
    const c: Ctx = { sx, sy, k, fx: sx / k, top: top - sink, sink };

    this.base.set(colour);
    this.tint.copy(this.base).lerp(this.grey, clamp01(p.grey)).lerp(this.frost, 0.55 * clamp01(p.cold));
    this.clay.color.copy(this.tint);
    this.ghost.color.copy(this.tint).lerp(new Color('#ffffff'), 0.5); // paler than the body: a blur, seen over it
    this.smear.color.copy(this.tint).lerp(new Color('#ffffff'), 0.35); // the hands' smear: their own clay, a little paler

    this.figure.rotation.z = p.lie * (Math.PI / 2);
    this.figure.position.set(p.lie * 0.62, p.lie * 0.52, 0);
    this.upper.position.set(p.bodyX, LEG + p.bodyY, 0);
    this.upper.rotation.set(p.nod, p.turn, p.lean);
    this.body.geometry = puffed ? this.puffGeo : this.bodyGeo;
    this.body.scale.set(sx, sy * k, sx);
    this.body.position.y = top / 2 - sink;
    this.top.position.y = top - sink;

    // X3: the battery's charge, orange up to `charge` of the character's full height from the feet (legs, then the
    // bottom of the body), a bright fill line on top, grey above; the band dims and brightens slowly (chargeT)
    const charging = p.battery > 0.5;
    this.chargeU.on.value = charging ? 1 : 0;
    if (charging) {
      const glow = 0.5 + 0.5 * Math.cos(Math.PI * 2 * p.chargeT);
      this.chargeU.col.value.copy(CHARGE_COL).multiplyScalar(0.45 + 0.55 * glow);
      this.chargeU.line.value.copy(CHARGE_LINE_COL).multiplyScalar(0.7 + 0.3 * glow);
      // world space: the character stands at the scene origin, upright (X3 does not lie down)
      const head = LEG + p.bodyY + top - sink;
      this.chargeY = FEET + (head - FEET) * clamp01(p.charge);
      this.chargeU.y.value = this.chargeY;
    }

    for (const [arm, ax, az, side] of [[this.armL, p.aLx, p.aLz, -1], [this.armR, p.aRx, p.aRz, 1]] as const) {
      const inward = clamp01(-az); // arms crossing the body come forward so they stay in front of it
      const reach = clamp01(p.reach); // typing: the shoulders lower and forward, the arms reach down to the keys
      arm.position.set(side * (0.5 * sx + 0.05 - REACH.in * reach), top * SHOULDER - sink - 0.22 * inward - REACH.down * reach,
        inward * (k * BODY_D / 2 + 0.06) + REACH.fwd * reach);
      arm.rotation.set(ax, 0, side * az);
    }
    for (const [leg, lx, lz, side] of [[this.legL, p.lLx, 0, -1], [this.legR, p.lRx, p.lRz, 1]] as const) {
      leg.position.set(side * 0.22 * sx, 0, 0);
      leg.rotation.set(lx, 0, side * lz);
    }

    // face: it lives on the body, so the body's squash scale applies to it; undo it on the features
    this.face.scale.set(1, 1 / sy, 1);
    this.face.position.set(0, 0, 0);
    for (const ch of this.cheeks) ch.visible = puffed;
    const open = Math.max(0.06, p.eyeOpen);
    const crossed = p.xEyes > 0.5;
    const dbg = this.debugPass;
    this.eyes.forEach(({ bead, cross, side }, i) => {
      bead.visible = !crossed;
      cross.visible = crossed;
      bead.scale.set(1, open, 0.6); // the same bead eyes in every state (round 2)
      bead.position.set(side * 0.2 + p.lookX * 0.05, (0.1 + p.lookY * 0.05) * sy, FACE_Z + 0.005);
      // the catch-light fades out as the lid comes down (round 3): none on a shut or nearly shut eye
      const { h, legacy, mat } = this.highlights[i];
      const glint = ease((open - 0.25) / 0.35);
      placeHighlight(h, side, open, p);
      h.visible = !dbg.legacyHighlight;
      legacy.visible = !!dbg.legacyHighlight;
      if (dbg.pass === 'highlight') { mat.color.set('#ff00ff'); mat.opacity = glint > 0.01 || dbg.forceGlint ? 1 : 0; }
      else { mat.color.set('#ffffff'); mat.opacity = glint; }
      if (dbg.pass === 'eyes') h.visible = legacy.visible = false;
      bead.material = dbg.pass === 'eyes' ? this.flatMat('#0000ff') : this.beadMat;
    });
    const b = Math.max(-1, Math.min(1, p.brow));
    // brows grow in and shrink away as |brow| passes 0.03-0.2, never switched on or off in one frame (the W1 and X4
    // ramps; every state that holds its brows holds them at 0.4 or more, full size)
    const browSize = ease((Math.abs(b) - 0.03) / 0.17);
    this.brows.forEach((br, i) => {
      const side = i === 0 ? -1 : 1;
      br.visible = browSize > 0.01 && !crossed && p.browsDown <= 0.5;
      br.scale.setScalar(Math.max(0.01, browSize));
      // worried brows lift; determined brows press down onto the eyes (clear of W6/W7's headband)
      br.position.set(side * 0.2, (0.27 + (b < 0 ? 0.03 * -b : -0.06 * b)) * sy, FACE_Z + 0.01);
      br.rotation.set(0, 0, Math.PI / 2 + side * b * 0.45);
    });
    const mc = Math.max(-1, Math.min(1, p.mouthCurve));
    const oShown = p.mouthOpen > 0.03;
    this.mouth.visible = !oShown;
    this.mouth.rotation.z = mc >= 0 ? Math.PI : 0;
    this.mouth.scale.set(1, Math.max(0.06, Math.abs(mc)), 1);
    this.mouth.position.y = (-0.1 + (mc >= 0 ? 0.08 * Math.abs(mc) : -0.02)) * sy;
    this.mouthO.visible = oShown;
    const o = clamp01(p.mouthOpen);
    this.mouthO.scale.set(0.8 + 0.6 * o, 0.5 + 0.8 * o, 0.5); // a tiny closed oval: at most 0.1 wide, 0.07 tall
    this.mouthO.position.y = -0.1 * sy;

    for (const { m } of this.glyphMeshes) restore(m, this.rests.get(m)!);
    for (const pr of this.props) {
      restore(pr.group, this.rests.get(pr.group)!);
      pr.update(p, c);
      const x = authored?.props[pr.group.name as keyof Authored['props']];
      if (x) {
        pr.group.position.add(new Vector3(x.x, x.y, x.z));
        pr.group.rotateZ(x.rot);
        pr.group.scale.multiplyScalar(x.scale);
      }
    }
    // glyph offsets are in the glyph's own units: turned and scaled with it
    for (const { m, key } of this.glyphMeshes) {
      const g = authored?.glyphs[key];
      if (!g) continue;
      m.position.add(new Vector3(g.dx * m.scale.x, g.dy * m.scale.y, 0).applyAxisAngle(new Vector3(0, 0, 1), m.rotation.z));
      m.scale.multiplyScalar(g.scale);
    }
  }

  /**
   * For tests (spec §7.4): the body's bounding box in the character's own space, as last posed, and the
   * meshes that receive a shadow (none may: a shadow on the body reads as a beard or a chin strap).
   */
  inspect(): Inspection {
    this.root.updateMatrixWorld(true);
    const g = this.body.geometry;
    g.computeBoundingBox();
    const shadowed: string[] = [];
    this.root.traverse((o) => { if ((o as Mesh).isMesh && o.receiveShadow) shadowed.push(o.name || o.type); });

    // A mesh can be seen when it and its parents are visible, it is not shrunk to nothing and not faded out.
    const seen = (o: Mesh) => {
      for (let a: Object3D | null = o; a; a = a.parent) if (!a.visible) return false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.every((m) => m.transparent && m.opacity < 0.3)) return false;
      const size = worldBox(o).getSize(new Vector3());
      return Math.max(size.x, size.y, size.z) >= 0.08;
    };
    const shown = new Set<string>();
    const props: Record<string, Box3> = {};
    for (const pr of this.props) {
      pr.group.traverse((o) => {
        if (!(o as Mesh).isMesh || !seen(o as Mesh)) return;
        const name = pr.group.name;
        shown.add(name);
        (props[name] ??= new Box3()).union(worldBox(o as Mesh));
      });
    }

    // The face in the body's own frame: what is dark, on the front of the body, under the mouth (spec §7.4.3).
    const toBody = this.body.matrixWorld.clone().invert();
    const local = (m: Mesh) => {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      return m.geometry.boundingBox!.clone().applyMatrix4(toBody.clone().multiply(m.matrixWorld));
    };
    const mouths = [this.mouth, this.mouthO].filter((m) => seen(m));
    const mouthBox = new Box3();
    for (const m of mouths) mouthBox.union(local(m));
    const front = g.boundingBox!.max.z;
    const belowMouth: string[] = [];
    if (mouths.length) {
      const mid = (mouthBox.min.y + mouthBox.max.y) / 2;
      this.root.traverse((o) => {
        const m = o as Mesh;
        if (!m.isMesh || mouths.includes(m) || m === this.body || !seen(m) || !dark(m)) return;
        const b = local(m);
        const cy = (b.min.y + b.max.y) / 2;
        const onFace = b.max.x > -0.3 && b.min.x < 0.3 && b.max.z >= front - 0.06 && b.max.y > -BODY_H / 2 - 0.05;
        if (onFace && cy < mid && b.min.y < mouthBox.min.y - 0.01) belowMouth.push(m.parent?.name || m.geometry.type);
      });
    }
    const hands = [this.handL, this.handR].map((h) => h.getWorldPosition(new Vector3()));
    const shownEyes = this.eyes.filter(({ bead }) => seen(bead));
    const eyeAt = shownEyes.map(({ bead }) => local(bead).getCenter(new Vector3()));
    const nearEyes: string[] = [];
    this.root.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh || !seen(m) || shownEyes.some(({ bead }) => m === bead || m.parent === bead) || lightness(m) < 0.75) return;
      const b = local(m), size = b.getSize(new Vector3()), c = b.getCenter(new Vector3());
      if (Math.max(size.x, size.y) > 0.35 || b.max.z < front - 0.06 || b.max.z > front + 0.06) return; // on the face itself
      if (eyeAt.some((e) => Math.hypot(c.x - e.x, c.y - e.y) < 0.06)) nearEyes.push(m.parent?.name || m.name || m.geometry.type);
    });
    const marks: Record<string, Box3[]> = {};
    this.root.traverse((o) => { const m = o as Mesh; if (m.isMesh && m.name && seen(m)) (marks[m.name] ??= []).push(worldBox(m)); });
    const glyphs: Inspection['glyphs'] = {};
    for (const { m, key } of this.glyphMeshes) if (seen(m)) (glyphs[key] ??= []).push(worldBox(m));
    const kind = !mouths.length ? 'none' : mouths[0] === this.mouthO ? 'o' : 'line';
    return {
      body: g.boundingBox!.clone().applyMatrix4(this.body.matrixWorld),
      shadowed, shown: [...shown].sort(), hands, props, glyphs, marks, nearEyes,
      eyes: shownEyes.map(({ bead }) => ({ at: bead.getWorldPosition(new Vector3()), bead: bead.scale.x })),
      glyphParts: [...new Set(this.glyphMeshes.map((g) => g.key))].sort(),
      parts: [...new Set(this.props.map((pr) => pr.group.name))].sort(),
      mouth: (mouths[0] ?? this.mouth).getWorldPosition(new Vector3()),
      ...(this.chargeU.on.value ? { charge: { level: this.chargeY, feet: FEET, head: this.top.getWorldPosition(new Vector3()).y } } : {}),
      face: {
        mouths: mouths.length, mouthKind: kind,
        mouthWidth: mouths.length ? mouthBox.max.x - mouthBox.min.x : 0,
        mouthHeight: mouths.length ? (mouthBox.max.y - mouthBox.min.y) * this.body.scale.y : 0,
        lineThickness: 2 * MOUTH_TUBE * this.mouth.scale.x,
        belowMouth,
      },
    };
  }

  dispose(): void {
    this.owned.forEach((d) => d.dispose());
    this.owned = [];
  }
}
