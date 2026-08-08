import { describe, it, expect } from 'vitest';
import type { RunOptions } from '@agentry/core';
import { buildArgs } from '../src/driver';

const base: RunOptions = { prompt: 'Create hello.txt', model: 'gemini-2.5-flash', cwd: '/tmp/x' };

describe('buildArgs', () => {
  it('emits the headless stream-json base invocation', () => {
    expect(buildArgs(base)).toEqual([
      '-p',
      'Create hello.txt',
      '--output-format',
      'stream-json',
      '-m',
      'gemini-2.5-flash',
      '--skip-trust',
      '--approval-mode',
      'default',
    ]);
  });

  it('uses yolo approval mode when permissionMode is bypassPermissions', () => {
    const args = buildArgs({ ...base, permissionMode: 'bypassPermissions' });
    const i = args.indexOf('--approval-mode');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe('yolo');
  });

  it('appends extraArgs verbatim at the end', () => {
    const args = buildArgs({ ...base, extraArgs: ['--foo', 'bar'] });
    expect(args.slice(-2)).toEqual(['--foo', 'bar']);
  });
});
