import { describe, it, expect } from 'vitest';
import { summarize, formatConsole, type TestResult } from '@agentry/core';

const results: TestResult[] = [
  { name: 'a', suite: ['s'], status: 'passed', durationMs: 5, mode: 'replay', costUSD: 0.001 },
  { name: 'b', suite: [], status: 'failed', durationMs: 9, mode: 'replay', error: 'boom' },
  { name: 'c', suite: [], status: 'skipped', durationMs: 0, mode: 'dry' },
];

describe('reporter', () => {
  it('summarize counts statuses and totals cost', () => {
    expect(summarize(results)).toEqual({ passed: 1, failed: 1, skipped: 1, totalCostUSD: 0.001 });
  });

  it('formatConsole renders titles, icons, errors, and a summary line', () => {
    const out = formatConsole(results);
    expect(out).toContain('s › a');
    expect(out).toContain('✗ b');
    expect(out).toContain('boom');
    expect(out).toContain('1 passed · 1 failed · 1 skipped');
  });
});
