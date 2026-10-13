import { describe, it, expect } from 'vitest';
import { parseSetupArgs } from '../src/commands/setup.js';

describe('parseSetupArgs', () => {
  it('finds the config path', () => {
    expect(parseSetupArgs([], '/home/u').configPath).toBe('/home/u/.config/clayclaude/config.yaml');
    expect(parseSetupArgs(['--config', '/x/c.yaml']).configPath).toBe('/x/c.yaml');
  });
  it('refuses unknown options and a --config with no path, instead of running against the default file', () => {
    expect(() => parseSetupArgs(['--bogus'])).toThrow(/unknown option "--bogus"/);
    expect(() => parseSetupArgs(['--config'])).toThrow(/--config needs a path/);
    expect(() => parseSetupArgs(['--config', '--bogus'])).toThrow(/--config needs a path/);
  });
});
