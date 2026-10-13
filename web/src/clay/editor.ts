/**
 * Pose editor (spec §7.4.7), dev only: clay-lab.html?view=editor, lazy-imported behind import.meta.env.DEV, so
 * nothing of it reaches the production bundle. Pick a state, scrub the loop or pin a frame, set any pose key
 * (constant or keyframed, with an `auto` toggle that deletes the override), drag props and glyphs on the 3x
 * preview, and Save: POST /__clay/overrides writes web/src/clay/overrides.json. Revert reloads it from disk.
 * Headless use: window.__editor (select, frame, draft, setDraft, save, render).
 */
import { Box3, Vector3 } from 'three';
import { KEY_RANGES, PROP_NAMES, type GlyphKey, type OverrideEntry, type Overrides, type PropName, type Track } from './override-schema.js';
import { getOverrides, setOverrides } from './overrides.js';
import { POSE_KEYS, type PoseKey } from './pose.js';
import { Stage } from './stage.js';
import { CLAY_STATES, type ClayStateId } from './states.js';
import { frameCount, frameTime, loopMs, poseFor } from './timeline.js';

export const EDITOR_MARK = 'clayclaude-pose-editor';
const BOARD = 96;
const ZOOM = 3;

export interface EditorApi {
  select(id: ClayStateId): void;
  frame(i: number | null): void;
  draft(): Overrides;
  setDraft(o: Overrides): void;
  save(): Promise<number>;
  render(): void;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, css = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text) e.textContent = text;
  return e;
};

