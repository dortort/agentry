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
import { collectRequestText } from './llm';
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

  /** Tier 3 structured-output: validate a value (string → JSON.parse first) against a zod-like schema. */
  toMatchSchema(received: unknown, schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }) {
    let value = received;
    if (typeof received === 'string') {
      try {
        value = JSON.parse(received);
      } catch {
        /* not JSON — validate the raw string */
      }
    }
    const res = schema.safeParse(value);
    return {
      pass: res.success,
      message: () =>
        res.success
          ? `expected value NOT to match schema`
          : `expected value to match schema; validation error:\n${JSON.stringify(res.error, null, 2)}`,
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

  // ── Skills & plugins: observable-effect matchers (SPEC §9.2) ──
  // MVP keys off natively-observed signals (init plugin-load, hook-fire events).
  // CH1 context-injection / CH6 differential matchers arrive with the LLM proxy.

  toHaveLoadedPlugin(received: unknown, name: string | RegExp) {
    const match = (n: string) => (typeof name === 'string' ? n === name : name.test(n));
    const loaded = asRunView(received).plugins.filter((p) => p.payload.event === 'loaded');
    const pass = loaded.some((p) => match(p.payload.name));
    return {
      pass,
      message: () =>
        `expected plugin ${name} to be loaded\nloaded: [${loaded.map((p) => p.payload.name).join(', ')}]`,
    };
  },

  toFireHook(received: unknown, hook: string | RegExp, opts?: { injects?: string | RegExp }) {
    const match = (n: string) => (typeof hook === 'string' ? n === hook : hook.test(n));
    const fired = asRunView(received).plugins.filter((p) => p.payload.event === 'hook-fired');
    const candidates = fired.filter((p) => {
      const detail = p.payload.detail as { hookEvent?: string } | undefined;
      return match(p.payload.name) || match(String(detail?.hookEvent ?? ''));
    });
    let pass = candidates.length > 0;
    if (pass && opts?.injects != null) {
      const inj = opts.injects;
      pass = candidates.some((p) => {
        const s = JSON.stringify(p.payload.detail ?? '');
        return inj instanceof RegExp ? inj.test(s) : s.includes(inj);
      });
    }
    return {
      pass,
      message: () =>
        `expected hook ${hook}${opts?.injects ? ` injecting ${opts.injects}` : ''} to fire\n` +
        `fired: [${fired.map((p) => p.payload.name).join(', ')}]`,
    };
  },

  /** CH1: assert injected context (skill body / hook reminder) appears on the wire. */
  toInjectContext(received: unknown, pattern: string | RegExp) {
    const reqs = asRunView(received).llmRequests;
    const text = reqs.map((r) => collectRequestText(r.payload)).join('\n');
    const pass = pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern);
    return {
      pass,
      message: () =>
        reqs.length === 0
          ? `expected injected context ${pattern}, but no llm_request events were captured (is the LLM proxy enabled?)`
          : `expected the request context to ${pass ? 'NOT ' : ''}contain ${pattern}`,
    };
  },

  /** CH1: assert these tools were declared to the model (e.g. registered by a plugin). */
  toRegisterTools(received: unknown, names: string[]) {
    const declared = new Set(asRunView(received).llmRequests.flatMap((r) => (r.payload.tools ?? []).map((t) => t.name)));
    const missing = names.filter((n) => !declared.has(n));
    const pass = missing.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? `expected NOT to register all of [${names.join(', ')}]`
          : `expected tools [${names.join(', ')}] to be declared; missing [${missing.join(', ')}]`,
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
    toMatchSchema(schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }): R;
    toHaveFile(rel: string, opts?: { containing?: string | RegExp }): Promise<R>;
    toHaveLoadedPlugin(name: string | RegExp): R;
    toFireHook(hook: string | RegExp, opts?: { injects?: string | RegExp }): R;
    toInjectContext(pattern: string | RegExp): R;
    toRegisterTools(names: string[]): R;
    // MCP fixture matchers — implemented in @agentry/mcp (signatures declared here
    // so 'expect' resolves; runtime extend lives in that package).
    toExposeTools(names: string[]): R;
    toHaveReceived(matcher: { method?: string; name?: string }): R;
  }
}
