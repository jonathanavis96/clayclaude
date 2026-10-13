import { count, summariseInput } from './transcript.js';
import type { SessionSummary, ToolEvent } from '../actions/types.js';

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MAX_TOOLS = 40;
const MAX_FILES = 12;

function userText(e: any): string | undefined {
  // Claude Code injects skill bodies, hook feedback and /compact summaries as user entries.
  if (e.isMeta === true || e.isCompactSummary === true || e.isSidechain === true) return undefined;
  const c = e.message?.content;
  const text = typeof c === 'string' ? c
    : Array.isArray(c) ? c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';
  const t = text.trim();
  // Skip tool results, slash-command wrappers and injected reminders, which start with "<",
  // and the interrupt marker Claude Code writes when the user presses Esc.
  return t && !t.startsWith('<') && !t.startsWith('[Request interrupted') ? t : undefined;
}

/** Summary card data from the probe's trimmed transcript lines. Pure. */
export function buildSummary(lines: string[], startedAt?: number): SessionSummary {
  const s: SessionSummary = { files: [], tools: [], toolCount: 0, tokensIn: 0, tokensOut: 0, startedAt };
  const files: string[] = [];
  const tools: ToolEvent[] = [];
  let lastPromptEntry: string | undefined;
  // One reply is written as one line per content block, each repeating the same message.id
  // and usage, so keep the last usage per id (or requestId) and sum those.
  const usage = new Map<unknown, any>();
  for (const line of lines) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'last-prompt' && typeof e.lastPrompt === 'string') s.lastPrompt = e.lastPrompt;
    if (e?.type === 'user') {
      const t = userText(e);
      if (t) lastPromptEntry = t;
    } else if (e?.type === 'assistant') {
      const u = e.message?.usage;
      if (u) usage.set(e.message?.id ?? e.requestId ?? Symbol(), u);
      const at = typeof e.timestamp === 'string' && Number.isFinite(Date.parse(e.timestamp)) ? Date.parse(e.timestamp) : null;
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) s.lastAssistantText = b.text.trim();
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          s.toolCount++;
          tools.push({ at, name: b.name, target: summariseInput(b.name, b.input) });
          const p = b.input?.file_path ?? b.input?.notebook_path;
          if (FILE_TOOLS.has(b.name) && typeof p === 'string') files.push(p);
        }
      }
    }
  }
  for (const u of usage.values()) {
    s.tokensIn += (count(u.input_tokens) ?? 0) + (count(u.cache_creation_input_tokens) ?? 0);
    s.tokensOut += count(u.output_tokens) ?? 0;
  }
  if (lastPromptEntry) s.lastPrompt = lastPromptEntry;
  if (s.lastPrompt && s.lastPrompt.length > 600) s.lastPrompt = s.lastPrompt.slice(0, 599) + '…';
  if (s.lastAssistantText && s.lastAssistantText.length > 800) s.lastAssistantText = s.lastAssistantText.slice(0, 799) + '…';
  s.tools = tools.slice(-MAX_TOOLS);
  s.files = [...new Set(files.reverse())].slice(0, MAX_FILES);
  return s;
}
