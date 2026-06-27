import { describe, it, expect } from 'vitest';
import { EventFactory, RunRecord, isEvent, type AgentEvent } from '@agentry/core';
import { parseClaudeEvent } from '../src/driver';

// Sample Claude stream-json events, shaped per Phase 0 findings.
const SAMPLE = [
  { type: 'system', subtype: 'init', model: 'claude-haiku-4-5', plugins: [{ name: 'omc', source: 'omc@x' }], tools: ['Bash', 'Read'], mcp_servers: [] },
  { type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', hook_event: 'SessionStart', outcome: 'success', exit_code: 0 },
  { type: 'assistant', message: { id: 'msg1', content: [{ type: 'text', text: 'reading now' }] } },
  { type: 'assistant', message: { id: 'msg2', content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const x = 1', is_error: false }] } },
  { type: 'assistant', message: { id: 'msg3', content: [{ type: 'text', text: 'done' }] } },
  { type: 'rate_limit_event', rate_limit_info: {} },
  { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', terminal_reason: 'completed', num_turns: 2, total_cost_usd: 0.0248, usage: { input_tokens: 10, output_tokens: 179 } },
];

function parseAll(): AgentEvent[] {
  const f = new EventFactory('r', () => 0);
  return SAMPLE.flatMap((raw) => parseClaudeEvent(raw, f, 'r'));
}

describe('parseClaudeEvent', () => {
  const events = parseAll();
  const rec = new RunRecord(events);

  it('maps init to run.start + plugin loaded', () => {
    const start = events.find((e) => isEvent(e, 'run.start'));
    expect(start && isEvent(start, 'run.start') && start.payload.model).toBe('claude-haiku-4-5');
    expect(rec.plugins.some((p) => p.payload.event === 'loaded' && p.payload.name === 'omc')).toBe(true);
  });

  it('maps assistant text and tool_use', () => {
    expect(rec.toolCalls).toHaveLength(1);
    expect(rec.toolCalls[0]!.payload.name).toBe('read_file');
    expect(rec.toolCalls[0]!.payload.args).toEqual({ path: 'a.ts' });
    expect(rec.lastMessage).toBe('done');
    expect(rec.assistantMessages).toHaveLength(2);
  });

  it('maps tool_result and hook_response', () => {
    const results = events.filter((e) => isEvent(e, 'tool_result'));
    expect(results).toHaveLength(1);
    expect(isEvent(results[0]!, 'tool_result') && results[0]!.payload.id).toBe('toolu_1');
    expect(rec.plugins.some((p) => p.payload.event === 'hook-fired')).toBe(true);
  });

  it('maps result to usage + run.end and ignores rate_limit_event', () => {
    const end = events.find((e) => isEvent(e, 'run.end'));
    expect(end && isEvent(end, 'run.end') && end.payload.reason).toBe('completed');
    const usage = events.filter((e) => isEvent(e, 'usage'));
    expect(usage).toHaveLength(1);
    expect(rec.usage.inputTokens).toBe(10);
    expect(rec.usage.outputTokens).toBe(179);
    expect(rec.usage.costUSD).toBeCloseTo(0.0248);
  });
});
