import {
  BufferGeometry, CylinderGeometry, Matrix4, Quaternion, SphereGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Symbols are drawn as rolled clay snakes: a chain of short cylinders with round joints.
 * No fonts, so the glyphs look the same on every machine. Coordinates are in a box about
 * 0.6 wide and 1 tall, centred on the origin.
 */
export type GlyphName = '?' | '0' | '1' | 'Z' | 'F' | '!'; // no check mark (gallery review note C)

const ellipse = (n: number, rx: number, ry: number): number[][] =>
  Array.from({ length: n + 1 }, (_, i) => [Math.sin((i / n) * Math.PI * 2) * rx, Math.cos((i / n) * Math.PI * 2) * ry]);

const STROKES: Record<GlyphName, number[][][]> = {
  '?': [[[-0.24, 0.58], [-0.2, 0.78], [-0.08, 0.9], [0.1, 0.92], [0.24, 0.82], [0.27, 0.64], [0.18, 0.46], [0.02, 0.32], [0, 0.14]], [[0, -0.1], [0, -0.1]]],
  '0': [ellipse(14, 0.26, 0.46)],
  '1': [[[-0.2, 0.28], [0, 0.48], [0, -0.48]]],
  Z: [[[-0.28, 0.44], [0.28, 0.44], [-0.28, -0.44], [0.28, -0.44]]],
  F: [[[0.24, 0.46], [-0.2, 0.46], [-0.2, -0.46]], [[-0.2, 0.0], [0.14, 0.0]]],
  '!': [[[0, 0.46], [0, -0.16]], [[0, -0.44], [0, -0.44]]],
};

const cache = new Map<string, BufferGeometry>();

/** One merged geometry per glyph, thickness `r` (default 0.085). Shared; do not dispose. */
export function glyphGeometry(name: GlyphName, r = 0.085): BufferGeometry {
  const key = `${name}:${r}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const parts: BufferGeometry[] = [];
  const up = new Vector3(0, 1, 0);
  for (const stroke of STROKES[name]) {
    for (let i = 0; i < stroke.length; i++) {
      const [x, y] = stroke[i];
      const ball = new SphereGeometry(r, 8, 6);
      ball.translate(x, y, 0);
      parts.push(ball);
      if (i === 0) continue;
      const [px, py] = stroke[i - 1];
      const a = new Vector3(px, py, 0);
      const b = new Vector3(x, y, 0);
      const len = a.distanceTo(b);
      if (len < 1e-6) continue;
      const cyl = new CylinderGeometry(r, r, len, 8, 1, true);
      const q = new Quaternion().setFromUnitVectors(up, b.clone().sub(a).normalize());
      cyl.applyMatrix4(new Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new Vector3(1, 1, 1)));
      parts.push(cyl);
    }
  }
  const geo = mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
  parts.forEach((p) => p.dispose());
  cache.set(key, geo);
  return geo;
}
