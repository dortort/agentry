import { describe, it, expect } from 'vitest';
import type { RunOptions } from '@agentry/core';
import { buildArgs } from '../src/driver';

const base: RunOptions = { prompt: '/scheduler:status', model: 'claude-haiku-4-5', cwd: '/tmp/x' };

describe('buildArgs', () => {
  it('emits the headless stream-json base invocation', () => {
    expect(buildArgs(base)).toEqual([
      '-p',
      '/scheduler:status',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      'claude-haiku-4-5',
    ]);
  });

  it('passes --plugin-dir <dir> when pluginDir is set', () => {
    const args = buildArgs({ ...base, pluginDir: '/repo/root' });
    const i = args.indexOf('--plugin-dir');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('/repo/root');
  });

  it('omits --plugin-dir when pluginDir is absent', () => {
    expect(buildArgs(base)).not.toContain('--plugin-dir');
  });

  it('appends extraArgs verbatim at the end', () => {
    const args = buildArgs({ ...base, extraArgs: ['--foo', 'bar'] });
    expect(args.slice(-2)).toEqual(['--foo', 'bar']);
  });
});
