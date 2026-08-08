import { describe, it, expect } from 'vitest';
import { EventFactory, RunRecord, isEvent } from '@agentry/core';
import { parseGeminiEvents } from '../src/driver';

// Sample Gemini stream-json events (captured ground truth).
const SAMPLE = [
  { type: 'init', timestamp: 't', session_id: 's1', model: 'gemini-2.5-flash' },
  { type: 'message', timestamp: 't', role: 'user', content: 'Create hello.txt containing hi, then say done.' },
  { type: 'tool_use', timestamp: 't', tool_name: 'write_file', tool_id: 'tc_1', parameters: { file_path: 'hello.txt', content: 'hi' } },
  { type: 'tool_result', timestamp: 't', tool_id: 'tc_1', status: 'success', output: 'Wrote hello.txt' },
  { type: 'message', timestamp: 't', role: 'assistant', content: 'I have created', delta: true },
  { type: 'message', timestamp: 't', role: 'assistant', content: ' hello.txt. done', delta: true },
  {
    type: 'result',
    timestamp: 't',
    status: 'success',
    stats: { total_tokens: 1200, input_tokens: 1000, output_tokens: 200, cached: 0, input: 1000, duration_ms: 1500, tool_calls: 1, models: {} },
  },
];

function parseAll() {
  const f = new EventFactory('r', () => 0);
  return parseGeminiEvents(SAMPLE, f, 'r');
}

describe('parseGeminiEvents', () => {
  const events = parseAll();
  const rec = new RunRecord(events);

  it('maps init to run.start with agent gemini', () => {
    const start = events.find((e) => isEvent(e, 'run.start'));
    expect(start && isEvent(start, 'run.start') && start.payload.agent).toBe('gemini');
    expect(start && isEvent(start, 'run.start') && start.payload.model).toBe('gemini-2.5-flash');
  });

  it('maps tool_use and tool_result', () => {
    expect(rec.toolCalls).toHaveLength(1);
    expect(rec.toolCalls[0]!.payload.name).toBe('write_file');
    expect(rec.toolCalls[0]!.payload.args).toEqual({ file_path: 'hello.txt', content: 'hi' });
    const results = events.filter((e) => isEvent(e, 'tool_result'));
    expect(results).toHaveLength(1);
    expect(isEvent(results[0]!, 'tool_result') && results[0]!.payload.id).toBe('tc_1');
    expect(isEvent(results[0]!, 'tool_result') && results[0]!.payload.isError).toBe(false);
  });

  it('coalesces consecutive assistant deltas into one message', () => {
    expect(rec.assistantMessages).toHaveLength(1);
    expect(rec.lastMessage).toBe('I have created hello.txt. done');
    expect(rec.turns).toBe(1);
  });

  it('maps result to usage + run.end completed', () => {
    const end = events.find((e) => isEvent(e, 'run.end'));
    expect(end && isEvent(end, 'run.end') && end.payload.reason).toBe('completed');
    const usage = events.filter((e) => isEvent(e, 'usage'));
    expect(usage).toHaveLength(1);
    expect(rec.usage.inputTokens).toBe(1000);
    expect(rec.usage.outputTokens).toBe(200);
  });
});
