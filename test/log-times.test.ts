import { describe, it, expect } from 'vitest';
import { localStamp, stampConsole } from '../src/log-times.js';

describe('log times', () => {
  it('stamps local time with an offset that names the same instant', () => {
    const d = new Date('2026-11-24T11:35:25.000Z');
    const s = localStamp(d);
    expect(s).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(Date.parse(s)).toBe(d.getTime());
  });

  it('puts the stamp before log, warn and error, and keeps the other arguments', () => {
    const got: unknown[][] = [];
    const out = { log: (...a: unknown[]) => { got.push(a); }, warn: (...a: unknown[]) => { got.push(a); }, error: (...a: unknown[]) => { got.push(a); } };
    const d = new Date('2026-11-24T11:35:25.000Z');
    stampConsole(out as any, () => d);
    out.log('a'); out.warn('b', 1); out.error('c');
    expect(got).toEqual([[localStamp(d), 'a'], [localStamp(d), 'b', 1], [localStamp(d), 'c']]);
  });
});
