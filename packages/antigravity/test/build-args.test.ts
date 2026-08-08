import { describe, it, expect } from 'vitest';
import type { RunOptions } from '@agentry/core';
import { buildArgs } from '../src/driver';

const base: RunOptions = { prompt: 'write hello.txt', model: 'claude-sonnet-4-6', cwd: '/tmp/x' };

describe('buildArgs', () => {
  it('emits the headless stream-json base invocation', () => {
    expect(buildArgs(base)).toEqual([
      '-p',
      'write hello.txt',
      '--output-format',
      'stream-json',
      '--model',
      'claude-sonnet-4-6',
      '--add-dir',
      '/tmp/x',
    ]);
  });

  it('adds --dangerously-skip-permissions for bypassPermissions', () => {
    expect(buildArgs({ ...base, permissionMode: 'bypassPermissions' })).toContain('--dangerously-skip-permissions');
  });

  it('omits --dangerously-skip-permissions by default', () => {
    expect(buildArgs(base)).not.toContain('--dangerously-skip-permissions');
  });

  it('appends extraArgs verbatim at the end', () => {
    const args = buildArgs({ ...base, extraArgs: ['--foo', 'bar'] });
    expect(args.slice(-2)).toEqual(['--foo', 'bar']);
  });
});
