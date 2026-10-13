export interface TranscriptInfo {
  lastEntryAt: number | null;
  lastAssistantAt: number | null;
  /** Newest real model response (not a synthetic API error entry); the prompt cache counts from this. */
  lastResponseAt: number | null;
  /** Newest user entry of any kind (prompt or tool_result). */
  lastUserAt: number | null;
  model?: string;
  effort?: string;
  contextTokens: number | null;
  /** Largest context size seen in the tail, including a compaction's pre-compaction size. */
  peakTokens: number | null;
  currentAction?: string;
  pendingTool?: { name: string; summary: string; id: string };
  askQuestion?: string;
  lastPrompt?: string;
  lastAssistantText?: string;
  aiTitle?: string;
  lastCompactAt: number | null;
  limitHit: boolean;
}

/** A token count: a finite, non-negative number. A string would concatenate instead of add. */
export const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

const KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt'];

export function summariseInput(_name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const v = KEYS.map((k) => rec[k]).find((x): x is string => typeof x === 'string' && x.trim() !== '');
  if (!v) return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

const ts = (e: any): number | null => {
  const t = typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  return Number.isFinite(t) ? t : null;
};

// A usage-limit error is a synthetic assistant entry Claude Code writes itself
// (isApiErrorMessage, model '<synthetic>'), e.g. "You've hit your session limit · resets 3:50am".
const LIMIT_TEXT = /usage limit|limit reached|hit your .*limit|reached your .*limit/i;
const isApiError = (e: any): boolean => e?.isApiErrorMessage === true || e?.message?.model === '<synthetic>';
const isLimitError = (e: any): boolean => {
  if (!isApiError(e)) return false;
  if (e.error === 'rate_limit') return true;
  const c = e.message?.content;
  return (Array.isArray(c) ? c : []).some((b: any) => b?.type === 'text' && typeof b.text === 'string' && LIMIT_TEXT.test(b.text));
};

export function extractTranscript(lines: string[]): TranscriptInfo {
  const info: TranscriptInfo = { lastEntryAt: null, lastAssistantAt: null, lastResponseAt: null, lastUserAt: null, contextTokens: null, peakTokens: null, lastCompactAt: null, limitHit: false };
  const pending = new Map<string, { name: string; summary: string; id: string; input: any }>();
  for (const line of lines) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue; // 'null' would throw below and mark the whole host offline
    const t = ts(e);
    if (t !== null) info.lastEntryAt = Math.max(info.lastEntryAt ?? 0, t);
    switch (e.type) {
      case 'last-prompt': if (typeof e.lastPrompt === 'string') info.lastPrompt = e.lastPrompt; break;
      case 'ai-title': if (typeof e.aiTitle === 'string') info.aiTitle = e.aiTitle; break;
      case 'system': {
        if (e.subtype !== 'compact_boundary') break;
        if (t !== null) info.lastCompactAt = t;
        // The last assistant turn's usage is from before compaction; until the next turn the boundary has the real size.
        const cm = e.compactMetadata;
        info.contextTokens = count(cm?.postTokens) ?? null;
        if (count(cm?.preTokens) !== undefined) info.peakTokens = Math.max(info.peakTokens ?? 0, cm.preTokens);
        break;
      }
      case 'assistant': {
        if (t !== null) info.lastAssistantAt = t;
        // Only the newest conversation entry decides the flag; metadata written after it does not clear it.
        info.limitHit = isLimitError(e);
        const m = e.message ?? {};
        const synthetic = isApiError(e);
        if (t !== null && !synthetic) info.lastResponseAt = t;
        if (typeof m.model === 'string' && !synthetic) info.model = m.model;
        if (typeof e.effort === 'string') info.effort = e.effort;
        const u = m.usage;
        if (u && count(u.input_tokens) !== undefined && !synthetic) {
          const n = count(u.input_tokens)! + (count(u.cache_read_input_tokens) ?? 0) + (count(u.cache_creation_input_tokens) ?? 0);
          info.contextTokens = n;
          info.peakTokens = Math.max(info.peakTokens ?? 0, n);
        }
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b?.type === 'tool_use' && typeof b.name === 'string') {
            const summary = summariseInput(b.name, b.input);
            info.currentAction = summary ? `${b.name}: ${summary}` : b.name;
            pending.set(b.id, { name: b.name, summary, id: b.id, input: b.input });
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            info.lastAssistantText = b.text;
          }
        }
        break;
      }
      case 'user': {
        info.limitHit = false;
        if (t !== null) info.lastUserAt = t;
        const c = e.message?.content;
        const blocks = Array.isArray(c) ? c : [];
        // A real prompt starts a new turn: anything still unresolved before it (a crash, a lost
        // tool_result, an interrupt) is not waiting on the user any more.
        if (e.isMeta !== true && (typeof c === 'string' || blocks.some((b: any) => b?.type !== 'tool_result'))) pending.clear();
        for (const b of blocks) if (b?.type === 'tool_result') pending.delete(b.tool_use_id);
        break;
      }
    }
  }
  // With parallel tool calls Claude Code asks about them in order, so the oldest unresolved one is the one blocking.
  const blocking = [...pending.values()][0];
  if (blocking) {
    info.pendingTool = { name: blocking.name, summary: blocking.summary, id: blocking.id };
    if (blocking.name === 'AskUserQuestion') {
      const q = blocking.input?.questions?.[0]?.question;
      if (typeof q === 'string') info.askQuestion = q;
    }
  }
  return info;
}
