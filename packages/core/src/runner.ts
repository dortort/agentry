/**
 * Test runner (SPEC §10, §5). Owns the test registry, fixtures, and per-scenario
 * execution across run modes. Stays decoupled from any agent driver: the live
 * driver (e.g. ClaudeDriver) is INJECTED by the CLI; the runner itself handles
 * replay via the in-core {@link ReplayDriver}.
 */
import { join, dirname, basename } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { RunRecord, type RunView, type RunViewProvider } from './run';
import { Sandbox } from './sandbox';
import { EventFactory, type AgentEvent } from './events';
import type { AgentDriver, RunOptions } from './driver';
import {
  ReplayDriver,
  recordTranscript,
  serializeTranscript,
  parseTranscript,
} from './transcript';
import { startLlmProxy, SingleUpstream, type StartedProxy } from './proxy';
import { serializeCassette, parseCassette } from './cassette';
import { expect as agentryExpect } from './assert';
import type { ResolvedConfig, RunMode } from './config';

// ── Registry ──────────────────────────────────────────────────────────────────

export type TestFn = (fixtures: TestFixtures) => void | Promise<void>;
export interface RegisteredTest {
  name: string;
  suite: string[];
  fn: TestFn;
  file?: string;
}

let registry: RegisteredTest[] = [];
let suiteStack: string[] = [];
let currentFile: string | undefined;

/** Tag subsequently-registered tests with their source file (set by the CLI before import). */
export function setCurrentFile(file: string | undefined): void {
  currentFile = file;
}
export function getRegistry(): RegisteredTest[] {
  return registry;
}
export function clearRegistry(): void {
  registry = [];
  suiteStack = [];
  currentFile = undefined;
}

export interface TestApi {
  (name: string, fn: TestFn): void;
  describe(name: string, fn: () => void): void;
}

const testImpl = (name: string, fn: TestFn): void => {
  registry.push({ name, suite: [...suiteStack], fn, file: currentFile });
};
const describe = (name: string, fn: () => void): void => {
  suiteStack.push(name);
  try {
    fn();
  } finally {
    suiteStack.pop();
  }
};
export const test: TestApi = Object.assign(testImpl, { describe });

// ── Fixtures + AgentHandle ──────────────────────────────────────────────────────

export interface AgentRunExtra {
  mcpConfig?: unknown;
  allowedTools?: string[];
  disallowedTools?: string[];
  permissionMode?: string;
  appendSystemPrompt?: string;
  pluginDir?: string;
  extraArgs?: string[];
  /** Extra environment for this run; merged over (not replacing) the base env. */
  env?: Record<string, string>;
}

export interface TestFixtures {
  agent: AgentHandle;
  workspace: Sandbox;
  /** MVP: a RunView over the same run (so expect(mcp).toHaveMcpRequest works). */
  mcp: RunViewProvider;
  expect: typeof agentryExpect;
}

const EMPTY_VIEW: RunView = new RunRecord([]);

/**
 * The `agent` fixture. Drives the (injected) driver inside the sandbox,
 * captures fs side-effects, and exposes the last run as a RunView for assertions
 * via {@link RunViewProvider.toRunView}.
 */
export class AgentHandle implements RunViewProvider {
  record?: RunRecord;
  lastPrompt?: string;
  lastFiles: Record<string, string> = {};
  private readonly fsFactory = new EventFactory('fs');

  constructor(
    private readonly driver: AgentDriver,
    private readonly base: { model: string; env?: Record<string, string>; maxBudgetUSD?: number },
    private readonly sandbox: Sandbox,
    private readonly proxy?: StartedProxy,
  ) {}

  toRunView(): RunView {
    return this.record ?? EMPTY_VIEW;
  }

