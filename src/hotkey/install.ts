import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ConfigIO } from '../hooks/install.js';

export interface HotkeyValues { adb: string; scrcpy: string; serial?: string; url: string; chromePackage: string; hotkey: string }

export const hotkeyTemplate = () => readFileSync(fileURLToPath(new URL('./clayclaude-hotkey.ahk', import.meta.url)), 'utf8');

/** AutoHotkey v2 hotkey names: modifiers (# ! ^ + < > * ~ $) then one key. Anything else is refused. */
export const HOTKEY_RE = /^[#!^+<>*~$]*([A-Za-z0-9]|F\d{1,2})$/;

/** Escape a value for an AutoHotkey v2 double-quoted string. `;` is escaped too: after a space it would start a comment. */
export const ahkString = (s: string) => {
  if (/[\r\n\0]/.test(s)) throw new Error('control character in hotkey setting');
  return s.replace(/`/g, '``').replace(/"/g, '`"').replace(/;/g, '`;');
};

export function renderHotkeyScript(template: string, v: HotkeyValues): string {
  if (!HOTKEY_RE.test(v.hotkey)) throw new Error(`"${v.hotkey}" is not a valid AutoHotkey hotkey (for example #+t is Win+Shift+T)`);
  if (v.serial && !/^[\w:.-]{1,64}$/.test(v.serial)) throw new Error('bad adb serial');
  const map: Record<string, string> = {
    '{{ADB}}': ahkString(v.adb), '{{SCRCPY}}': ahkString(v.scrcpy), '{{SERIAL}}': ahkString(v.serial ?? ''),
    '{{URL}}': ahkString(v.url), '{{PACKAGE}}': ahkString(v.chromePackage), '{{HOTKEY}}': v.hotkey,
  };
  // One pass, so a value that happens to contain "{{...}}" is never substituted again.
  return template.replace(/\{\{(ADB|SCRCPY|SERIAL|URL|PACKAGE|HOTKEY)\}\}/g, (m) => map[m]);
}

/** Write the script to `path` (and a copy into the Startup folder when given). The caller supplies Windows-visible paths. */
export async function installHotkey(io: ConfigIO, path: string, text: string, startupPath?: string): Promise<void> {
  await io.mkdirp(path.replace(/[\\/][^\\/]*$/, ''));
  await io.write(path, text);
  if (startupPath) await io.write(startupPath, text);
}
