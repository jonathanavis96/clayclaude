import { writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { parseOverrides, roundDeep, serializeOverrides } from './src/clay/override-schema.js';

/** The only file the pose editor's Save writes. Fixed here: never taken from the request. */
export const OVERRIDES_FILE = join(import.meta.dirname, 'src', 'clay', 'overrides.json');
export const MAX_BODY = 256 * 1024;

/**
 * POST handler for the pose editor's Save (spec §7.4.7): reads at most 256 KB of JSON, rounds every number to 3 dp,
 * checks state ids, pose keys, prop and glyph names, finite numbers and ranges, then writes `file` pretty-printed
 * with sorted keys. Anything else is refused and the file is left alone.
 */
export function overridesHandler(file: string) {
  return (req: IncomingMessage, res: ServerResponse, _next: () => void): void => {
    const reply = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    if (!sameOrigin(req)) return reply(403, { error: 'Save is only taken from the editor\'s own page' });
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY) { over = true; reply(413, { error: `body over ${MAX_BODY} bytes` }); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let raw: unknown;
      try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'not JSON' }); }
      const { value, errors } = parseOverrides(roundDeep(raw), { ranges: true });
      if (errors.length) return reply(400, { errors });
      try { writeFileSync(file, serializeOverrides(value)); } catch (e) { return reply(500, { error: String(e) }); }
      reply(200, { ok: true });
    });
  };
}

/**
 * A form or a no-cors fetch on any other site can POST a JSON-shaped text/plain body here without a preflight, so
 * Save comes from the dev server's own origin only: a browser always sends Origin (and Sec-Fetch-Site) on such a POST.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;   // not a browser (curl, a test): it could write the file directly anyway
  try { return new URL(String(origin)).host === String(req.headers.host ?? ''); } catch { return false; }
}

/** Dev server only (`apply: 'serve'`): nothing of the editor or its endpoint reaches a production build. */
export function clayOverridesPlugin(): Plugin {
  return {
    name: 'clay-overrides',
    apply: 'serve',
    configureServer(server) { server.middlewares.use('/__clay/overrides', overridesHandler(OVERRIDES_FILE)); },
  };
}
