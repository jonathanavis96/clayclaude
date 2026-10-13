import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vector3 } from 'three';
import { Character } from '../web/src/clay/character.js';
import { GLYPH_KEYS, PROP_NAMES, parseOverrides, serializeOverrides } from '../web/src/clay/override-schema.js';
import { applyOverrides, authoredFor, evalTrack, getOverrides, loadOverrides, setOverrides } from '../web/src/clay/overrides.js';
import { applyPuff, evalScript, POSE_KEYS, type Pose } from '../web/src/clay/pose.js';
import { FROZEN, SCRIPTS } from '../web/src/clay/scripts.js';
import { CLAY_STATES, type ClayStateId } from '../web/src/clay/states.js';
import { frameCount, frameTime, poseFor, puffCycles, resolvePlayback } from '../web/src/clay/timeline.js';
import { clayVersion } from '../web/clay-version.js';
import { MAX_BODY, OVERRIDES_FILE, overridesHandler } from '../web/clay-overrides-plugin.js';

const ROOT = join(import.meta.dirname, '..');
/** The pose as derived, without the override layer (script, then the X2 modifier). */
const derived = (id: ClayStateId, t: number, puffed: boolean): Pose => {
  const p = evalScript(SCRIPTS[id], t);
  if (id === 'X1') return p;
  return puffed || id === 'X2' ? applyPuff(p, t, puffCycles(id), FROZEN.has(id)) : p;
};

