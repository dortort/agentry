import { describe, it, expect } from 'vitest';
import { EventFactory, RunRecord, isEvent, type AgentEvent } from '@agentry/core';
import { parseAntigravityEvents } from '../src/driver';

// Captured agy stream-json ground-truth sample.
const SAMPLE = [
  {
    event: 'init',
    conversation_id: 'c1',
    init: { cwd: '/tmp/x', tools: ['write_to_file', 'run_command'], permission_mode: 'bypass' },
  },
  {
    event: 'step_update',
    step_update: { conversation_id: 'c1', step_index: 0, state: 'DONE', step_type: 'user_input' },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'c1',
      step_index: 3,
      state: 'DONE',
      step_type: 'agent_response',
      usage: { input_tokens: 16947, output_tokens: 702, thinking_tokens: 619, cache_read_tokens: 0, total_tokens: 17649 },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'c1',
      step_index: 4,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'write_to_file',
      tool_info: { name: 'write_to_file', parameters: { TargetFile: 'hello.txt' } },
    },
  },
  {
    event: 'step_update',
    step_update: {
      conversation_id: 'c1',
      step_index: 4,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'write_to_file',
      tool_info: { name: 'write_to_file', parameters: { TargetFile: 'hello.txt' } },
    },
  },
  {
    event: 'step_update',
    step_update: { conversation_id: 'c1', step_index: 7, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'done' },
  },
  {
    event: 'step_update',
    step_update: { conversation_id: 'c1', step_index: 7, state: 'DONE', step_type: 'agent_response', text_delta: '.' },
  },
  {
    event: 'result',
    result: {
      conversation_id: 'c1',
      status: 'SUCCESS',
      response: 'done.',
      duration_seconds: 12,
      num_turns: 1,
      usage: { input_tokens: 22664, output_tokens: 1084, thinking_tokens: 923, cache_read_tokens: 12164, total_tokens: 23748 },
    },
  },
];

function parseAll(): AgentEvent[] {
  const f = new EventFactory('r', () => 0);
  return parseAntigravityEvents(SAMPLE, f, 'r');
}

describe('parseAntigravityEvents', () => {
  const events = parseAll();
  const rec = new RunRecord(events);

  it('maps init to run.start with the antigravity agent', () => {
    const start = events.find((e) => isEvent(e, 'run.start'));
    expect(start && isEvent(start, 'run.start') && start.payload.agent).toBe('antigravity');
  });

  it('maps the tool step to a tool call', () => {
    expect(rec.toolCalls).toHaveLength(1);
    expect(rec.toolCalls[0]!.payload.name).toBe('write_to_file');
    expect(rec.toolCalls[0]!.payload.args).toEqual({ TargetFile: 'hello.txt' });
  });

  it('coalesces agent_response text_delta by step_index into one message', () => {
    expect(rec.assistantMessages).toHaveLength(1);
    expect(rec.lastMessage).toBe('done.');
  });

  it('maps the terminal result to authoritative usage + run.end completed', () => {
    const usage = events.filter((e) => isEvent(e, 'usage'));
    expect(usage).toHaveLength(1);
    expect(rec.usage.inputTokens).toBe(22664);
    expect(rec.usage.outputTokens).toBe(1084);
    const u = usage[0]!;
    expect(isEvent(u, 'usage') && u.payload.cacheReadTokens).toBe(12164);
    const end = events.find((e) => isEvent(e, 'run.end'));
    expect(end && isEvent(end, 'run.end') && end.payload.reason).toBe('completed');
  });
});
