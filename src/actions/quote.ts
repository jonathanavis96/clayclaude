/** The one place shell quoting happens. Everything that reaches a remote shell goes through here. */

/**
 * Quote one word for a POSIX shell and for fish. sshd runs the command with the user's login shell, which may be
 * fish, and fish reads `\\` and `\'` as escapes even inside single quotes. So a backslash, like a quote, is closed
 * out of the quotes and escaped (`'\\'`), which every shell reads the same way.
 */
export function shq(s: string): string {
  if (s.includes('\0')) throw new Error('NUL byte in shell argument');
  return `'${s.replace(/['\\]/g, (c) => `'\\${c}'`)}'`;
}

export function shJoin(argv: string[]): string {
  return argv.map(shq).join(' ');
}

/** Quote a path that may start with `~`, so the (remote) shell expands the home directory. */
export function shqPath(p: string): string {
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME"/${shq(p.slice(2))}`;
  return shq(p);
}
