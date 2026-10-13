import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for `ssh` that runs the remote command locally with `sh -c`, so tests prove
 * what a real remote shell would do with our quoting. Skips ssh options and the host alias.
 * Pass `home` to give the "remote" a different $HOME, and `shell` to run the command with another login shell
 * (sshd runs it with `$SHELL -c`), for example fish.
 */
export function makeFakeSsh(home?: string, shell?: string[]): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), 'cc-fakessh-'));
  const bin = join(dir, 'ssh');
  writeFileSync(bin, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2;;
    -t|-T) shift;;
    --) shift; break;;
    *) break;;
  esac
done
shift  # the host alias
${home ? `export HOME=${JSON.stringify(home)}` : ''}
exec ${shell ? shell.map((a) => JSON.stringify(a)).join(' ') : 'sh'} -c "$*"
`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}
