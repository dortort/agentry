import { describe, it, expect } from 'vitest';
import { McpServerCore, type MockTool, type JsonRpcRequest } from '../src/mock-server';

const ECHO: MockTool = {
  name: 'echo',
  description: 'echoes back text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  result: { ok: true },
};

const ADD: MockTool = {
  name: 'add',
  handler: (args) => {
    const a = (args as { a: number; b: number }).a;
    const b = (args as { a: number; b: number }).b;
    return `sum=${a + b}`;
  },
};

function core(serverName?: string): McpServerCore {
  return new McpServerCore({ tools: [ECHO, ADD], serverName });
}

describe('McpServerCore', () => {
  it('initialize returns protocolVersion + serverInfo', () => {
    const res = core('my-mock').handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'my-mock', version: '0.0.0' },
      },
    });
  });

  it('uses the default serverName when none is given', () => {
    const res = core().handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }) as {
      result: { serverInfo: { name: string } };
    };
    expect(res.result.serverInfo.name).toBe('agentry-mock');
  });

  it('ping returns an empty result', () => {
    const res = core().handle({ jsonrpc: '2.0', id: 'p', method: 'ping' });
    expect(res).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
  });

  it('tools/list returns the configured tools', () => {
    const res = core().handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: [
          { name: 'echo', description: 'echoes back text', inputSchema: ECHO.inputSchema },
          { name: 'add', description: undefined, inputSchema: undefined },
        ],
      },
    });
  });

  it('tools/call returns the configured result text and records the call', () => {
    const c = core();
    const res = c.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] },
    });
    expect(c.received).toContainEqual({
      method: 'tools/call',
      params: { name: 'echo', arguments: { text: 'hi' } },
    });
  });

  it('a handler-based tool returns the handler output (as text)', () => {
    const res = core().handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 2, b: 3 } },
    });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: { content: [{ type: 'text', text: 'sum=5' }] },
    });
  });

  it('unknown method → -32601', () => {
    const res = core().handle({ jsonrpc: '2.0', id: 5, method: 'does/not/exist' });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 5,
      error: { code: -32601, message: 'method not found: does/not/exist' },
    });
  });

  it('unknown tool → -32602', () => {
    const res = core().handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 6,
      error: { code: -32602, message: 'unknown tool: nope' },
    });
  });

  it('notifications/initialized returns null but is still recorded', () => {
    const c = core();
    const res = c.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res).toBeNull();
    expect(c.received).toEqual([{ method: 'notifications/initialized' }]);
  });

  it('received captures method + params in arrival order', () => {
    const c = core();
    const sequence: JsonRpcRequest[] = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } },
    ];
    for (const msg of sequence) c.handle(msg);
    expect(c.received).toEqual([
      { method: 'initialize' },
      { method: 'notifications/initialized' },
      { method: 'tools/list' },
      { method: 'tools/call', params: { name: 'echo', arguments: { text: 'x' } } },
    ]);
  });
});
