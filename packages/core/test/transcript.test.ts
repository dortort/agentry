import { describe, it, expect } from 'vitest';
import {
  EventFactory,
  RunRecord,
  ReplayDriver,
  recordTranscript,
  serializeTranscript,
  parseTranscript,
  type AgentEvent,
} from '@agentry/core';

describe('transcript record/replay', () => {
  it('records, round-trips, and ReplayDriver reconstructs the run without spawning', async () => {
    const f = new EventFactory('r', () => 0);
    const events: AgentEvent[] = [
      f.make({ type: 'tool_use', id: '1', name: 'read_file', args: { path: 'a.ts' } }, { turnId: 't', source: 'agent' }),
      f.make({ type: 'message', role: 'assistant', text: 'done' }, { turnId: 't', source: 'agent' }),
    ];
    const rec = new RunRecord(events, {
      exitCode: 0,
      reason: 'completed',
      usage: { inputTokens: 5, outputTokens: 9, costUSD: 0.001 },
    });

    const t = recordTranscript(rec, { prompt: 'hi', model: 'claude-haiku-4-5' });
    const round = parseTranscript(serializeTranscript(t));
    expect(round.prompt).toBe('hi');
    expect(round.model).toBe('claude-haiku-4-5');

    const replayed = await new ReplayDriver(round).run({ prompt: 'ignored', model: 'x', cwd: '/tmp' });
    expect(replayed.toolCalls).toHaveLength(1);
    expect(replayed.lastMessage).toBe('done');
    expect(replayed.usage.outputTokens).toBe(9);
    expect(replayed.result?.reason).toBe('completed');
  });

  it('falls back to aggregated usage when no result is present', () => {
    const f = new EventFactory('r', () => 0);
    const rec = new RunRecord([
      f.make({ type: 'usage', inputTokens: 3, outputTokens: 4 }, { turnId: 't', source: 'agent' }),
    ]);
    const t = recordTranscript(rec);
    expect(t.result.usage.outputTokens).toBe(4);
  });

  it('rejects an unsupported transcript version', () => {
    expect(() => parseTranscript(JSON.stringify({ version: 99, events: [], result: {} }))).toThrow();
  });
});
