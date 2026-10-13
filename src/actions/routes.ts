import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { RouteHandler } from '../server.js';
import { fail, type ActionApi, type ErrorCode, type Result } from './types.js';

const MAX_BODY = 32 * 1024;

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, forbidden: 403, unknown_session: 404, unknown_account: 404, prompt_changed: 409,
  duplicate: 409, too_long: 413, no_tmux: 422, no_bridge: 422, no_prompt: 422, pane_gone: 410, unsupported: 422,
  rate_limited: 429, host_offline: 503, failed: 502, live: 409,
};

/** At most `max` POSTs per `windowMs`, for all clients together (there is one tablet; anything faster is a runaway or an attack). */
export class RateLimit {
  private hits: number[] = [];
  constructor(private max = 30, private windowMs = 10_000, private now: () => number = Date.now) {}
  allow(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }
}

const Id = z.string().min(1).max(300);
const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), sessionId: Id }),
  z.object({ action: z.literal('attach'), sessionId: Id }),
  z.object({ action: z.literal('prompt'), sessionId: Id }),
  z.object({ action: z.literal('clear'), sessionId: Id }),
  z.object({ action: z.literal('clear-stopped') }),
  // Cleaned and checked (1 to 40 characters, no direction override) by the action itself; this only bounds the body.
  z.object({ action: z.literal('rename'), sessionId: Id, name: z.string().max(400).nullable(), tmux: z.boolean().optional() }),
  z.object({ action: z.literal('answer'), sessionId: Id, promptHash: z.string().min(1).max(64), choice: z.string().max(4).optional(), text: z.string().max(20000).optional() }),
  z.object({
    action: z.literal('launch'), account: z.string().min(1).max(100), repo: z.string().min(1).max(1000),
    options: z.object({
      model: z.string().max(64).optional(), effort: z.string().max(16).optional(),
      remoteControl: z.boolean().optional(), openOnPc: z.boolean().optional(),
      // Task 42a: cleaned and checked like a nickname by the launch itself; this only bounds the body.
      name: z.string().max(400).optional(),
      // Task 46: checked against the host's claude and the config by the launch itself; this only bounds the body.
      permissionMode: z.string().max(32).optional(), confirmBypass: z.boolean().optional(),
    }).default({}),
  }),
]).superRefine((b, ctx) => {
  if (b.action === 'answer' && (b.choice === undefined) === (b.text === undefined))
    ctx.addIssue({ code: 'custom', message: 'send exactly one of choice or text' });
});

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
const sendResult = (res: ServerResponse, r: Result<object>) => send(res, r.ok ? 200 : STATUS[r.error] ?? 500, r);

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface RouteOptions { mode: 'live' | 'demo'; publicConfig?: () => unknown; rateLimit?: RateLimit }

/**
 * Action routes. The tablet never sends a command line: it names an action and a session,
 * and the daemon looks everything else up in its own config.
 */
export function createActionRoutes(api: ActionApi, opts: RouteOptions): RouteHandler {
  const limit = opts.rateLimit ?? new RateLimit();
  return async (req, res, url) => {
    const p = url.pathname;
    if (!p.startsWith('/api/')) return false;
    try {
      if (req.method === 'GET') {
        if (p === '/api/meta') return send(res, 200, { mode: opts.mode }), true;
        if (p === '/api/config' && opts.publicConfig) return send(res, 200, opts.publicConfig()), true;
        if (p === '/api/launch/options') return send(res, 200, await api.launchOptions()), true;
        if (p === '/api/repos') return sendResult(res, await api.repos(url.searchParams.get('account') ?? '')), true;
        if (p === '/api/summary') return sendResult(res, await api.summary(url.searchParams.get('sessionId') ?? '')), true;
        return false;
      }
      if (req.method !== 'POST' || p !== '/api/action') return false;
      if (!limit.allow()) return sendResult(res, fail('rate_limited', 'too many requests; wait a few seconds')), true;
      // A cross-site form cannot set a custom header or send JSON without a preflight.
      if (req.headers['x-clayclaude'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json'))
        return sendResult(res, fail('forbidden', 'missing X-Clayclaude header or JSON content type')), true;
      const raw = await readBody(req);
      if (raw === null) return sendResult(res, fail('too_long', 'request body too large')), true;
      let parsed: z.SafeParseReturnType<unknown, z.infer<typeof Body>>;
      try { parsed = Body.safeParse(JSON.parse(raw)); } catch { return sendResult(res, fail('bad_request', 'invalid JSON')), true; }
      if (!parsed.success) return sendResult(res, fail('bad_request', parsed.error.issues[0]?.message ?? 'invalid request')), true;
      const b = parsed.data;
      switch (b.action) {
        case 'open': return sendResult(res, await api.open(b.sessionId)), true;
        case 'attach': return sendResult(res, await api.attach(b.sessionId)), true;
        case 'prompt': return sendResult(res, await api.readPrompt(b.sessionId)), true;
        case 'clear': return sendResult(res, await api.clear(b.sessionId)), true;
        case 'clear-stopped': return sendResult(res, await api.clearStopped()), true;
        case 'rename': return sendResult(res, await api.rename(b.sessionId, b.name, { tmux: b.tmux === true })), true;
        case 'launch': return sendResult(res, await api.launch({ account: b.account, repo: b.repo, options: b.options })), true;
        case 'answer':
          return sendResult(res, await api.answer(b.choice !== undefined
            ? { sessionId: b.sessionId, promptHash: b.promptHash, choice: b.choice }
            : { sessionId: b.sessionId, promptHash: b.promptHash, text: b.text! })), true;
      }
      return true;
    } catch (e) {
      return sendResult(res, fail('failed', e instanceof Error ? e.message.split('\n')[0] : 'internal error')), true;
    }
  };
}