describe('authored-override layer (spec §7.4.7)', () => {
  const saved = getOverrides();
  afterEach(() => setOverrides(saved));

  it('the committed overrides.json is valid, sorted and pretty-printed as the editor writes it', () => {
    const text = readFileSync(join(ROOT, 'web', 'src', 'clay', 'overrides.json'), 'utf8');
    const { value, errors } = parseOverrides(JSON.parse(text), { ranges: true });
    expect(errors).toEqual([]);
    expect(serializeOverrides(value)).toBe(text);
  });

  it('with no overrides ({}) every pose of every state is exactly the derived one', () => {
    setOverrides({});
    for (const id of CLAY_STATES) for (const puffed of [false, true]) for (let i = 0; i < frameCount(id); i++) {
      const t = frameTime(id, i);
      expect(poseFor(id, t, puffed), `${id} ${i}`).toEqual(derived(id, t, puffed));
    }
    expect(authoredFor('N1')).toEqual({ props: {}, glyphs: {} });
  });

  it('a constant pose override replaces the key in every frame and leaves the others alone', () => {
    setOverrides({ W2: { pose: { aRx: 0.4 } } });
    for (let i = 0; i < frameCount('W2'); i++) {
      const t = frameTime('W2', i);
      const p = poseFor('W2', t, false), d = derived('W2', t, false);
      expect(p.aRx).toBe(0.4);
      expect(POSE_KEYS.filter((k) => k !== 'aRx' && p[k] !== d[k])).toEqual([]);
    }
    expect(poseFor('W3', 0, false)).toEqual(derived('W3', 0, false));
  });

  it('keyframes interpolate linearly and wrap seamlessly from the last key back to the first', () => {
    const tr = [[0, 0.4], [0.5, 0.6]] as const;
    expect(evalTrack(tr, 0)).toBeCloseTo(0.4);
    expect(evalTrack(tr, 0.25)).toBeCloseTo(0.5);
    expect(evalTrack(tr, 0.5)).toBeCloseTo(0.6);
    expect(evalTrack(tr, 0.75)).toBeCloseTo(0.5);
    expect(evalTrack(tr, 1)).toBeCloseTo(evalTrack(tr, 0));
    // keys not starting at 0 wrap too
    expect(evalTrack([[0.25, 1], [0.75, 0]], 0)).toBeCloseTo(0.5);
    expect(evalTrack([[0.25, 1], [0.75, 0]], 0.999)).toBeCloseTo(0.5, 2);
    expect(evalTrack([[0.3, 2]], 0.9)).toBe(2);
    // optional smooth easing per key
    expect(evalTrack(tr, 0.125, 'smooth')).toBeLessThan(evalTrack(tr, 0.125));
    setOverrides({ W2: { pose: { aRx: [[0, -1], [0.5, -0.5]] } } });
    expect(poseFor('W2', 0.25, false).aRx).toBeCloseTo(-0.75);
    expect(poseFor('W2', 1, false).aRx).toBeCloseTo(poseFor('W2', 0, false).aRx);
  });

  it('offsets add to the derived value; constant and keyframed', () => {
    setOverrides({ W2: { offsets: { aRx: 0.1, nod: [[0, 0], [0.5, 0.2]] } } });
    const t = 0.25;
    expect(poseFor('W2', t, false).aRx).toBeCloseTo(derived('W2', t, false).aRx + 0.1);
    expect(poseFor('W2', t, false).nod).toBeCloseTo(derived('W2', t, false).nod + 0.1);
  });

  it('applies last: after the script and the X2 modifier', () => {
    setOverrides({ W2: { pose: { gauge: 0, brow: 0.5 } } });
    expect(poseFor('W2', 0, true).gauge).toBe(0);
    expect(poseFor('W2', 0, true).brow).toBe(0.5); // the puff would pull the brow down to -0.6
    expect(poseFor('W2', 0, true).puff).toBe(1);
  });

  it('a "*" entry applies to every state, and a state\'s own entry applies on top of it', () => {
    setOverrides({ '*': { offsets: { lookX: 0.1 } }, N1: { offsets: { lookX: 0.1 } } });
    expect(poseFor('W2', 0, false).lookX).toBeCloseTo(derived('W2', 0, false).lookX + 0.1);
    expect(poseFor('N1', 0, false).lookX).toBeCloseTo(derived('N1', 0, false).lookX + 0.2);
  });

  it('values are clamped to each key\'s valid range instead of erroring', () => {
    setOverrides({ N5: { pose: { mouthOpen: 0.5, aRx: 9, eyeOpen: -1 }, offsets: { brow: 5 } } });
    const p = poseFor('N5', 0, false);
    expect([p.mouthOpen, p.aRx, p.eyeOpen, p.brow]).toEqual([0.2, 3.2, 0, 1]);
    expect(applyOverrides('W2', 0, { ...derived('W2', 0, false), aRz: 9 }).aRz).toBe(9); // only overridden keys are clamped
  });

  it('timing: loopMs changes the loop length, the baked frame count and playback', () => {
    const n = frameCount('W2');
    setOverrides({ W2: { timing: { loopMs: 4000 } } });
    expect(frameCount('W2')).toBe(n * 2);
    expect(resolvePlayback('W2', 3000).t).toBeCloseTo(0.75);
  });

  it('props and glyphs move by their authored transform; nothing moves without one', () => {
    const ch = new Character();
    const box = (id: ClayStateId, name: string, withAuthored: boolean) => {
      ch.apply(poseFor(id, 0, false), '#e07a4f', withAuthored ? authoredFor(id) : undefined);
      return ch.inspect();
    };
    setOverrides({ N6: { props: { hourglass: { x: 0.3, y: -0.1 } } }, N1: { glyphs: { q: { dy: -0.5 } } } });
    const plain = box('N6', 'hourglass', false).props.hourglass.getCenter(new Vector3());
    const moved = box('N6', 'hourglass', true).props.hourglass.getCenter(new Vector3());
    expect(moved.x - plain.x).toBeCloseTo(0.3, 3);
    expect(moved.y - plain.y).toBeCloseTo(-0.1, 3);
    // moving twice does not accumulate
    expect(box('N6', 'hourglass', true).props.hourglass.getCenter(new Vector3()).x).toBeCloseTo(moved.x, 6);
    const q0 = box('N1', 'q', false).glyphs.q[0].getCenter(new Vector3());
    const q1 = box('N1', 'q', true).glyphs.q[0].getCenter(new Vector3());
    expect(q1.y).toBeLessThan(q0.y - 0.05);
    expect(box('N1', 'q', false).glyphs.q[0].getCenter(new Vector3()).y).toBeCloseTo(q0.y, 6);
    setOverrides({ N4: { props: { bell: { scale: 1.5, rot: 0.2 } } } });
    const s0 = box('N4', 'bell', false).props.bell, s1 = box('N4', 'bell', true).props.bell;
    expect(s1.getSize(new Vector3()).y).toBeGreaterThan(s0.getSize(new Vector3()).y * 1.2);
  });

  it('every prop name and glyph name in the schema exists on the character', () => {
    const ch = new Character();
    expect([...PROP_NAMES].sort()).toEqual(ch.inspect().parts);
    expect(ch.inspect().glyphParts).toEqual([...GLYPH_KEYS].sort());
  });

  it('validation rejects unknown names and non-finite numbers; a dev load throws, a production load warns and skips', () => {
    const bad = {
      W9: {}, W1: { pose: { armR: 1, aRx: Infinity }, props: { cape: { x: 1 } }, glyphs: { '?': {} }, timing: { loopMs: Number.NaN }, extra: 1 },
      W2: { pose: { aRx: [[0.5, 1], [0.2, 0]] }, offsets: { nod: 'x' } },
    };
    const { value, errors } = parseOverrides(bad);
    for (const m of ['W9: unknown state', 'W1.pose.armR: unknown name', 'W1.pose.aRx: not a finite number', 'W1.props.cape: unknown name',
      'W1.glyphs.?: unknown name', 'W1.timing.loopMs: not a finite number', 'W1.extra: unknown part', 'W2.pose.aRx[1]: times must increase',
      'W2.offsets.nod: not a finite number']) expect(errors, m).toContain(m);
    expect(value).toEqual({ W1: { pose: {}, props: {}, glyphs: {}, timing: {} }, W2: { pose: {}, offsets: {} } });
    expect(() => loadOverrides(bad, true)).toThrow(/unknown state/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadOverrides(bad, false)).toEqual(value);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    // the editor's Save also checks ranges
    expect(parseOverrides({ W2: { pose: { mouthOpen: 0.5 } } }, { ranges: true }).errors).toEqual(['W2.pose.mouthOpen: 0.5 outside 0..0.2']);
  });

  it('the renderer version includes a hash of overrides.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clay-ver-'));
    cpSync(join(ROOT, 'web', 'src', 'clay'), dir, { recursive: true });
    const a = clayVersion(dir);
    writeFileSync(join(dir, 'overrides.json'), '{ "W2": { "pose": { "aRx": 0.4 } } }\n');
    expect(clayVersion(dir)).not.toBe(a);
  });
});

