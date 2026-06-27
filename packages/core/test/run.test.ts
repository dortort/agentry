import { describe, it, expect } from 'vitest';
import { EventFactory, RunRecord, asRunView, type AgentEvent } from '@agentry/core';

function sampleEvents(): AgentEvent[] {
  const f = new EventFactory('r', () => 0);
  return [
    f.make({ type: 'run.start', runId: 'r', agent: 'claude', model: 'm' }, { turnId: 't0', source: 'runner' }),
    f.make({ type: 'tool_use', id: '1', name: 'read_file', args: { path: 'a.ts' } }, { turnId: 't0', source: 'agent' }),
    f.make({ type: 'tool_use', id: '2', name: 'write_file', args: { path: 'b.ts' } }, { turnId: 't0', source: 'agent' }),
    f.make({ type: 'message', role: 'assistant', text: 'first' }, { turnId: 't0', source: 'agent' }),
    f.make({ type: 'message', role: 'assistant', text: 'final answer' }, { turnId: 't1', source: 'agent' }),
    f.make({ type: 'usage', inputTokens: 10, outputTokens: 20, costUSD: 0.001 }, { turnId: 't1', source: 'agent' }),
    f.make({ type: 'usage', inputTokens: 5, outputTokens: 7, costUSD: 0.002 }, { turnId: 't1', source: 'agent' }),
  ];
}

describe('RunRecord', () => {
  const rec = new RunRecord(sampleEvents());

  it('exposes tool calls and finds by name/regex', () => {
    expect(rec.toolCalls).toHaveLength(2);
    expect(rec.findToolCalls('read_file')).toHaveLength(1);
    expect(rec.findToolCalls(/_file$/)).toHaveLength(2);
    expect(rec.findToolCalls('missing')).toHaveLength(0);
  });

  it('returns the last assistant message as lastMessage/output', () => {
    expect(rec.lastMessage).toBe('final answer');
    expect(rec.output).toBe('final answer');
    expect(rec.assistantMessages).toHaveLength(2);
    expect(rec.turns).toBe(2);
  });

  it('aggregates usage from usage events', () => {
    expect(rec.usage.inputTokens).toBe(15);
    expect(rec.usage.outputTokens).toBe(27);
    expect(rec.usage.costUSD).toBeCloseTo(0.003);
  });

  it('asRunView accepts a RunRecord and rejects other objects', () => {
    expect(asRunView(rec)).toBe(rec);
    expect(() => asRunView({ foo: 1 })).toThrow();
  });
});
