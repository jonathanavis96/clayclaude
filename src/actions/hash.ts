import { createHash } from 'node:crypto';

/** Short stable hash of prompt content. */
export function promptHash(parts: string[]): string {
  return createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}
