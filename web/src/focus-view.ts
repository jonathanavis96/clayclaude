import type { FocusVM } from './focus-model.js';
import { esc } from './html.js';

export function ringSvg(pct: number | null): string {
  const c = 2 * Math.PI * 24;
  const p = Math.max(0, Math.min(100, pct ?? 0));
  const colour = (pct ?? 0) >= 85 ? 'var(--needs)' : 'var(--c)';
  return `<svg class="ctx-ring" viewBox="0 0 56 56"><g transform="rotate(-90 28 28)" fill="none">
    <circle cx="28" cy="28" r="24" stroke="var(--c)" stroke-opacity=".18" stroke-width="6"/>
    <circle cx="28" cy="28" r="24" stroke="${colour}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${((c * p) / 100).toFixed(2)} ${c.toFixed(2)}"/></g>
    <text x="28" y="32" text-anchor="middle">${pct === null ? '–' : `${Math.round(pct)}%`}</text></svg>`;
}

/** The parts of the focus view that change every second. The character and the bottom cards are not in here. */
export function statsHtml(v: FocusVM): string {
  return `${ringSvg(v.ctxPct)}<dl class="stats">
    <div><dt>model</dt><dd>${esc(v.model)}</dd></div><div><dt>effort</dt><dd>${esc(v.effort)}</dd></div>
    <div><dt>tokens in / out (recent)</dt><dd>${esc(v.tokensIn)} / ${esc(v.tokensOut)}</dd></div>
    <div><dt>tools</dt><dd>${v.toolCount ?? '–'}</dd></div><div><dt>running</dt><dd>${esc(v.running)}</dd></div></dl>`;
}

export function feedHtml(v: FocusVM): string {
  if (!v.feed.length) return '<p class="muted">No tool calls yet.</p>';
  return v.feed.map((f) => `<div class="feed-row"><time>${esc(f.time)}</time><b>${esc(f.tool)}</b><span>${esc(f.target)}</span></div>`).join('');
}

export function summaryHtml(v: FocusVM): string {
  return `${v.lastPrompt ? `<h4>Last prompt</h4><p class="clip">${esc(v.lastPrompt)}</p>` : ''}
    ${v.lastReply ? `<h4>Last reply</h4><p class="clip">${esc(v.lastReply)}</p>` : ''}
    ${v.files.length ? `<h4>Files touched</h4><ul class="files">${v.files.slice(0, 6).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}`;
}

export function buttonsHtml(v: FocusVM): string {
  return [
    v.canAnswer ? '<button class="primary" data-act="answer">Answer</button>' : '',
    v.canOpen ? '<button data-act="open">Open</button>' : '',
    v.canAttach ? '<button data-act="attach">Attach tmux</button>' : '',
    v.offline ? '<span class="tag">host offline</span>' : '',
  ].join('');
}

export function shellHtml(v: FocusVM): string {
  return `<div class="focus-panel st-${v.state}">
    <header><div class="char-large" id="f-char"></div>
      <div class="who"><h2>${esc(v.name)}</h2><div class="meta">${esc(v.meta)}</div><div class="word">${esc(v.word)}</div></div>
      <div id="f-stats" class="statsrow">${statsHtml(v)}</div><button class="x" data-act="close" aria-label="Close">×</button></header>
    <div class="cols"><section class="feed"><h4>Live feed</h4><div id="f-feed">${feedHtml(v)}</div></section>
      <section class="card"><div id="f-sum">${summaryHtml(v)}</div><div id="f-btns" class="row-btns">${buttonsHtml(v)}</div></section></div>
    <footer id="f-minis" class="minis"></footer></div>`;
}

/** Brings the header built by shellHtml up to date: the state colour (which the ring's track inherits), the word, the name and the meta line. */
export function updateHeader(root: ParentNode, v: FocusVM): void {
  const panel = root.querySelector('.focus-panel');
  if (panel) panel.className = `focus-panel st-${v.state}`;
  const set = (sel: string, text: string) => { const e = root.querySelector(sel); if (e && e.textContent !== text) e.textContent = text; };
  set('.who .word', v.word);
  set('.who h2', v.name);
  set('.who .meta', v.meta);
}

export function minisHtml(others: { key: string; name: string; state: string }[]): string {
  return others.map((o) => `<button class="mini st-${esc(o.state)}" data-act="focus" data-key="${esc(o.key)}"><div class="mini-char" data-key="${esc(o.key)}"></div><span>${esc(o.name)}</span></button>`).join('');
}
