/**
 * Configuration system (SPEC §11).
 *
 * Provides `defineConfig` (identity helper for TypeScript inference),
 * `resolveConfig` (applies defaults and validates), `ConfigError` for schema
 * violations, and `isPinnedModel` for model-pinning enforcement.
 *
 * Model pinning rule: a model is pinned iff it does NOT match `/latest/i`
 * AND contains at least one digit. `resolveConfig` throws `ConfigError` at
 * config-load if `use.model` or any project's `use.model` is not pinned.
 */
import { z } from 'zod';

// ── Run modes (SPEC §5) ──────────────────────────────────────────────────────

export type RunMode = 'replay' | 'mcp-live' | 'live' | 'record' | 'dry';

// ── Sub-config interfaces ────────────────────────────────────────────────────

/** LLM-as-judge settings (SPEC §8.5). */
export interface JudgeConfig {
  /** Pinned model snapshot id for the judge call. */
  model?: string;
  /** Number of independent judge samples; assertion passes if mean ≥ threshold. */
  votes?: number;
  /** Score threshold in [0, 1]. */
  threshold?: number;
}

/** Matcher settings including auto-retry timeout and judge config. */
export interface ExpectConfig {
  /** Matcher auto-retry timeout in ms. */
  timeout?: number;
  judge?: JudgeConfig;
}

/** Per-test and per-run spend caps (SPEC §13). */
export interface BudgetConfig {
  perTest?: { usd?: number; tokens?: number };
  perRun?: { usd?: number };
}

/** Sandbox isolation policy (SPEC §13). */
export interface SandboxConfig {
  isolation?: 'directory' | 'container' | 'vm';
  /** Network policy; advisory in directory mode, enforced in container/vm. */
  network?: string;
  homeRemap?: boolean;
}

/** Secret redaction config applied before any persistence (SPEC §13). */
export interface RedactConfig {
  /** RegExp patterns matched against payload strings. */
  patterns?: RegExp[];
  /** Env var names whose runtime values are redacted; unset vars are skipped. */
  env?: string[];
}

/** Agent/model/trace defaults inherited by all scenarios (or a project). */
export interface UseOptions {
  /** Agent CLI identifier (e.g. `'claude'`). */
  agent?: string;
  /** Pinned model snapshot id. Must satisfy `isPinnedModel`. */
  model?: string;
  /** Trace retention mode (e.g. `'retain-on-failure'`). */
  trace?: string;
}

/** Per-project overrides (the agent × model matrix analog of Playwright projects). */
export interface ProjectConfig {
  name: string;
  testMatch?: string | RegExp;
  use?: UseOptions;
  dependencies?: string[];
}

/** Top-level input config accepted by `defineConfig` / `resolveConfig`. */
export interface AgentryConfig {
  testDir?: string;
  mode?: RunMode;
  fullyParallel?: boolean;
  /** Worker count or percentage string (e.g. `'50%'`). */
  workers?: number | string;
  retries?: number;
  /** Per-scenario run timeout in ms. */
  timeout?: number;
  expect?: ExpectConfig;
  budget?: BudgetConfig;
  sandbox?: SandboxConfig;
  redact?: RedactConfig;
  use?: UseOptions;
  projects?: ProjectConfig[];
  reporter?: unknown;
}

// ── Resolved config — all defaults populated ─────────────────────────────────

/** Fully resolved configuration; every structural field has a concrete value. */
export interface ResolvedConfig {
  testDir: string;
  mode: RunMode;
  fullyParallel: boolean;
  workers: number | string | undefined;
  retries: number;
  timeout: number;
  expect: {
    timeout: number;
    judge: { model: string; votes: number; threshold: number };
  };
  budget: {
    perTest: { usd: number; tokens: number };
    perRun: { usd: number };
  };
  sandbox: {
    isolation: 'directory' | 'container' | 'vm';
    network: string;
    homeRemap: boolean;
  };
  redact: {
    patterns: RegExp[];
    env: string[];
  };
  use: UseOptions;
  projects: ProjectConfig[];
  reporter: unknown;
}

// ── ConfigError ──────────────────────────────────────────────────────────────

/** Thrown by `resolveConfig` when the config fails schema validation or model-pinning. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// ── Model pinning ─────────────────────────────────────────────────────────────

/**
 * Returns true iff `model` is a pinned snapshot id:
 * - does NOT match `/latest/i`, AND
 * - contains at least one ASCII digit.
 *
 * @example
 * isPinnedModel('claude-opus-4-8')           // true
 * isPinnedModel('claude-haiku-4-5-20251001') // true
 * isPinnedModel('claude-latest')             // false
 * isPinnedModel('sonnet')                    // false
 */
