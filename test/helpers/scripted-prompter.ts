import type { Prompter } from '../../src/setup/prompter.js';

/**
 * Answers prompts from rules (first matching regex wins); anything unmatched takes its default.
 * An answer may be a function of the question, called each time it is asked (for answers that change on a re-ask).
 */
export function scripted(rules: [RegExp, unknown][] = []) {
  const said: string[] = [];
  const asked: string[] = [];
  const find = (q: string) => { const r = rules.find(([re]) => re.test(q))?.[1]; return typeof r === 'function' ? r(q) : r; };
  const p: Prompter = {
    say: (m) => { said.push(m); },
    async ask(q, def) { asked.push(q); const r = find(q); return r === undefined ? def ?? '' : String(r); },
    async confirm(q, def = false) { asked.push(q); const r = find(q); return r === undefined ? def : Boolean(r); },
    async choose(q, options, def) { asked.push(q); const r = find(q); return (r === undefined ? def ?? options[0].value : r) as never; },
    async multi(q, _o, defaults) { asked.push(q); const r = find(q); return r === undefined ? defaults : (r as string[]); },
  };
  return { p, said, asked, text: () => said.join('\n') };
}
