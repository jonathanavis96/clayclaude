/** mulberry32: the renderer's only source of "randomness", so every frame is repeatable. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Greyscale RGBA pixels for the clay bump map: soft value noise (thumb dents) plus a little grain.
 * Pure and deterministic, so baked sheets and snapshots are repeatable.
 */
export function clayNoise(n = 128, grid = 16, seed = 20261012): Uint8Array {
  const rnd = seeded(seed);
  const g = Array.from({ length: grid * grid }, () => rnd());
  const at = (x: number, y: number) => g[(((y % grid) + grid) % grid) * grid + (((x % grid) + grid) % grid)];
  const s = (x: number) => x * x * (3 - 2 * x);
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const gx = (x / n) * grid, gy = (y / n) * grid;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const fx = s(gx - x0), fy = s(gy - y0);
    const v = at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
    const c = Math.round(255 * (0.7 * v + 0.3 * rnd()));
    const i = (y * n + x) * 4;
    out[i] = out[i + 1] = out[i + 2] = c;
    out[i + 3] = 255;
  }
  return out;
}