describe('pose editor Save endpoint (POST /__clay/overrides)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));
  const start = async (file: string) => {
    server = createServer((req, res) => overridesHandler(file)(req, res, () => { res.statusCode = 404; res.end('next'); }));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server!.address() as { port: number }).port}`;
  };
  const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'clay-ovr-')); writeFileSync(join(d, 'overrides.json'), '{}\n'); return d; };

  it('writes to web/src/clay/overrides.json only: the path is fixed, never taken from the request', async () => {
    expect(OVERRIDES_FILE).toBe(join(ROOT, 'web', 'src', 'clay', 'overrides.json'));
    const d = tmp();
    const url = await start(join(d, 'overrides.json'));
    const body = JSON.stringify({ W2: { pose: { aRx: -0.91234 } }, '*': { glyphs: { q: { dy: -0.4 } } } });
    for (const path of ['/__clay/overrides?file=../../evil.json', '/__clay/overrides/../evil.json', '/__clay/overrides']) {
      const r = await fetch(url + path, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-file': '/tmp/evil.json' } });
      expect(r.status, path).toBe(200);
    }
    expect(readdirSync(d)).toEqual(['overrides.json']);
    expect(existsSync(join(d, '..', 'evil.json'))).toBe(false);
    // rounded to 3 dp, keys sorted, pretty-printed
    expect(readFileSync(join(d, 'overrides.json'), 'utf8')).toBe('{\n  "*": {\n    "glyphs": {\n      "q": {\n        "dy": -0.4\n      }\n    }\n  },\n  "W2": {\n    "pose": {\n      "aRx": -0.912\n    }\n  }\n}\n');
  });

  it('rejects bad bodies and leaves the file alone: unknown names, non-finite or out-of-range numbers, not JSON, over 256 KB, not POST', async () => {
    const d = tmp();
    const url = await start(join(d, 'overrides.json'));
    const post = (body: string) => fetch(url, { method: 'POST', body });
    expect((await post(JSON.stringify({ W2: { pose: { armR: 1 } } }))).status).toBe(400);
    expect((await post(JSON.stringify({ X9: {} }))).status).toBe(400);
    expect((await post(JSON.stringify({ W2: { props: { cape: { x: 0 } } } }))).status).toBe(400);
    expect((await post(JSON.stringify({ W2: { glyphs: { w: { dx: 0 } } } }))).status).toBe(400);
    expect((await post('{ "W2": { "pose": { "aRx": 1e999 } } }')).status).toBe(400);
    expect((await post(JSON.stringify({ W2: { pose: { mouthOpen: 0.2004 } } }))).status).toBe(200); // rounds to 0.2 before the range check
    writeFileSync(join(d, 'overrides.json'), '{}\n');
    expect((await post(JSON.stringify({ W2: { pose: { mouthOpen: 0.21 } } }))).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
    const big = JSON.stringify({ W2: { pose: { aRx: Array.from({ length: 30_000 }, (_, i) => [i / 30_000, 0.123456]) } } });
    expect(big.length).toBeGreaterThan(MAX_BODY);
    expect((await post(big)).status).toBe(413);
    expect((await fetch(url, { method: 'GET' })).status).toBe(405);
    expect(readFileSync(join(d, 'overrides.json'), 'utf8')).toBe('{}\n');
  });
});
