import { describe, it, expect } from 'vitest';
import { parseAnthropicRequest, systemText, collectRequestText, toolNames } from '@agentry/core';

const BODY = {
  model: 'claude-haiku-4-5',
  max_tokens: 1024,
  temperature: 0,
  stream: true,
  system: [{ type: 'text', text: 'You are a helpful assistant. SKILL: seo-audit loaded.' }],
  tools: [
    { name: 'Read', description: 'read a file', input_schema: { type: 'object' } },
    { name: 'mcp__fs__search', input_schema: {} },
  ],
  messages: [
    { role: 'user', content: 'find the invoice' },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'searching' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'invoice #42' }] },
  ],
};

describe('llm wire helpers', () => {
  it('parseAnthropicRequest extracts model, tools, sampling params, system, messages', () => {
    const r = parseAnthropicRequest(BODY);
    expect(r.model).toBe('claude-haiku-4-5');
    expect(toolNames(r)).toEqual(['Read', 'mcp__fs__search']);
    expect(r.tools?.[0]).toMatchObject({ name: 'Read', description: 'read a file' });
    expect(r.params).toMatchObject({ max_tokens: 1024, temperature: 0, stream: true });
    expect(r.messages).toHaveLength(3);
  });

  it('parseAnthropicRequest tolerates junk/empty bodies', () => {
    expect(parseAnthropicRequest(undefined)).toMatchObject({ model: '', messages: [], tools: [] });
    expect(parseAnthropicRequest('nope').messages).toEqual([]);
  });

  it('systemText flattens string and block forms', () => {
    expect(systemText('hi')).toBe('hi');
    expect(systemText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(systemText(undefined)).toBe('');
  });

  it('collectRequestText gathers system + message text + tool-result content (CH1 surface)', () => {
    const r = parseAnthropicRequest(BODY);
    const text = collectRequestText(r);
    expect(text).toContain('SKILL: seo-audit loaded'); // injected context (system)
    expect(text).toContain('find the invoice'); // user string content
    expect(text).toContain('searching'); // assistant text block
    expect(text).toContain('invoice #42'); // tool_result content
  });
});
