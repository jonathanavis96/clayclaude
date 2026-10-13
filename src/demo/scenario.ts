import type { AccountUsage, Session, SessionState } from '../types.js';

/** One stretch of a session's scripted life, in minutes since the start of the cycle. */
export interface Seg { state: SessionState; fromMin: number; toMin: number }

export interface DemoDef {
  id: string;
  name: string;
  account: 'studio' | 'lab' | 'side';
  host: 'desk' | 'rack';
  tmux?: string;
  bridge?: string;
  model: string;
  effort: string;
  contextPct: number;
  /** Cycle of states. The session loops through it as demo time passes. */
  segments: Seg[];
  /** Where in the cycle the session starts, in minutes. */
  offsetMin: number;
  question?: string;
  /** `trust`: Claude's folder-trust question, on a launch it has not registered yet (Task 40). */
  prompt?: 'menu' | 'text' | 'trust';
  /** A launch Claude has not registered yet: shown as STARTING (Task 40). */
  starting?: true;
  failOpen?: boolean;
  lastPrompt: string;
  lastReply: string;
}

const seg = (state: SessionState, fromMin: number, toMin: number): Seg => ({ state, fromMin, toMin });
const FOREVER = 1_000_000;

const ACTIONS = [
  'Read: src/routes/orders.ts', 'Edit: src/routes/orders.ts', 'Bash: npm test -- --run', 'Grep: retryAfter',
  'Write: src/lib/backoff.ts', 'Bash: git diff --stat', 'Read: package.json', 'Edit: src/lib/backoff.ts',
];

/** The default board: ten believable sessions across three accounts, all six states. */
export const BOARD: DemoDef[] = [
  { id: 'orchard-api', name: 'orchard-api', account: 'studio', host: 'desk', tmux: 'desk:@1.%1', bridge: 'session_demo01orchard', model: 'claude-opus-5-5', effort: 'high', contextPct: 46,
    segments: [seg('working', 0, 75), seg('asleep', 75, 135)], offsetMin: 8, lastPrompt: 'Add retry with backoff to the order sync', lastReply: 'Retry logic is in and the order tests pass. I left the backoff ceiling configurable.' },
  { id: 'tidepool-ui', name: 'tidepool-ui', account: 'studio', host: 'desk', tmux: 'desk:@2.%2', bridge: 'session_demo02tidepool', model: 'claude-opus-5-5', effort: 'medium', contextPct: 63,
    segments: [seg('needs-you', 0, 90)], offsetMin: 4, prompt: 'menu', question: 'Allow Bash: npm run build?', lastPrompt: 'Ship the new tide chart component', lastReply: 'The chart renders. I need to run the build to check the bundle size.' },
  { id: 'lantern-docs', name: 'lantern-docs', account: 'lab', host: 'rack', tmux: 'agents:@3.%3', bridge: 'session_demo03lantern', model: 'claude-sonnet-5-5', effort: 'medium', contextPct: 38,
    segments: [seg('needs-you', 0, 90)], offsetMin: 12, prompt: 'text', question: 'Should I also update the changelog, or leave it for the release PR?', lastPrompt: 'Document the new export flags', lastReply: 'The flag reference is written and linked from the index.' },
  { id: 'mossgarden-infra', name: 'mossgarden-infra', account: 'lab', host: 'rack', tmux: 'agents:@4.%4', bridge: 'session_demo04moss', model: 'claude-sonnet-5-5', effort: 'high', contextPct: 71, failOpen: true,
    segments: [seg('working', 0, 120)], offsetMin: 40, lastPrompt: 'Move the staging config into modules', lastReply: 'Two modules extracted; the plan shows no drift yet.' },
  { id: 'pebble-cli', name: 'pebble-cli', account: 'side', host: 'desk', tmux: 'desk:@5.%5', model: 'claude-haiku-5', effort: 'low', contextPct: 22,
    segments: [seg('asleep', 0, 70), seg('working', 70, 100)], offsetMin: 20, lastPrompt: 'Add a --json flag to the list command', lastReply: 'Done: `pebble list --json` prints one object per line.' },
  { id: 'quill-site', name: 'quill-site', account: 'studio', host: 'desk', tmux: 'desk:@6.%6', bridge: 'session_demo06quill', model: 'claude-opus-5-5', effort: 'high', contextPct: 54,
    segments: [seg('asleep', 0, 90), seg('working', 90, 96)], offsetMin: 57, lastPrompt: 'Tidy the footer links', lastReply: 'Footer links are grouped and the dead ones are gone.' },
  { id: 'ember-sync', name: 'ember-sync', account: 'lab', host: 'rack', tmux: 'agents:@7.%7', bridge: 'session_demo07ember', model: 'claude-opus-5-5', effort: 'high', contextPct: 88,
    segments: [seg('compacting', 0, 3), seg('working', 3, 40)], offsetMin: 1, lastPrompt: 'Make the sync resumable', lastReply: 'Checkpointing is in; compacting before the next step.' },
  { id: 'riverbank-etl', name: 'riverbank-etl', account: 'side', host: 'desk', model: 'claude-opus-5-5', effort: 'medium', contextPct: 57,
    segments: [seg('limit', 0, 120)], offsetMin: 30, lastPrompt: 'Backfill the March partitions', lastReply: 'Usage limit reached. It resets later today.' },
  { id: 'old-prototype', name: 'old-prototype', account: 'side', host: 'desk', model: 'claude-sonnet-5-5', effort: 'low', contextPct: 31,
    segments: [seg('stopped', 0, FOREVER)], offsetMin: 140, lastPrompt: 'Try the canvas idea', lastReply: 'The canvas prototype runs at 60 fps.' },
  { id: 'fernwood-app', name: 'fernwood-app', account: 'studio', host: 'desk', tmux: 'desk:@8.%8', bridge: 'session_demo09fern', model: 'claude-opus-5-5', effort: 'xhigh', contextPct: 91,
    segments: [seg('working', 0, 90)], offsetMin: 15, lastPrompt: 'Migrate the auth screens', lastReply: 'Login and reset screens are migrated; signup is next.' },
];