  async run(prompt: string, extra: AgentRunExtra = {}): Promise<RunRecord> {
    this.lastPrompt = prompt;
    const before = await this.sandbox.snapshot();
    const { env: extraEnv, ...restExtra } = extra;
    const opts: RunOptions = {
      prompt,
      model: this.base.model,
      cwd: this.sandbox.dir,
      maxBudgetUSD: this.base.maxBudgetUSD,
      ...restExtra,
      env: { ...this.base.env, ...extraEnv },
    };
    const rec = await this.driver.run(opts);
    const after = await this.sandbox.snapshot();
    const changes = this.sandbox.diff(before, after);

    this.lastFiles = {};
    for (const ch of changes) {
      if (ch.op !== 'delete') {
        try {
          this.lastFiles[ch.path] = await this.sandbox.read(ch.path);
        } catch {
          /* unreadable (e.g. binary/locked) — skip */
        }
      }
    }
    const fsEvents: AgentEvent[] = changes.map((c) =>
      this.fsFactory.make({ type: 'fs', op: c.op, path: c.path }, { turnId: 'fs', source: 'sandbox' }),
    );
    // Merge CH1 events captured by the LLM proxy during this run (if proxy-enabled).
    const proxyEvents = this.proxy ? [...this.proxy.events] : [];
    const merged = new RunRecord([...rec.events, ...proxyEvents, ...fsEvents], rec.result);
    this.record = merged;
    return merged;
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  name: string;
  suite: string[];
  file?: string;
  status: TestStatus;
  durationMs: number;
  mode: RunMode;
  error?: string;
  costUSD?: number;
}

export interface RunnerDeps {
  mode: RunMode;
  config: ResolvedConfig;
  /** Live driver for live/record/mcp-live modes (injected; e.g. ClaudeDriver). */
  liveDriver?: AgentDriver;
  /** Injectable clock for deterministic durations in tests. */
  now?: () => number;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'scenario';
}

/** Where a scenario's transcript lives, next to its test file. */
export function transcriptPathFor(t: RegisteredTest, rootDir: string): string {
  const file = t.file ?? join(rootDir, 'inline.agentry.ts');
  const dir = join(dirname(file), '__agentry__', basename(file).replace(/\.[tj]s$/, ''));
  return join(dir, `${sanitize([...t.suite, t.name].join('--'))}.json`);
}

/** Wire cassette path — a sibling of the transcript (`*.wire.json`). */
export function wireCassettePathFor(t: RegisteredTest, rootDir: string): string {
  return transcriptPathFor(t, rootDir).replace(/\.json$/, '.wire.json');
}

/** Build a redactor that replaces configured patterns + env-var values with a placeholder. */
function makeRedactor(redact: ResolvedConfig['redact']): (text: string) => string {
  const envValues = redact.env.map((n) => process.env[n]).filter((v): v is string => !!v);
  return (text: string) => {
    let out = text;
    for (const re of redact.patterns) out = out.replace(re, '<redacted>');
    for (const v of envValues) out = out.split(v).join('<redacted>');
    return out;
  };
}

export async function runTests(tests: RegisteredTest[], deps: RunnerDeps): Promise<TestResult[]> {
  const results: TestResult[] = [];
  for (const t of tests) results.push(await runOne(t, deps));
  return results;
}

async function runOne(t: RegisteredTest, deps: RunnerDeps): Promise<TestResult> {
  const now = deps.now ?? (() => Date.now());
  const start = now();
  const base = { name: t.name, suite: t.suite, file: t.file, mode: deps.mode };

  if (deps.mode === 'dry') {
    return { ...base, status: 'skipped', durationMs: 0 };
  }

  const model = deps.config.use.model;
  if (!model) {
    return { ...base, status: 'failed', durationMs: now() - start, error: 'config.use.model is required' };
  }

  const sandbox = await Sandbox.create({ prefix: 'agentry-run-' });
  let proxy: StartedProxy | undefined;
  try {
    let driver: AgentDriver;
    const transcriptPath = transcriptPathFor(t, deps.config.testDir);
    const wirePath = wireCassettePathFor(t, deps.config.testDir);

    if (deps.mode === 'replay') {
      if (!existsSync(transcriptPath)) {
        return {
          ...base,
          status: 'failed',
          durationMs: now() - start,
          error: `no recording for this scenario (expected ${transcriptPath}). Run \`agentry record\` first.`,
        };
      }
      const transcript = parseTranscript(await readFile(transcriptPath, 'utf8'));
      for (const [p, c] of Object.entries(transcript.files ?? {})) await sandbox.write(p, c);
      driver = new ReplayDriver(transcript);
    } else {
      if (!deps.liveDriver) {
        return {
          ...base,
          status: 'failed',
          durationMs: now() - start,
          error: `mode '${deps.mode}' requires a live driver, but none was provided`,
        };
      }
      driver = deps.liveDriver;

      // Start the LLM proxy for spawn modes (record / live / mcp-live / wire-replay).
      const proxyMode = deps.mode === 'wire-replay' ? 'wire-replay' : deps.mode === 'record' ? 'record' : 'live';
      let wireCassette;
      if (deps.mode === 'wire-replay') {
        if (!existsSync(wirePath)) {
          return {
            ...base,
            status: 'failed',
            durationMs: now() - start,
            error: `no wire cassette (expected ${wirePath}). Run \`agentry record\` first.`,
          };
        }
        wireCassette = parseCassette(await readFile(wirePath, 'utf8'));
      }
      proxy = await startLlmProxy({
        mode: proxyMode,
        sessionId: sanitize([...t.suite, t.name].join('--')),
        factory: new EventFactory('llm'),
        upstream: new SingleUpstream(deps.config.upstreamBaseUrl),
        cassette: wireCassette,
        redact: makeRedactor(deps.config.redact),
      });
    }

    const handle = new AgentHandle(
      driver,
      {
        model,
        env: proxy ? { ANTHROPIC_BASE_URL: proxy.url } : undefined,
        maxBudgetUSD: deps.config.budget.perTest.usd,
      },
      sandbox,
      proxy,
    );
    const fixtures: TestFixtures = { agent: handle, workspace: sandbox, mcp: handle, expect: agentryExpect };

    await t.fn(fixtures);

    // Persist a transcript in record mode.
    if (deps.mode === 'record' && handle.record) {
      const transcript = recordTranscript(handle.record, {
        prompt: handle.lastPrompt,
        model,
        files: handle.lastFiles,
      });
      await mkdir(dirname(transcriptPath), { recursive: true });
      await writeFile(transcriptPath, serializeTranscript(transcript), 'utf8');

      // Persist the wire cassette for future hermetic wire-replay.
      const cass = proxy?.cassette();
      if (cass && cass.entries.length > 0) {
        await mkdir(dirname(wirePath), { recursive: true });
        await writeFile(wirePath, serializeCassette(cass), 'utf8');
      }
    }

    // Post-hoc budget check (MVP; preflight + proxy-gate are later — SPEC §13).
    const costUSD = handle.record?.usage.costUSD ?? 0;
    const cap = deps.config.budget.perTest.usd;
    if (cap && costUSD > cap) {
      return {
        ...base,
        status: 'failed',
        durationMs: now() - start,
        error: `budget exceeded: $${costUSD.toFixed(4)} > $${cap.toFixed(4)} per test`,
        costUSD,
      };
    }

    return { ...base, status: 'passed', durationMs: now() - start, costUSD };
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      durationMs: now() - start,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    };
  } finally {
    await proxy?.stop();
    await sandbox.cleanup();
  }
}
