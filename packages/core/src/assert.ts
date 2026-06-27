/**
 * Assertion engine (SPEC §8). Tier 1 (tool-call) + Tier 2 (side-effect) +
 * budget matchers, implemented as `expect.extend` custom matchers over a
 * {@link RunView}. Structure is asserted exactly; semantic (Tier 4 LLM-judge)
 * matchers are added in a later commit.
 *
 * All matchers support `.not` automatically via the `expect` engine.
 */
import { expect as baseExpect } from 'expect';
import { asRunView } from './run';
import type { Sandbox } from './sandbox';

/** Deep "expected is a subset of actual" match, with RegExp leaves supported. */
export function subsetMatch(actual: unknown, expected: unknown): boolean {
  if (expected instanceof RegExp) return typeof actual === 'string' && expected.test(actual);
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.every((ev, i) => subsetMatch((actual as unknown[])[i], ev))
    );
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return false;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) =>
      subsetMatch((actual as Record<string, unknown>)[k], v),
    );
  }
  return actual === expected;
}

const toolNames = (received: unknown) =>
  asRunView(received).toolCalls.map((c) => c.payload.name);

export const matchers = {
  toHaveToolCall(received: unknown, name: string | RegExp, args?: Record<string, unknown>) {
    const view = asRunView(received);
    const calls = view.findToolCalls(name);
    const pass = args ? calls.some((c) => subsetMatch(c.payload.args, args)) : calls.length > 0;
    return {
      pass,
      message: () =>
        pass
          ? `expected agent NOT to call tool ${name}${args ? ` with args ${JSON.stringify(args)}` : ''}`
          : `expected agent to call tool ${name}${args ? ` with args ${JSON.stringify(args)}` : ''}\n` +
            `tools called: [${toolNames(received).join(', ')}]`,
    };
  },

  toHaveCalledToolTimes(received: unknown, name: string | RegExp, n: number) {
    const actual = asRunView(received).findToolCalls(name).length;
    const pass = actual === n;
    return {
      pass,
      message: () => `expected tool ${name} to be called ${n} time(s), but it was called ${actual}`,
    };
  },

  /** Allow-list: every tool the agent called must be in `allowed`. */
  toUseToolsFrom(received: unknown, allowed: string[]) {
    const set = new Set(allowed);
    const offenders = [...new Set(toolNames(received))].filter((n) => !set.has(n));
    const pass = offenders.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? `expected agent to call a tool outside [${allowed.join(', ')}]`
          : `expected only tools from [${allowed.join(', ')}], but it also called [${offenders.join(', ')}]`,
    };
  },

  /** Required-list (order-insensitive): each name must have been called. */
  toHaveCalledAll(received: unknown, required: string[]) {
    const view = asRunView(received);
    const missing = required.filter((n) => view.findToolCalls(n).length === 0);
    const pass = missing.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? `expected agent NOT to call all of [${required.join(', ')}]`
          : `expected all of [${required.join(', ')}] to be called; missing [${missing.join(', ')}]`,
    };
  },

  toHaveMcpRequest(received: unknown, matcher: { method?: string; server?: string; name?: string }) {
    const reqs = asRunView(received).mcpRequests;
    const pass = reqs.some((r) => {
      if (matcher.method && r.payload.method !== matcher.method) return false;
      if (matcher.server && r.payload.server !== matcher.server) return false;
      if (matcher.name && !subsetMatch(r.payload.params, { name: matcher.name })) return false;
      return true;
    });
    return {
      pass,
      message: () =>
        `expected an MCP request matching ${JSON.stringify(matcher)}\n` +
        `saw: ${JSON.stringify(reqs.map((r) => ({ server: r.payload.server, method: r.payload.method })))}`,
    };
  },

  /** Budget assertion: token and/or turn ceilings (SPEC §8.1). */
  toFinishWithin(received: unknown, limits: { tokens?: number; turns?: number }) {
    const view = asRunView(received);
    const used = view.usage.inputTokens + view.usage.outputTokens;
    const overTokens = limits.tokens != null && used > limits.tokens;
    const overTurns = limits.turns != null && view.turns > limits.turns;
    const pass = !overTokens && !overTurns;
    return {
      pass,
      message: () =>
        `expected run within ${JSON.stringify(limits)}; used ${used} tokens, ${view.turns} turns`,
    };
  },

  /** Tier 2 side-effect: assert a file exists in the sandbox (optionally containing text). */
  async toHaveFile(received: Sandbox, rel: string, opts?: { containing?: string | RegExp }) {
    const exists = await received.exists(rel);
    if (!exists) {
      return { pass: false, message: () => `expected sandbox to have file "${rel}", but it does not exist` };
    }
    if (opts?.containing == null) {
      return { pass: true, message: () => `expected sandbox NOT to have file "${rel}"` };
    }
    const content = await received.read(rel);
    const pass =
      opts.containing instanceof RegExp ? opts.containing.test(content) : content.includes(opts.containing);
    return {
      pass,
      message: () =>
        pass
          ? `expected "${rel}" NOT to contain ${opts.containing}`
          : `expected "${rel}" to contain ${opts.containing}`,
    };
  },
};

baseExpect.extend(matchers);

export const expect = baseExpect;

declare module 'expect' {
  interface Matchers<R> {
    toHaveToolCall(name: string | RegExp, args?: Record<string, unknown>): R;
    toHaveCalledToolTimes(name: string | RegExp, n: number): R;
    toUseToolsFrom(allowed: string[]): R;
    toHaveCalledAll(required: string[]): R;
    toHaveMcpRequest(matcher: { method?: string; server?: string; name?: string }): R;
    toFinishWithin(limits: { tokens?: number; turns?: number }): R;
    toHaveFile(rel: string, opts?: { containing?: string | RegExp }): Promise<R>;
  }
}
