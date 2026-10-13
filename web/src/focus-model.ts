import type { SessionSummary } from '../../src/actions/types.js';
import type { Session } from '../../src/types.js';
import { formatAge } from './order.js';

export interface FocusVM {
  key: string; name: string; meta: string; state: Session['state']; word: string;
  ctxPct: number | null; model: string; effort: string; tokensIn: string; tokensOut: string; toolCount: number | null; running: string;
  feed: { time: string; tool: string; target: string }[];
  lastPrompt: string; lastReply: string; files: string[];
  canAnswer: boolean; canOpen: boolean; canAttach: boolean; offline: boolean;
}

const WORD: Record<string, string> = { 'needs-you': 'NEEDS YOU', working: 'WORKING', asleep: 'ASLEEP', stopped: 'STOPPED', compacting: 'COMPACTING', limit: 'LIMIT' };
const p2 = (n: number) => String(n).padStart(2, '0');

export const fmtTime = (ms: number) => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
export function fmtTokens(n: number | undefined): string {
  if (n === undefined) return '–';
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}
const tidyModel = (m?: string) => (m ?? '–').replace(/^claude-/, '').replace(/\[1m\]$/, ' 1M');

export function focusModel(s: Session, sum: SessionSummary | null, now: number, accountLabel: string): FocusVM {
  return {
    key: s.key, name: s.name, meta: [accountLabel, s.host, s.tmux?.split(':')[0]].filter(Boolean).join(' · '),
    state: s.state, word: s.starting && s.state === 'working' ? 'STARTING' : WORD[s.state] ?? s.state.toUpperCase(),
    ctxPct: s.contextPct ?? null, model: tidyModel(s.model), effort: s.effort ?? '–',
    tokensIn: fmtTokens(sum?.tokensIn), tokensOut: fmtTokens(sum?.tokensOut), toolCount: sum ? sum.toolCount : null,
    running: sum?.startedAt ? formatAge(now - sum.startedAt) : '–',
    feed: (sum?.tools ?? []).slice(-14).reverse().map((t) => ({ time: t.at ? fmtTime(t.at) : '--:--:--', tool: t.name, target: t.target })),
    lastPrompt: sum?.lastPrompt ?? '', lastReply: sum?.lastAssistantText ?? '', files: sum?.files ?? [],
    canAnswer: s.state === 'needs-you' && !!s.tmux && s.hostOnline,
    canOpen: !!s.bridgeSessionId && s.hostOnline,
    canAttach: !!s.tmux && s.hostOnline,
    offline: !s.hostOnline,
  };
}
