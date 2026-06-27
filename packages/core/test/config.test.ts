import { describe, it, expect } from 'vitest';
import {
  defineConfig,
  resolveConfig,
  isPinnedModel,
  ConfigError,
  type AgentryConfig,
} from '../src/config';

// ── isPinnedModel ─────────────────────────────────────────────────────────────

describe('isPinnedModel', () => {
  it('accepts model names with a version digit and no "latest"', () => {
    expect(isPinnedModel('claude-opus-4-8')).toBe(true);
    expect(isPinnedModel('claude-haiku-4-5-20251001')).toBe(true);
    expect(isPinnedModel('claude-sonnet-4-6')).toBe(true);
  });

  it('rejects models matching /latest/i', () => {
    expect(isPinnedModel('claude-latest')).toBe(false);
    expect(isPinnedModel('claude-opus-latest')).toBe(false);
    expect(isPinnedModel('CLAUDE-LATEST')).toBe(false);
    expect(isPinnedModel('claude-3-Latest')).toBe(false);
  });

  it('rejects bare aliases that contain no digit', () => {
    expect(isPinnedModel('sonnet')).toBe(false);
    expect(isPinnedModel('opus')).toBe(false);
    expect(isPinnedModel('haiku')).toBe(false);
    expect(isPinnedModel('claude-opus')).toBe(false);
  });
});

// ── resolveConfig — defaults ──────────────────────────────────────────────────

describe('resolveConfig — defaults', () => {
  it('applies all built-in defaults when given an empty config', () => {
    const r = resolveConfig({});
    expect(r.mode).toBe('replay');
    expect(r.fullyParallel).toBe(true);
    expect(r.retries).toBe(0);
    expect(r.timeout).toBe(120_000);
    expect(r.expect.timeout).toBe(10_000);
    expect(r.expect.judge.model).toBe('claude-haiku-4-5');
    expect(r.expect.judge.votes).toBe(3);
    expect(r.expect.judge.threshold).toBe(0.66);
    expect(r.budget.perTest.usd).toBe(0.25);
    expect(r.budget.perTest.tokens).toBe(100_000);
    expect(r.budget.perRun.usd).toBe(5);
    expect(r.sandbox.isolation).toBe('directory');
    expect(r.sandbox.network).toBe('allowlist');
    expect(r.sandbox.homeRemap).toBe(true);
    expect(r.redact.patterns).toEqual([]);
    expect(r.redact.env).toEqual([]);
    expect(r.projects).toEqual([]);
    expect(r.workers).toBeUndefined();
  });

  it('preserves caller-supplied values and fills the rest with defaults', () => {
    const r = resolveConfig({ mode: 'mcp-live', retries: 2, timeout: 60_000 });
    expect(r.mode).toBe('mcp-live');
    expect(r.retries).toBe(2);
    expect(r.timeout).toBe(60_000);
    // unfilled fields still get defaults
    expect(r.fullyParallel).toBe(true);
    expect(r.expect.judge.votes).toBe(3);
  });
});

// ── resolveConfig — valid pinned model ───────────────────────────────────────

describe('resolveConfig — valid pinned model', () => {
  it('resolves successfully with claude-opus-4-8', () => {
    const config: AgentryConfig = {
      use: { agent: 'claude', model: 'claude-opus-4-8', trace: 'retain-on-failure' },
    };
    const r = resolveConfig(config);
    expect(r.use.model).toBe('claude-opus-4-8');
    expect(r.use.agent).toBe('claude');
  });

  it('resolves successfully with a dated snapshot suffix', () => {
    const r = resolveConfig({ use: { model: 'claude-haiku-4-5-20251001' } });
    expect(r.use.model).toBe('claude-haiku-4-5-20251001');
  });

  it('resolves a full project matrix with pinned models', () => {
    const config: AgentryConfig = {
      use: { model: 'claude-opus-4-8' },
      projects: [
        { name: 'claude-opus', use: { model: 'claude-opus-4-8' } },
        { name: 'claude-sonnet', use: { model: 'claude-sonnet-4-6' } },
      ],
    };
    const r = resolveConfig(config);
    expect(r.projects).toHaveLength(2);
  });
});

// ── resolveConfig — model pinning rejections ──────────────────────────────────

describe('resolveConfig — model pinning rejections', () => {
  it('throws ConfigError for use.model = "claude-latest"', () => {
    expect(() => resolveConfig({ use: { model: 'claude-latest' } })).toThrow(ConfigError);
  });

  it('throws ConfigError for use.model = "sonnet" (no digit)', () => {
    expect(() => resolveConfig({ use: { model: 'sonnet' } })).toThrow(ConfigError);
  });

  it('throws ConfigError for use.model = "opus" (no digit)', () => {
    expect(() => resolveConfig({ use: { model: 'opus' } })).toThrow(ConfigError);
  });

  it('throws ConfigError when a project-level use.model is unpinned', () => {
    const config: AgentryConfig = {
      use: { model: 'claude-opus-4-8' }, // top-level is fine
      projects: [{ name: 'bad-project', use: { model: 'claude-latest' } }],
    };
    expect(() => resolveConfig(config)).toThrow(ConfigError);
  });

  it('error message names the offending model', () => {
    let msg = '';
    try {
      resolveConfig({ use: { model: 'claude-latest' } });
    } catch (e) {
      msg = e instanceof Error ? e.message : '';
    }
    expect(msg).toMatch('claude-latest');
    expect(msg).toMatch('pinned');
  });
});

// ── resolveConfig — schema validation ─────────────────────────────────────────

describe('resolveConfig — schema validation', () => {
  it('throws ConfigError for an invalid mode value', () => {
    // Cast to bypass TS so the runtime validator is exercised
    expect(() => resolveConfig({ mode: 'turbo' as AgentryConfig['mode'] })).toThrow(ConfigError);
  });

  it('throws ConfigError for a negative retries value', () => {
    expect(() => resolveConfig({ retries: -1 })).toThrow(ConfigError);
  });
});

// ── defineConfig ──────────────────────────────────────────────────────────────

describe('defineConfig', () => {
  it('is an identity function — returns the same object reference', () => {
    const config: AgentryConfig = { testDir: './tests', mode: 'replay' };
    expect(defineConfig(config)).toBe(config);
  });
});