/** Frozen gallery: one session per animation bracket, so every clay state is on screen at once. */
const G = (id: string, state: SessionState, ageMin: number, extra: Partial<DemoDef> = {}): DemoDef => ({
  id, name: id, account: (['studio', 'lab', 'side'] as const)[id.length % 3], host: 'desk', tmux: 'desk:@1.%1', bridge: 'session_demo' + id.replace(/\W/g, ''),
  model: 'claude-opus-5-5', effort: 'high', contextPct: 40, segments: [seg(state, 0, FOREVER)], offsetMin: ageMin,
  lastPrompt: 'Gallery session', lastReply: 'Gallery reply.', ...extra,
});
export const GALLERY: DemoDef[] = [
  // working: W1 0–1, W2 1–5, W3 5–15, W4 15–30, W5 30–60, W6 60–120, W7 120+ min (spec §7.2)
  G('w1-sleeves', 'working', 0.5), G('w2-typing', 'working', 3), G('w3-zone', 'working', 9), G('w4-headphones', 'working', 22),
  G('w5-sweat', 'working', 45), G('w6-headband', 'working', 90), G('w7-coffee', 'working', 150),
  // needs you: N1 0–1, N2 1–5, N3 5–10, N4 10–30, N5 30–(TTL−5), N6 (TTL−5)–TTL, N7 TTL+ (TTL 60)
  G('n1-wave', 'needs-you', 0.5, { question: 'Allow Bash: npm test?', prompt: 'menu' }), G('n2-tapping', 'needs-you', 3, { question: 'Which database?', prompt: 'text' }),
  G('n3-watch', 'needs-you', 7), G('n4-sign', 'needs-you', 18), G('n5-knock', 'needs-you', 40), G('n6-hourglass', 'needs-you', 57), G('n7-ice', 'needs-you', 70),
  // asleep: the same brackets as needs you
  G('s1-stretch', 'asleep', 0.5), G('s2-tea', 'asleep', 3), G('s3-doze', 'asleep', 7), G('s4-bed', 'asleep', 18),
  G('s5-snore', 'asleep', 40), G('s6-alarm', 'asleep', 57), G('s7-frozen', 'asleep', 70),
  G('x1-stopped', 'stopped', 130), G('x3-limit', 'limit', 20), G('x4-compact', 'compacting', 1),
  G('x2-puffed', 'working', 9, { contextPct: 92 }),
];

export interface Clock { virtualMin(): number }
export function createClock(speed: number, now: () => number = Date.now): Clock {
  const t0 = now();
  return { virtualMin: () => ((now() - t0) / 60_000) * speed };
}

