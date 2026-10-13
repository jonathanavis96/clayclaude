import { HOOK_DIR, HOOK_MARK, backupPath, detectIndent, hookSource, lineDiff, sharedNote, type ConfigIO } from './install.js';

/**
 * The status line bridge. Claude Code gives its status line command a JSON on stdin that carries the session's real
 * context window (transcripts never record it), and only one status line can be configured per config directory. The
 * bridge takes that one place and keeps the person's own status line running inside it:
 *
 *   __clayclaude_prev='<their command>'; <read stdin once>; <stdin> | python3 hook.py statusline >/dev/null 2>&1;
 *   <stdin> | eval "$__clayclaude_prev"
 *
 * The shell, not hook.py, runs their command, with the same stdin and in the same shell Claude Code uses, and its output
 * is not touched: whatever hook.py does (fail, hang up, be missing, find no python3), the status line prints what it
 * printed before. Their command is kept in the settings entry itself, single quoted, so a settings.json shared by
 * several accounts carries it for all of them, and removing the bridge gets it back exactly.
 */

const RECORDER = `python3 "${HOOK_DIR}${HOOK_MARK}" statusline >/dev/null 2>&1`;
/** No status line before: record, print nothing. */
const ALONE = `${RECORDER} || true`;
const PREFIX = '__clayclaude_prev=';
// $(cat; printf x) then ${..%x}: command substitution would drop trailing newlines from the input.
const SUFFIX = `; __clayclaude_in=$(cat; printf x); __clayclaude_in=\${__clayclaude_in%x}; printf '%s' "$__clayclaude_in" | ${RECORDER}; printf '%s' "$__clayclaude_in" | eval "$__clayclaude_prev"`;
/** What every form of the bridge contains; a status line command with this in it is never wrapped again. */
export const STATUSLINE_MARK = `${HOOK_MARK}" statusline`;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const QUOTED = /^'((?:[^']|'\\'')*)'$/;

export function bridgeCommand(prev?: string): string {
  return prev === undefined ? ALONE : PREFIX + quote(prev) + SUFFIX;
}

/** The previous command a bridge command keeps (null: there was none), or null when this is not a bridge we wrote. */
export function parseBridge(cmd: string): { prev: string | null } | null {
  if (cmd === ALONE) return { prev: null };
  if (!cmd.startsWith(PREFIX) || !cmd.endsWith(SUFFIX)) return null;
  const q = cmd.slice(PREFIX.length, cmd.length - SUFFIX.length);
  const m = QUOTED.exec(q);
  if (!m) return null;
  const prev = m[1].replace(/'\\''/g, "'");
  return quote(prev) === q ? { prev } : null;
}

type Settings = Record<string, any>;
export type StatusLineMode = 'install' | 'remove';

export interface StatusLinePlan {
  next: Settings; changed: boolean;
  /** The bridge is in settings.json (before this plan). */
  installed: boolean;
  /** The person's own status line command: the one wrapped, or to be wrapped, or restored. Null when there is none. */
  previous: string | null;
  /** The command runs our recorder but is not a form we wrote (edited by hand): left alone, and not removable here. */
  handEdited?: true;
}

/**
 * Wrap the status line in the bridge, or take the bridge out again. Everything else in settings.json, and every other
 * key of the statusLine entry (padding, and any added later), is kept as it is. Idempotent both ways.
 */
export function planStatusLine(settings: Settings, mode: StatusLineMode): StatusLinePlan {
  const next: Settings = structuredClone(settings);
  const sl = next.statusLine;
  if (sl === undefined) {
    if (mode === 'remove') return { next, changed: false, installed: false, previous: null };
    next.statusLine = { type: 'command', command: bridgeCommand(), padding: 0 };
    return { next, changed: true, installed: false, previous: null };
  }
  if (typeof sl !== 'object' || sl === null || Array.isArray(sl))
    throw new Error('settings.json has a "statusLine" value that is not an object; refusing to change it');
  if (typeof sl.command !== 'string' || (sl.type !== undefined && sl.type !== 'command'))
    throw new Error('settings.json has a "statusLine" that is not a command status line; refusing to change it');
  if (!sl.command.includes(STATUSLINE_MARK)) {
    if (mode === 'remove') return { next, changed: false, installed: false, previous: sl.command };
    const previous = sl.command;
    sl.command = bridgeCommand(previous); // assigned in place, so the key keeps its position
    return { next, changed: true, installed: false, previous };
  }
  const parsed = parseBridge(sl.command);
  if (!parsed) {
    if (mode === 'remove') throw new Error('the status line command runs the clayclaude bridge but was edited by hand; remove it from settings.json yourself');
    return { next, changed: false, installed: true, previous: null, handEdited: true };
  }
  if (mode === 'install') return { next, changed: false, installed: true, previous: parsed.prev };
  if (parsed.prev === null) delete next.statusLine;
  else sl.command = parsed.prev;
  return { next, changed: true, installed: true, previous: parsed.prev };
}

export interface StatusLinePreview extends StatusLinePlan {
  settingsPath: string; diff: string; nextText: string; existed: boolean; shared?: string;
}

export async function previewStatusLine(io: ConfigIO, absConfigDir: string, mode: StatusLineMode): Promise<StatusLinePreview> {
  const settingsPath = `${absConfigDir}/settings.json`;
  const before = await io.read(settingsPath);
  let current: Settings = {};
  if (before !== null && before.trim() !== '') {
    try { current = JSON.parse(before); } catch { throw new Error(`${settingsPath} is not valid JSON; fix it first. Nothing was changed.`); }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) throw new Error(`${settingsPath} is not a JSON object. Nothing was changed.`);
  }
  const plan = planStatusLine(current, mode);
  const indent = before ? detectIndent(before) : '  ';
  const nextText = JSON.stringify(plan.next, null, indent) + '\n';
  const shownBefore = before === null ? '' : JSON.stringify(current, null, indent) + '\n';
  const shared = before === null ? undefined : await sharedNote(io, settingsPath);
  return { ...plan, settingsPath, diff: plan.changed ? lineDiff(shownBefore, nextText) : '', nextText, existed: before !== null, ...(shared ? { shared } : {}) };
}

/**
 * Install or remove the bridge. Installing always writes hook.py too (the recorder; also the repair path for a missing or
 * old copy). settings.json is backed up before it is changed, and only changed when the plan changes it.
 */
export async function applyStatusLine(io: ConfigIO, absConfigDir: string, mode: StatusLineMode, now = Date.now()): Promise<{ changed: boolean; backup?: string }> {
  const p = await previewStatusLine(io, absConfigDir, mode);
  if (mode === 'install') {
    await io.mkdirp(`${absConfigDir}/clayclaude`);
    await io.write(`${absConfigDir}/clayclaude/hook.py`, hookSource());
  }
  if (!p.changed) return { changed: false };
  let backup: string | undefined;
  if (p.existed) { backup = await backupPath(io, p.settingsPath, now); await io.copy(p.settingsPath, backup); }
  // Removing the only key of a settings.json the bridge created leaves "{}", never a deleted file.
  await io.write(p.settingsPath, p.nextText);
  return { changed: true, ...(backup ? { backup } : {}) };
}
