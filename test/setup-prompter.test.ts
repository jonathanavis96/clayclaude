import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { InputClosed, readlinePrompter } from '../src/setup/prompter.js';

/** A terminal that types the next answer each time the prompter asks something (output not ending in a newline). */
function terminal(answers: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (b: Buffer) => {
    shown += b.toString();
    if (!shown.endsWith('\n') && answers.length) input.write(answers.shift() + '\n');
  });
  const p = readlinePrompter(input, output);
  return { p, shown: () => shown };
}

describe('readlinePrompter', () => {
  it('takes defaults on Enter and parses yes/no, numbered choices and lists', async () => {
    const t = terminal(['', 'typed', 'maybe', 'y', '', '9', '2', '1, 3', 'none', '']);
    expect(await t.p.ask('Name?', 'dflt')).toBe('dflt');
    expect(await t.p.ask('Other?')).toBe('typed');
    expect(await t.p.confirm('Sure?')).toBe(true);           // "maybe" is asked again, then "y"
    expect(await t.p.confirm('Again?', true)).toBe(true);    // Enter takes the default
    const opts = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
    expect(await t.p.choose('Pick', opts, 'a')).toBe('b');  // 9 is out of range, asked again
    expect(await t.p.multi('Several', opts, ['b'])).toEqual(['a', 'c']);
    expect(await t.p.multi('Several', opts, ['b'])).toEqual([]);
    expect(await t.p.multi('Several', opts, ['b'])).toEqual(['b']);
    t.p.close();
    expect(t.shown()).toContain('Name? [dflt]');
    expect(t.shown()).toContain('  2. B');
    expect(t.shown()).toContain('  2. B (default)');
  });

  it('keeps answers that arrive before the question (piped or typed ahead)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = readlinePrompter(input, output);
    input.write('first\nsecond\n\ny\n');
    await new Promise((r) => setImmediate(r));
    expect(await p.ask('One?')).toBe('first');
    expect(await p.ask('Two?')).toBe('second');
    expect(await p.ask('Three?', 'd')).toBe('d');
    expect(await p.confirm('Four?')).toBe(true);
    p.close();
  });

  it('rejects a pending question when the input ends, instead of hanging', async () => {
    const input = new PassThrough();
    const p = readlinePrompter(input, new PassThrough());
    input.write('first\nsecond\n');
    input.end();
    await new Promise((r) => setImmediate(r));   // the input has closed with two answers still queued
    expect(await p.ask('One?')).toBe('first');
    expect(await p.ask('Two?')).toBe('second');
    await expect(p.ask('Three?')).rejects.toBeInstanceOf(InputClosed);
  });
});