export function mountEditor(root: HTMLElement): EditorApi {
  const saved = sessionStorage.getItem('clay-editor') ?? '';
  let id: ClayStateId = (CLAY_STATES as readonly string[]).includes(saved) ? (saved as ClayStateId) : 'W1';
  let pinned: number | null = 0;
  let puffed = false;
  let draft: Overrides = clone(getOverrides());
  let selected: { kind: 'prop'; name: PropName } | { kind: 'glyph'; name: GlyphKey } | null = null;
  const entry = (): OverrideEntry => (draft[id] ??= {});
  const prune = () => {
    const e = draft[id];
    if (!e) return;
    for (const k of Object.keys(e) as Array<keyof OverrideEntry>) if (e[k] && !Object.keys(e[k]!).length) delete e[k];
    if (!Object.keys(e).length) delete draft[id];
  };

  root.id = EDITOR_MARK;
  root.style.cssText = 'display:grid;grid-template-columns:230px auto 1fr;gap:12px;padding:10px;height:100%;overflow:auto;color:#d6dbe4;font:12px ui-monospace,monospace';
  const left = el('div', 'display:flex;flex-direction:column;gap:6px');
  const mid = el('div', 'display:flex;flex-direction:column;gap:6px');
  const right = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:2px 12px;align-content:start');
  root.append(left, mid, right);

  // ---- left: state, frame, timing, save
  const pick = el('select');
  for (const s of CLAY_STATES) pick.append(new Option(s, s));
  pick.value = id;
  const puff = el('label', '', ' puffed (X2 modifier)');
  const puffBox = el('input');
  puffBox.type = 'checkbox';
  puff.prepend(puffBox);
  const play = el('button', '', 'play');
  const scrub = el('input');
  scrub.type = 'range';
  const frameLabel = el('div');
  const loop = el('input');
  loop.type = 'number';
  loop.step = '100';
  const loopAuto = el('label', '', ' auto loop length');
  const loopAutoBox = el('input');
  loopAutoBox.type = 'checkbox';
  loopAuto.prepend(loopAutoBox);
  const saveBtn = el('button', '', 'Save');
  const revertBtn = el('button', '', 'Revert');
  const status = el('div', 'white-space:pre-wrap;color:#8a93a3');
  const xform = el('div', 'display:flex;flex-direction:column;gap:3px');
  left.append(el('b', '', 'Pose editor'), pick, puff, play, scrub, frameLabel, el('span', '', 'loop ms'), loop, loopAuto,
    xform, saveBtn, revertBtn, status);

  // ---- middle: board size and 3x zoom side by side, drag handles on the zoom
  const stage = new Stage(document.createElement('canvas'));
  const small = el('canvas', `width:${BOARD}px;height:${BOARD}px;background:#161a21;border-radius:6px`);
  small.width = small.height = BOARD;
  const wrap = el('div', 'position:relative');
  const big = el('canvas', `width:${BOARD * ZOOM}px;height:${BOARD * ZOOM}px;image-rendering:pixelated;background:#161a21;border-radius:6px`);
  big.width = big.height = BOARD * ZOOM;
  const handles = el('div', 'position:absolute;inset:0');
  wrap.append(big, handles);
  const row = el('div', 'display:flex;gap:10px;align-items:flex-start');
  row.append(small, wrap);
  const hi = el('canvas', `width:${BOARD * ZOOM}px;height:${BOARD * ZOOM}px;background:#161a21;border-radius:6px`);
  hi.width = hi.height = BOARD * ZOOM;
  mid.append(row, el('span', '', 'rendered at 3x (detail)'), hi);

  // ---- right: a row per pose key
  const rows = new Map<PoseKey, { auto: HTMLInputElement; mode: HTMLSelectElement; slider: HTMLInputElement; val: HTMLSpanElement; der: HTMLSpanElement }>();
  for (const k of POSE_KEYS) {
    const r = el('div', 'display:grid;grid-template-columns:104px 40px 1fr 44px 62px;gap:4px;align-items:center');
    const auto = el('input');
    auto.type = 'checkbox';
    auto.title = 'auto: no override (deletes it)';
    const name = el('label', '', k);
    name.prepend(auto);
    const der = el('span', 'color:#8a93a3');
    const slider = el('input');
    slider.type = 'range';
    [slider.min, slider.max] = KEY_RANGES[k].map(String);
    slider.step = '0.005';
    const val = el('span');
    const mode = el('select');
    mode.append(new Option('const', 'const'), new Option('keys', 'keys'));
    r.append(name, der, slider, val, mode);
    right.append(r);
    rows.set(k, { auto, mode, slider, val, der });
    auto.onchange = () => {
      const pose = (entry().pose ??= {});
      if (auto.checked) delete pose[k];
      else pose[k] = Number(slider.value);
      prune();
      refresh();
    };
    mode.onchange = () => {
      const pose = (entry().pose ??= {});
      const v = Number(slider.value);
      pose[k] = mode.value === 'keys' ? [[Number(frameTime(id, pinned ?? 0).toFixed(3)), v]] : v;
      refresh();
    };
    slider.oninput = () => {
      const pose = (entry().pose ??= {});
      const v = Number(slider.value);
      const cur = pose[k];
      if (Array.isArray(cur)) {
        const t = Number(frameTime(id, pinned ?? 0).toFixed(3));
        const keys = cur.filter(([kt]) => kt !== t).concat([[t, v]]).sort((a, b) => a[0] - b[0]);
        pose[k] = keys;
      } else pose[k] = v;
      refresh();
    };
  }

  const frameNow = () => pinned ?? Math.floor(((performance.now() % loopMs(id)) / loopMs(id)) * frameCount(id));
  const render = () => {
    setOverrides(draft);
    const t = frameTime(id, Math.min(frameNow(), frameCount(id) - 1));
    for (const [canvas, px] of [[small, BOARD], [hi, BOARD * ZOOM]] as const) {
      stage.setSize(px);
      stage.render({ state: id, t, puffed, colour: '#e07a4f', shadows: true });
      const c = canvas.getContext('2d')!;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.drawImage(stage.canvas as CanvasImageSource, 0, 0);
      if (px === BOARD) {
        const z = big.getContext('2d')!;
        z.imageSmoothingEnabled = false;
        z.clearRect(0, 0, big.width, big.height);
        z.drawImage(stage.canvas as CanvasImageSource, 0, 0, big.width, big.height);
        drawHandles();
      }
    }
    frameLabel.textContent = `frame ${frameNow()} / ${frameCount(id)}  t=${t.toFixed(3)}`;
  };

  // drag handles: one dot per prop and glyph on show, at the centre of its box
  const drawHandles = () => {
    handles.replaceChildren();
    const ins = stage.inspect();
    const spots: Array<{ kind: 'prop' | 'glyph'; name: string; box: Box3 }> = [
      ...Object.entries(ins.props).filter(([n]) => (PROP_NAMES as readonly string[]).includes(n)).map(([name, box]) => ({ kind: 'prop' as const, name, box })),
      ...Object.entries(ins.glyphs).map(([name, boxes]) => ({ kind: 'glyph' as const, name, box: boxes![0] })),
    ];
    for (const s of spots) {
      const c = s.box.getCenter(new Vector3());
      const at = stage.project(c);
      const sel = selected?.kind === s.kind && selected.name === s.name;
      const dot = el('div', `position:absolute;left:${at.x * 100}%;top:${at.y * 100}%;width:10px;height:10px;margin:-5px;border-radius:50%;cursor:move;`
        + `background:${s.kind === 'prop' ? '#4fd1c5' : '#f5b544'};border:2px solid ${sel ? '#fff' : '#0008'}`);
      dot.title = `${s.kind} ${s.name}`;
      dot.onpointerdown = (ev) => {
        selected = { kind: s.kind, name: s.name } as typeof selected;
        dot.setPointerCapture(ev.pointerId);
        let last = { x: ev.clientX, y: ev.clientY };
        dot.onpointermove = (m) => {
          const d = stage.unprojectDelta(c, (m.clientX - last.x) / big.clientWidth, (m.clientY - last.y) / big.clientHeight);
          last = { x: m.clientX, y: m.clientY };
          if (s.kind === 'prop') {
            const x = ((entry().props ??= {})[s.name as PropName] ??= {});
            x.x = (x.x ?? 0) + d.x;
            x.y = (x.y ?? 0) + d.y;
          } else {
            const unit = Math.max(0.05, s.box.max.y - s.box.min.y); // a glyph is about 1 unit tall
            const g = ((entry().glyphs ??= {})[s.name as GlyphKey] ??= {});
            g.dx = (g.dx ?? 0) + d.x / unit;
            g.dy = (g.dy ?? 0) + d.y / unit;
          }
          refresh();
        };
        dot.onpointerup = () => { dot.onpointermove = null; refresh(); };
      };
      handles.append(dot);
    }
  };

  // numeric fields for the selected prop or glyph
  const drawXform = () => {
    xform.replaceChildren();
    if (!selected) { xform.append(el('span', 'color:#8a93a3', 'drag a dot to move a prop (teal) or glyph (amber)')); return; }
    const sel = selected;
    xform.append(el('b', '', `${sel.kind} ${sel.name}`));
    const obj = sel.kind === 'prop' ? (entry().props ??= {})[sel.name] ??= {} : (entry().glyphs ??= {})[sel.name] ??= {};
    const fields = sel.kind === 'prop' ? ['x', 'y', 'z', 'rot', 'scale'] : ['dx', 'dy', 'scale'];
    for (const f of fields) {
      const r = el('label', 'display:flex;justify-content:space-between', f);
      const inp = el('input', 'width:90px');
      inp.type = 'number';
      inp.step = '0.01';
      inp.value = String((obj as Record<string, number>)[f] ?? (f === 'scale' ? 1 : 0));
      inp.onchange = () => { (obj as Record<string, number>)[f] = Number(inp.value); refresh(); };
      r.append(inp);
      xform.append(r);
    }
    const reset = el('button', '', 'auto (remove)');
    reset.onclick = () => {
      if (sel.kind === 'prop') delete entry().props?.[sel.name];
      else delete entry().glyphs?.[sel.name];
      selected = null;
      prune();
      refresh();
    };
    xform.append(reset);
  };

  const refresh = () => {
    sessionStorage.setItem('clay-editor', id);
    const n = frameCount(id);
    scrub.max = String(n - 1);
    if (pinned !== null) scrub.value = String(Math.min(pinned, n - 1));
    play.textContent = pinned === null ? 'pause (pin this frame)' : 'play';
    puffBox.checked = puffed;
    const e = draft[id];
    loopAutoBox.checked = e?.timing?.loopMs === undefined;
    loop.value = String(loopMs(id));
    // derived = the pose without this state's own entry
    const own = draft[id];
    const without = clone(draft);
    delete without[id];
    setOverrides(without);
    const t = frameTime(id, Math.min(frameNow(), n - 1));
    const der = poseFor(id, t, puffed);
    setOverrides(draft);
    const now = poseFor(id, t, puffed);
    for (const [k, r] of rows) {
      const ov = own?.pose?.[k] as Track | undefined;
      r.auto.checked = ov === undefined;
      r.mode.value = Array.isArray(ov) ? 'keys' : 'const';
      r.mode.disabled = ov === undefined;
      r.der.textContent = der[k].toFixed(2);
      if (document.activeElement !== r.slider) r.slider.value = String(now[k]);
      r.val.textContent = now[k].toFixed(3);
      r.val.style.color = ov === undefined ? '#8a93a3' : '#f5b544';
    }
    drawXform();
    render();
  };

  pick.onchange = () => { id = pick.value as ClayStateId; selected = null; pinned = 0; refresh(); };
  puffBox.onchange = () => { puffed = puffBox.checked; refresh(); };
  play.onclick = () => { pinned = pinned === null ? frameNow() : null; refresh(); };
  scrub.oninput = () => { pinned = Number(scrub.value); refresh(); };
  loop.onchange = () => { ((entry().timing ??= {}).loopMs = Number(loop.value)); refresh(); };
  loopAutoBox.onchange = () => {
    if (loopAutoBox.checked) delete entry().timing?.loopMs;
    else (entry().timing ??= {}).loopMs = loopMs(id);
    prune();
    refresh();
  };
  const save = async () => {
    status.textContent = 'saving…';
    const r = await fetch('/__clay/overrides', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) });
    status.textContent = r.ok ? 'saved web/src/clay/overrides.json' : `refused: ${await r.text()}`;
    return r.status;
  };
  saveBtn.onclick = () => { void save(); };
  revertBtn.onclick = () => location.reload();

  const tick = () => { if (pinned === null) render(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  refresh();

  const api: EditorApi = {
    select: (s) => { id = s; pick.value = s; selected = null; refresh(); },
    frame: (i) => { pinned = i; refresh(); },
    draft: () => clone(draft),
    setDraft: (o) => { draft = clone(o); refresh(); },
    save,
    render,
  };
  return api;
}

