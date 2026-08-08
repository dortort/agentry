import { describe, it, expect } from 'vitest';
import { EventFactory, RunRecord, isEvent, type AgentEvent } from '@agentry/core';
import { parseCodexEvent } from '../src/driver';

// Captured Codex `exec --json` events (ground truth — do not alter).
const SAMPLE = [
  { type: 'thread.started', thread_id: 'th_test' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'working' } },
  {
    type: 'item.started',
    item: { id: 'item_1', type: 'file_change', changes: [{ path: 'hello.txt', kind: 'add' }], status: 'in_progress' },
  },
  {
    type: 'item.completed',
    item: { id: 'item_1', type: 'file_change', changes: [{ path: 'hello.txt', kind: 'add' }], status: 'completed' },
  },
  {
    type: 'item.started',
    item: {
      id: 'item_2',
      type: 'command_execution',
      command: "/bin/zsh -lc 'cat hello.txt'",
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_2',
      type: 'command_execution',
      command: "/bin/zsh -lc 'cat hello.txt'",
      aggregated_output: 'hi\n',
      exit_code: 0,
      status: 'completed',
    },
  },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'done' } },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 76678,
      cached_input_tokens: 65536,
      cache_write_input_tokens: 0,
      output_tokens: 214,
      reasoning_output_tokens: 24,
    },
  },
];

function parseAll(): AgentEvent[] {
  const f = new EventFactory('r', () => 0);
  const events = SAMPLE.flatMap((raw) => parseCodexEvent(raw, f, 'r'));
  events.push(
    f.make(
      { type: 'run.end', runId: 'r', exitCode: 0, reason: 'completed' },
      { turnId: 'result', source: 'runner', agentNativeType: 'synthetic' },
    ),
  );
  return events;
}

describe('parseCodexEvent', () => {
  const events = parseAll();
  const rec = new RunRecord(events);

  it('maps thread.started to run.start with agent codex', () => {
    const start = events.find((e) => isEvent(e, 'run.start'));
    expect(start && isEvent(start, 'run.start') && start.payload.agent).toBe('codex');
  });

  it('maps file_change and command_execution to tool_use/tool_result', () => {
    expect(rec.toolCalls).toHaveLength(2);
    expect(rec.findToolCalls('apply_patch')).toHaveLength(1);
    expect(rec.findToolCalls('shell')).toHaveLength(1);

    const results = events.filter((e) => isEvent(e, 'tool_result'));
    expect(results).toHaveLength(2);
    const shellResult = results.find((e) => isEvent(e, 'tool_result') && e.payload.name === 'shell');
    expect(shellResult && isEvent(shellResult, 'tool_result') && shellResult.payload.result).toBe('hi\n');
    expect(shellResult && isEvent(shellResult, 'tool_result') && shellResult.payload.isError).toBe(false);
  });

  it('maps agent_message items to assistant messages', () => {
    expect(rec.assistantMessages).toHaveLength(2);
    expect(rec.lastMessage).toBe('done');
  });

  it('maps turn.completed usage without cost', () => {
    const usage = events.filter((e) => isEvent(e, 'usage'));
    expect(usage).toHaveLength(1);
    expect(rec.usage.inputTokens).toBe(76678);
    expect(rec.usage.outputTokens).toBe(214);
    expect(isEvent(usage[0]!, 'usage') && usage[0]!.payload.cacheReadTokens).toBe(65536);
    expect(isEvent(usage[0]!, 'usage') && usage[0]!.payload.cacheCreationTokens).toBe(0);
    expect(isEvent(usage[0]!, 'usage') && usage[0]!.payload.costUSD).toBeUndefined();
  });

  it('yields a terminal run.end with reason completed on clean close', () => {
    const end = events.find((e) => isEvent(e, 'run.end'));
    expect(end && isEvent(end, 'run.end') && end.payload.reason).toBe('completed');
  });
});
