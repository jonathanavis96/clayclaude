import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface Option<T extends string = string> { value: T; label: string }

export interface Prompter {
  say(msg: string): void;
  ask(question: string, def?: string): Promise<string>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  choose<T extends string>(question: string, options: Option<T>[], def?: T): Promise<T>;
  multi(question: string, options: Option[], defaults: string[]): Promise<string[]>;
}

/** Thrown by a pending question when the input ends (Ctrl-D, Ctrl-C, or piped answers ran out). */
export class InputClosed extends Error { constructor() { super('input ended before setup finished'); } }

/**
 * Plain-terminal prompts: numbered lists, defaults in brackets, Enter accepts the default.
 * Lines are queued as they arrive, so answers typed ahead or piped in are never lost (readline's `question`
 * drops any line that arrives while no question is pending).
 */
export function readlinePrompter(input: Readable = process.stdin, output: Writable = process.stdout): Prompter & { close(): void } {
  const rl = createInterface({ input, output });
  const lines: string[] = [];
  let waiting: { resolve(l: string): void; reject(e: Error): void } | undefined;
  let closed = false;
  rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = undefined; w.resolve(l); } else lines.push(l); });
  rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = undefined; w.reject(new InputClosed()); } });
  rl.on('SIGINT', () => rl.close());
  const line = (q: string) => {
    if (closed) output.write(q); // piped answers can outlive the input stream; readline refuses prompt() once closed
    else { rl.setPrompt(q); rl.prompt(); }
    if (lines.length) return Promise.resolve(lines.shift()!);
    if (closed) return Promise.reject(new InputClosed());
    return new Promise<string>((resolve, reject) => { waiting = { resolve, reject }; });
  };
  const say = (m: string) => { output.write(m + '\n'); };
  const ask = async (q: string, def?: string) => ((await line(`${q}${def ? ` [${def}]` : ''} `)).trim() || def || '');
  return {
    say, ask,
    close: () => rl.close(),
    async confirm(q, def = false) {
      for (;;) {
        const a = (await line(`${q} [${def ? 'Y/n' : 'y/N'}] `)).trim().toLowerCase();
        if (a === '') return def;
        if (a === 'y' || a === 'yes') return true;
        if (a === 'n' || a === 'no') return false;
      }
    },
    async choose<T extends string>(q: string, options: Option<T>[], def?: T) {
      say(q);
      options.forEach((o, i) => say(`  ${i + 1}. ${o.label}`));
      const di = Math.max(0, options.findIndex((o) => o.value === def));
      for (;;) {
        const n = Number((await line(`Choose 1-${options.length} [${di + 1}] `)).trim() || di + 1);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
      }
    },
    async multi(q, options, defaults) {
      say(q);
      options.forEach((o, i) => say(`  ${i + 1}. ${o.label}${defaults.includes(o.value) ? ' (default)' : ''}`));
      const raw = (await line('Numbers separated by commas, "none", or Enter for the defaults: ')).trim().toLowerCase();
      if (raw === '') return defaults;
      if (raw === 'none') return [];
      return raw.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= options.length).map((n) => options[n - 1].value);
    },
  };
}
