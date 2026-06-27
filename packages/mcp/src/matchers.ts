/**
 * MCP fixture matchers (SPEC §9.1). Registered on the shared @agentry/core
 * `expect`; assert against a {@link McpServerCore}'s configured tools and the
 * requests it recorded. The matcher type signatures live in @agentry/core's
 * `expect` augmentation (so 'expect' resolves there); this module supplies the
 * runtime implementations.
 */
import { expect as baseExpect } from '@agentry/core';
import { McpServerCore } from './mock-server';

function asCore(received: unknown): McpServerCore {
  if (received instanceof McpServerCore) return received;
  throw new TypeError('expected an Agentry McpServerCore (the mock MCP server)');
}

export const mcpMatchers = {
  /** The mock advertises (at least) these tools via tools/list. */
  toExposeTools(received: unknown, names: string[]) {
    const have = new Set(asCore(received).toolNames);
    const missing = names.filter((n) => !have.has(n));
    const pass = missing.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? `expected mock NOT to expose all of [${names.join(', ')}]`
          : `expected mock to expose [${names.join(', ')}]; missing [${missing.join(', ')}] (has [${[...have].join(', ')}])`,
    };
  },

  /** The mock received a request matching `{ method?, name? }` (name = tools/call tool name). */
  toHaveReceived(received: unknown, matcher: { method?: string; name?: string }) {
    const calls = asCore(received).received;
    const pass = calls.some((c) => {
      if (matcher.method && c.method !== matcher.method) return false;
      if (matcher.name) {
        const p = c.params as { name?: unknown } | undefined;
        if (!p || p.name !== matcher.name) return false;
      }
      return true;
    });
    return {
      pass,
      message: () =>
        `expected mock to have received ${JSON.stringify(matcher)}\n` +
        `received methods: ${JSON.stringify(calls.map((c) => c.method))}`,
    };
  },
};

baseExpect.extend(mcpMatchers);
