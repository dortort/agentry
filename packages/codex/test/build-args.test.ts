import { describe, it, expect } from 'vitest';
import type { RunOptions } from '@agentry/core';
import { buildArgs } from '../src/driver';

const base: RunOptions = { prompt: 'create hello.txt', model: 'gpt-5-codex', cwd: '/tmp/x' };

describe('buildArgs', () => {
  it('emits the headless exec --json base invocation with the prompt last', () => {
    expect(buildArgs(base)).toEqual([
      'exec',
      '--json',
      '--color',
      'never',
      '--skip-git-repo-check',
      '--ephemeral',
      '-C',
      '/tmp/x',
      '-m',
      'gpt-5-codex',
      '--sandbox',
      'workspace-write',
      'create hello.txt',
    ]);
  });

  it('bypasses approvals/sandbox when permissionMode is bypassPermissions', () => {
    const args = buildArgs({ ...base, permissionMode: 'bypassPermissions' });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
    expect(args[args.length - 1]).toBe('create hello.txt');
  });

  it('appends extraArgs before the trailing prompt positional', () => {
    const args = buildArgs({ ...base, extraArgs: ['--foo', 'bar'] });
    expect(args.slice(-3)).toEqual(['--foo', 'bar', 'create hello.txt']);
  });
});
