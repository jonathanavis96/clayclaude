import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { ConfigIO } from '../hooks/install.js';

/** The config as written to disk: only keys the user chose; the loader supplies the rest. */
export type ConfigDraft = Record<string, unknown>;

const HEADER = `# clayclaude config, written by "clayclaude setup". Safe to edit by hand.
# This file may hold your LAN token: keep it private. Never commit it.
`;

export const serializeConfig = (draft: ConfigDraft) => HEADER + stringify(draft, { lineWidth: 0 });

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/**
 * Writes the config with mode 0600 (forced: an existing 0644 file is tightened, since it may now hold a LAN token),
 * keeping the previous file as `<name>.bak-<time>`, 0600 too, with `-<n>` added if that name is taken.
 */
export async function writeConfigFile(io: ConfigIO, path: string, text: string, now = Date.now()): Promise<{ backup?: string }> {
  await io.mkdirp(dirname(path));
  const existing = await io.read(path);
  let backup: string | undefined;
  if (existing !== null) {
    const base = `${path}.bak-${stamp(now)}`;
    backup = base;
    for (let n = 1; (await io.read(backup)) !== null; n++) backup = `${base}-${n}`;
    await io.write(backup, existing, 0o600);
  }
  await io.write(path, text, 0o600);
  return { backup };
}