export interface SessionOverride { state: SessionState; since: number }

export function sessionAt(def: DemoDef, virtualMin: number, nowMs: number, cacheTtlMinutes: number, i: number, override?: SessionOverride): Session {
  const cycle = def.segments[def.segments.length - 1].toMin;
  const p = (def.offsetMin + virtualMin) % cycle;
  const s = def.segments.find((x) => p >= x.fromMin && p < x.toMin) ?? def.segments[0];
  let state = s.state;
  let stateSince = nowMs - (p - s.fromMin) * 60_000;
  if (override) { state = override.state; stateSince = override.since; }
  const live = state !== 'stopped';
  const lastAssistantAt = state === 'working' ? nowMs - 3000 : stateSince;
  const contextPct = def.contextPct;
  const needs = state === 'needs-you';
  return {
    key: `${def.host}:${def.account}:${def.id}`, host: def.host, account: def.account, sessionId: `demo-${def.id}`, pid: 40_000 + i,
    name: def.name, cwd: `/home/demo/code/${def.name}`, state, stateSince, live,
    tmux: def.tmux, bridgeSessionId: def.bridge, model: def.model, effort: def.effort, contextPct,
    currentAction: state === 'working' ? def.starting ? 'Starting Claude…' : ACTIONS[(Math.floor(virtualMin * 4) + i) % ACTIONS.length] : undefined,
    question: needs ? def.question ?? 'Waiting for you' : undefined,
    lastAssistantAt, cacheExpiresAt: lastAssistantAt + cacheTtlMinutes * 60_000,
    overContext: contextPct >= 85, hostOnline: true, lastSeen: nowMs,
    ...(def.starting ? { starting: true as const } : {}),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
export function demoUsage(nowMs: number): AccountUsage[] {
  const mk = (account: string, label: string, colour: string, five: number, week: number, email: string, plan: string | null = null): AccountUsage => ({
    account, label, colour, email, name: `${label} Demo`, plan, fiveHour: five, weekly: week,
    fiveHourResetsAt: iso(nowMs + 2.5 * 3600_000), weeklyResetsAt: iso(nowMs + 3 * 86_400_000), stale: false, updatedAt: nowMs,
  });
  return [mk('studio', 'Studio', '#e8b54a', 82, 54, 'studio@example.test', 'Max 20x'), mk('lab', 'Lab', '#4fd1c5', 41, 63, 'lab@example.test', 'Pro'), mk('side', 'Side', '#a78bfa', 12, 30, 'side@example.test')];
}

export const DEMO_YAML = `
port: 8420
cacheTtlMinutes: 60
hosts:
  - { id: desk }
  - { id: rack, ssh: rack, tmuxSession: agents, repoRoots: [~/code] }
accounts:
  - { id: studio, label: Studio, colour: "#e8b54a", host: desk, configDir: /demo/studio, usage: { provider: none }, open: { type: app } }
  - { id: lab, label: Lab, colour: "#4fd1c5", host: rack, configDir: ~/.demo-lab, usage: { provider: none }, open: { type: chrome, profileDirectory: "Profile 2" } }
  - { id: side, label: Side, colour: "#a78bfa", host: desk, configDir: /demo/side, usage: { provider: none }, open: { type: tmux } }
launch: { allowBypassPermissions: true }
`;

/** The model list the demo's accounts "discover" (Task 46), older models included, as the models API lists them. */
export const DEMO_MODELS = [
  ['claude-opus-5-5', 'Opus 5.5', '2026-09-01'], ['claude-sonnet-5-5', 'Sonnet 5.5', '2026-09-02'], ['claude-haiku-5-5', 'Haiku 5.5', '2026-09-03'],
  ['claude-fable-5-1', 'Fable 5.1', '2026-08-01'], ['claude-opus-5', 'Opus 5', '2026-05-01'], ['claude-sonnet-5', 'Sonnet 5', '2026-05-02'],
  ['claude-fable-5', 'Fable 5', '2026-04-01'], ['claude-opus-4-8', 'Opus 4.8', '2026-02-01'], ['claude-opus-4-7', 'Opus 4.7', '2025-11-01'],
  ['claude-haiku-4-5-20251001', 'Haiku 4.5', '2025-10-01'], ['claude-opus-4-6', 'Opus 4.6', '2025-08-01'],
].map(([id, name, created]) => ({ id, name, created: `${created}T00:00:00Z` }));
