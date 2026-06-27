import { describe, it, expect } from 'vitest';
import { EventFactory, isEvent } from '@agentry/core';

describe('EventFactory', () => {
  it('assigns sequential, deterministic event ids and injects the clock', () => {
    let t = 1000;
    const f = new EventFactory('run1', () => t++);
    const a = f.make(
      { type: 'run.start', runId: 'run1', agent: 'claude', model: 'm' },
      { turnId: 't0', source: 'runner' },
    );
    const b = f.make(
      { type: 'message', role: 'assistant', text: 'hi' },
      { turnId: 't0', source: 'agent' },
    );
    expect(a.eventId).toBe('run1:0');
    expect(b.eventId).toBe('run1:1');
    expect(a.ts).toBe(1000);
    expect(b.ts).toBe(1001);
    expect(a.redactionStatus).toBe('none');
  });

  it('isEvent narrows by payload type', () => {
    const f = new EventFactory('r', () => 0);
    const e = f.make(
      { type: 'tool_use', id: '1', name: 'read_file', args: { path: 'a.ts' } },
      { turnId: 't', source: 'agent' },
    );
    expect(isEvent(e, 'tool_use')).toBe(true);
    expect(isEvent(e, 'message')).toBe(false);
    if (isEvent(e, 'tool_use')) {
      // type narrowed: payload.name is available
      expect(e.payload.name).toBe('read_file');
    }
  });
});
