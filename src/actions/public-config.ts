import type { Config } from '../config.js';

/** What the settings panel and the demo may show. Never includes tokens or credential contents. */
export function publicConfig(cfg: Config) {
  return {
    hosts: cfg.hosts.map((h) => ({ id: h.id, ssh: h.ssh ?? null, tmuxSession: h.tmuxSession, repoRoots: h.repoRoots })),
    accounts: cfg.accounts.map((a) => ({ id: a.id, label: a.label, colour: a.colour, host: a.host, configDir: a.configDir, usage: a.usage.provider, open: a.open.type })),
    ui: cfg.ui,
    stoppedRetentionMs: cfg.stoppedRetentionMs,
    cacheTtlMinutes: cfg.cacheTtlMinutes,
    lan: { enabled: cfg.lan.enabled, hosts: cfg.lan.hosts },
  };
}
