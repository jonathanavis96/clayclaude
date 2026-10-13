export const USAGE = `usage:
  clayclaude serve [--config <path>]            run the daemon
  clayclaude setup [--config <path>]            discover accounts and write the config
  clayclaude demo [--port N (default 8421)] [--scenario board|gallery] [--speed N] [--sessions N] [--adb] [--kiosk]
                                                a fixture board; nothing real is touched`;

/** Run `demo` and `setup`. Returns false for any other command; the caller handles `serve`. */
export async function dispatch(cmd: string | undefined, rest: string[]): Promise<boolean> {
  if (cmd === 'demo') { await (await import('./demo.js')).runDemo(rest); return true; }
  if (cmd === 'setup') { await (await import('./setup.js')).runSetupCommand(rest); return true; }
  return false;
}