export function isPinnedModel(model: string): boolean {
  return !/latest/i.test(model) && /\d/.test(model);
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const RunModeSchema = z.enum(['replay', 'mcp-live', 'live', 'record', 'dry']);

const JudgeConfigSchema = z.object({
  model: z.string().optional(),
  votes: z.number().int().positive().optional(),
  threshold: z.number().min(0).max(1).optional(),
});

const ExpectConfigSchema = z.object({
  timeout: z.number().positive().optional(),
  judge: JudgeConfigSchema.optional(),
});

const BudgetConfigSchema = z.object({
  perTest: z
    .object({
      usd: z.number().positive().optional(),
      tokens: z.number().int().positive().optional(),
    })
    .optional(),
  perRun: z
    .object({
      usd: z.number().positive().optional(),
    })
    .optional(),
});

const SandboxConfigSchema = z.object({
  isolation: z.enum(['directory', 'container', 'vm']).optional(),
  network: z.string().optional(),
  homeRemap: z.boolean().optional(),
});

const RedactConfigSchema = z.object({
  patterns: z.array(z.instanceof(RegExp)).optional(),
  env: z.array(z.string()).optional(),
});

const UseOptionsSchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  trace: z.string().optional(),
});

const ProjectConfigSchema = z.object({
  name: z.string(),
  testMatch: z.union([z.string(), z.instanceof(RegExp)]).optional(),
  use: UseOptionsSchema.optional(),
  dependencies: z.array(z.string()).optional(),
});

const AgentryConfigSchema = z.object({
  testDir: z.string().optional(),
  mode: RunModeSchema.optional(),
  fullyParallel: z.boolean().optional(),
  workers: z.union([z.number().int().positive(), z.string()]).optional(),
  retries: z.number().int().min(0).optional(),
  timeout: z.number().positive().optional(),
  expect: ExpectConfigSchema.optional(),
  budget: BudgetConfigSchema.optional(),
  sandbox: SandboxConfigSchema.optional(),
  redact: RedactConfigSchema.optional(),
  use: UseOptionsSchema.optional(),
  projects: z.array(ProjectConfigSchema).optional(),
  reporter: z.unknown().optional(),
});

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  testDir: './tests',
  mode: 'replay' as RunMode,
  fullyParallel: true,
  retries: 0,
  timeout: 120_000,
  expect: {
    timeout: 10_000,
    judge: { model: 'claude-haiku-4-5', votes: 3, threshold: 0.66 },
  },
  budget: {
    perTest: { usd: 0.25, tokens: 100_000 },
    perRun: { usd: 5 },
  },
  sandbox: {
    isolation: 'directory' as const,
    network: 'allowlist',
    homeRemap: true,
  },
} as const;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Identity helper — returns the config unchanged. Its only purpose is to give
 * TypeScript the `AgentryConfig` type for intellisense and import completions.
 */
export function defineConfig(config: AgentryConfig): AgentryConfig {
  return config;
}

/**
 * Validate `input` and return a `ResolvedConfig` with all defaults applied.
 *
 * Throws `ConfigError` if:
 * - the input fails schema validation, or
 * - `use.model` or any project's `use.model` is not a pinned snapshot id.
 */
export function resolveConfig(input: AgentryConfig): ResolvedConfig {
  const result = AgentryConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : 'root';
      return `${path}: ${i.message}`;
    });
    throw new ConfigError(`Invalid Agentry config: ${issues.join('; ')}`);
  }

  const c = result.data;

  // Model-pinning enforcement
  const topModel = c.use?.model;
  if (topModel !== undefined && !isPinnedModel(topModel)) {
    throw new ConfigError(
      `use.model '${topModel}' is not a pinned model snapshot. ` +
        `Remove '-latest' aliases and include a version digit (e.g. 'claude-opus-4-8').`,
    );
  }

  const projects = c.projects ?? [];
  for (const p of projects) {
    const pModel = p.use?.model;
    if (pModel !== undefined && !isPinnedModel(pModel)) {
      throw new ConfigError(
        `projects['${p.name}'].use.model '${pModel}' is not a pinned model snapshot. ` +
          `Remove '-latest' aliases and include a version digit (e.g. 'claude-opus-4-8').`,
      );
    }
  }

  return {
    testDir: c.testDir ?? DEFAULTS.testDir,
    mode: c.mode ?? DEFAULTS.mode,
    fullyParallel: c.fullyParallel ?? DEFAULTS.fullyParallel,
    workers: c.workers,
    retries: c.retries ?? DEFAULTS.retries,
    timeout: c.timeout ?? DEFAULTS.timeout,
    expect: {
      timeout: c.expect?.timeout ?? DEFAULTS.expect.timeout,
      judge: {
        model: c.expect?.judge?.model ?? DEFAULTS.expect.judge.model,
        votes: c.expect?.judge?.votes ?? DEFAULTS.expect.judge.votes,
        threshold: c.expect?.judge?.threshold ?? DEFAULTS.expect.judge.threshold,
      },
    },
    budget: {
      perTest: {
        usd: c.budget?.perTest?.usd ?? DEFAULTS.budget.perTest.usd,
        tokens: c.budget?.perTest?.tokens ?? DEFAULTS.budget.perTest.tokens,
      },
      perRun: {
        usd: c.budget?.perRun?.usd ?? DEFAULTS.budget.perRun.usd,
      },
    },
    sandbox: {
      isolation: c.sandbox?.isolation ?? DEFAULTS.sandbox.isolation,
      network: c.sandbox?.network ?? DEFAULTS.sandbox.network,
      homeRemap: c.sandbox?.homeRemap ?? DEFAULTS.sandbox.homeRemap,
    },
    redact: {
      patterns: c.redact?.patterns ?? [],
      env: c.redact?.env ?? [],
    },
    use: c.use ?? {},
    projects,
    reporter: c.reporter,
  };
}
