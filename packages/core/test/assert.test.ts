import { describe, it, expect as v, afterEach } from 'vitest';
import { EventFactory, RunRecord, Sandbox, type AgentEvent } from '@agentry/core';
import { expect, subsetMatch } from '../src/assert';

function rec(): RunRecord {
  const f = new EventFactory('r', () => 0);
  const ev: AgentEvent[] = [
    f.make({ type: 'tool_use', id: '1', name: 'read_file', args: { path: 'a.ts' } }, { turnId: 't', source: 'agent' }),
    f.make({ type: 'tool_use', id: '2', name: 'read_file', args: { path: 'b.ts' } }, { turnId: 't', source: 'agent' }),
    f.make({ type: 'mcp_request', server: 'fs', method: 'tools/call', params: { name: 'read_file' } }, { turnId: 't', source: 'mcp-proxy' }),
    f.make({ type: 'message', role: 'assistant', text: 'done' }, { turnId: 't', source: 'agent' }),
    f.make({ type: 'usage', inputTokens: 100, outputTokens: 50 }, { turnId: 't', source: 'agent' }),
  ];
  return new RunRecord(ev);
}

describe('subsetMatch', () => {
  it('matches object subsets, arrays, and regex leaves', () => {
    v(subsetMatch({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    v(subsetMatch({ a: 1 }, { a: 2 })).toBe(false);
    v(subsetMatch({ p: 'invoice.pdf' }, { p: /\.pdf$/ })).toBe(true);
    v(subsetMatch({ x: { y: 1 } }, { x: { y: 1 } })).toBe(true);
  });
});

describe('tool-call matchers', () => {
  const r = rec();
  it('toHaveToolCall by name and args (+ negation)', () => {
    v(() => expect(r).toHaveToolCall('read_file')).not.toThrow();
    v(() => expect(r).toHaveToolCall('read_file', { path: 'a.ts' })).not.toThrow();
    v(() => expect(r).toHaveToolCall('read_file', { path: 'zzz' })).toThrow();
    v(() => expect(r).toHaveToolCall('write_file')).toThrow();
    v(() => expect(r).not.toHaveToolCall('write_file')).not.toThrow();
  });
  it('counts, allow-list, required-list', () => {
    v(() => expect(r).toHaveCalledToolTimes('read_file', 2)).not.toThrow();
    v(() => expect(r).toHaveCalledToolTimes('read_file', 1)).toThrow();
    v(() => expect(r).toUseToolsFrom(['read_file'])).not.toThrow();
    v(() => expect(r).toUseToolsFrom(['search'])).toThrow();
    v(() => expect(r).toHaveCalledAll(['read_file'])).not.toThrow();
    v(() => expect(r).toHaveCalledAll(['read_file', 'search'])).toThrow();
  });
});

describe('mcp + budget matchers', () => {
  const r = rec();
  it('toHaveMcpRequest', () => {
    v(() => expect(r).toHaveMcpRequest({ method: 'tools/call', name: 'read_file' })).not.toThrow();
    v(() => expect(r).toHaveMcpRequest({ method: 'tools/list' })).toThrow();
  });
  it('toFinishWithin tokens/turns', () => {
    v(() => expect(r).toFinishWithin({ tokens: 200, turns: 5 })).not.toThrow();
    v(() => expect(r).toFinishWithin({ tokens: 100 })).toThrow(); // used 150
  });
});

describe('side-effect matcher', () => {
  let boxes: Sandbox[] = [];
  afterEach(async () => {
    await Promise.all(boxes.map((b) => b.cleanup()));
    boxes = [];
  });

  it('toHaveFile (async) with containing', async () => {
    const b = await Sandbox.create({ prefix: 'agentry-assert-' });
    boxes.push(b);
    await b.write('out/report.md', 'a refund was issued');
    await expect(b).toHaveFile('out/report.md');
    await expect(b).toHaveFile('out/report.md', { containing: 'refund' });
    await v(expect(b).toHaveFile('out/report.md', { containing: 'nope' })).rejects.toThrow();
    await v(expect(b).toHaveFile('missing.md')).rejects.toThrow();
  });
});

describe('skill/plugin matchers', () => {
  const f = new EventFactory('r', () => 0);
  const r = new RunRecord([
    f.make({ type: 'plugin', name: 'oh-my-claudecode', event: 'loaded', confidence: 'observed' }, { turnId: 'init', source: 'agent', capability: 'plugin' }),
    f.make(
      {
        type: 'plugin',
        name: 'SessionStart:startup',
        event: 'hook-fired',
        confidence: 'observed',
        detail: { hookEvent: 'SessionStart', output: '<system-reminder>hi</system-reminder>' },
      },
      { turnId: 'hooks', source: 'agent', capability: 'plugin' },
    ),
  ]);

  it('toHaveLoadedPlugin (+ negation)', () => {
    v(() => expect(r).toHaveLoadedPlugin('oh-my-claudecode')).not.toThrow();
    v(() => expect(r).toHaveLoadedPlugin('missing')).toThrow();
    v(() => expect(r).not.toHaveLoadedPlugin('missing')).not.toThrow();
  });

  it('toFireHook by name/event and injected content', () => {
    v(() => expect(r).toFireHook('SessionStart:startup')).not.toThrow(); // by name
    v(() => expect(r).toFireHook('SessionStart')).not.toThrow(); // by hookEvent
    v(() => expect(r).toFireHook('SessionStart', { injects: /system-reminder/ })).not.toThrow();
    v(() => expect(r).toFireHook('Nope')).toThrow();
    v(() => expect(r).toFireHook('SessionStart', { injects: 'absent-text' })).toThrow();
  });
});
