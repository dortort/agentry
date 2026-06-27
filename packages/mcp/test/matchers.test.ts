import { describe, it, expect as v } from 'vitest';
import { expect } from '@agentry/core';
import { McpServerCore } from '../src/index'; // importing the package registers the mcp matchers

function core(): McpServerCore {
  const c = new McpServerCore({ tools: [{ name: 'read_file', result: 'ok' }, { name: 'search' }] });
  c.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  c.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a' } } });
  return c;
}

describe('mcp matchers', () => {
  it('toExposeTools (+ negation)', () => {
    const c = core();
    v(() => expect(c).toExposeTools(['read_file', 'search'])).not.toThrow();
    v(() => expect(c).toExposeTools(['missing'])).toThrow();
    v(() => expect(c).not.toExposeTools(['missing'])).not.toThrow();
  });

  it('toHaveReceived by method and tool name', () => {
    const c = core();
    v(() => expect(c).toHaveReceived({ method: 'initialize' })).not.toThrow();
    v(() => expect(c).toHaveReceived({ method: 'tools/call', name: 'read_file' })).not.toThrow();
    v(() => expect(c).toHaveReceived({ method: 'tools/call', name: 'search' })).toThrow();
  });
});
