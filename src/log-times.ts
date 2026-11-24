/** Local time with its UTC offset, to the second: 2026-11-24T13:35:25+02:00. */
export function localStamp(d = new Date()): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `${off < 0 ? '-' : '+'}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

type Out = Pick<Console, 'log' | 'warn' | 'error'>;

/** Put the time in front of every line group written to `out`: a log file kept for weeks has no other record of when. */
export function stampConsole(out: Out = console, now: () => Date = () => new Date()): void {
  for (const k of ['log', 'warn', 'error'] as const) {
    const write = out[k].bind(out);
    out[k] = (...args: unknown[]) => { write(localStamp(now()), ...args); };
  }
}
