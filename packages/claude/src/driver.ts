/**
 * Claude Code driver (SPEC §4.2). Drives `claude -p --output-format stream-json`
 * headlessly (validated in Phase 0: no TTY, clean `result`+exit, structured
 * tool/usage events) and normalizes the native stream into AgentEvents.
 *
 * `parseClaudeEvent` is a pure mapping (one native event → zero+ AgentEvents)
 * so it can be unit-tested without spawning the CLI.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  EventFactory,
  RunRecord,
  type AgentDriver,
  type AgentEvent,
  type DriverCapabilities,
  type RunOptions,
  type RunResult,
  type RunEndReason,
  type Usage,
  isEvent,
} from '@agentry/core';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

/** Map a single Claude `stream-json` event into zero or more AgentEvents. */
export function parseClaudeEvent(raw: Raw, f: EventFactory, runId: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  const type = raw?.type;

  if (type === 'system' && raw.subtype === 'init') {
    out.push(
      f.make(
        { type: 'run.start', runId, agent: 'claude', model: raw.model },
        { turnId: 'init', source: 'agent', agentNativeType: 'system/init', raw },
      ),
    );
    for (const p of raw.plugins ?? []) {
      out.push(
        f.make(
          { type: 'plugin', name: p.name, event: 'loaded', confidence: 'observed', detail: { source: p.source } },
          { turnId: 'init', source: 'agent', capability: 'plugin', agentNativeType: 'system/init' },
        ),
      );
    }
    return out;
  }

  if (type === 'assistant') {
    const turn = raw.message?.id ?? 'assistant';
    for (const c of raw.message?.content ?? []) {
      if (c.type === 'text') {
        out.push(
          f.make(
            { type: 'message', role: 'assistant', text: c.text ?? '' },
            { turnId: turn, source: 'agent', agentNativeType: 'assistant.text', raw: c },
          ),
        );
      } else if (c.type === 'tool_use') {
        out.push(
          f.make(
            { type: 'tool_use', id: c.id, name: c.name, args: c.input },
            { turnId: turn, source: 'agent', capability: 'tool', agentNativeType: 'tool_use', raw: c },
          ),
        );
      }
    }
    return out;
  }

  if (type === 'user') {
    for (const c of raw.message?.content ?? []) {
      if (c.type === 'tool_result') {
        out.push(
          f.make(
            { type: 'tool_result', id: c.tool_use_id, name: '', result: c.content, isError: !!c.is_error },
            { turnId: 'tool', source: 'agent', capability: 'tool', agentNativeType: 'tool_result', raw: c },
          ),
        );
      }
    }
    return out;
  }

  if (type === 'system' && raw.subtype === 'hook_response') {
    out.push(
      f.make(
        {
          type: 'plugin',
          name: raw.hook_name ?? 'hook',
          event: 'hook-fired',
          confidence: 'observed',
          detail: { hookEvent: raw.hook_event, outcome: raw.outcome },
        },
        { turnId: 'hooks', source: 'agent', capability: 'plugin', agentNativeType: 'system/hook_response', raw },
      ),
    );
    return out;
  }

  if (type === 'result') {
    const u = raw.usage ?? {};
    out.push(
      f.make(
        {
          type: 'usage',
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cache_read_input_tokens,
          cacheCreationTokens: u.cache_creation_input_tokens,
          costUSD: raw.total_cost_usd,
        },
        { turnId: 'result', source: 'agent', agentNativeType: 'result.usage', raw: u },
      ),
    );
    const reason: RunEndReason = raw.is_error ? 'error' : 'completed';
    out.push(
      f.make(
        { type: 'run.end', runId, exitCode: raw.is_error ? 1 : 0, reason },
        { turnId: 'result', source: 'agent', agentNativeType: 'result', raw },
      ),
    );
    return out;
  }

  return out;
}

/** Aggregate the authoritative usage (from the `result` usage event). */
function aggregateUsage(events: AgentEvent[]): Usage {
  const totals: Usage = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
  for (const e of events) {
    if (isEvent(e, 'usage')) {
      totals.inputTokens += e.payload.inputTokens;
      totals.outputTokens += e.payload.outputTokens;
      totals.costUSD = (totals.costUSD ?? 0) + (e.payload.costUSD ?? 0);
    }
  }
  return totals;
}

export function buildArgs(opts: RunOptions): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose', '--model', opts.model];
  if (opts.pluginDir !== undefined) args.push('--plugin-dir', opts.pluginDir);
  if (opts.mcpConfig !== undefined) {
    args.push('--strict-mcp-config', '--mcp-config', JSON.stringify(opts.mcpConfig));
  }
  if (opts.maxBudgetUSD !== undefined) args.push('--max-budget-usd', String(opts.maxBudgetUSD));
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.allowedTools?.length) args.push('--allowedTools', ...opts.allowedTools);
  if (opts.disallowedTools?.length) args.push('--disallowedTools', ...opts.disallowedTools);
  if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

let runCounter = 0;

export class ClaudeDriver implements AgentDriver {
  readonly id = 'claude';
  constructor(private readonly bin = process.env.AGENTRY_CLAUDE_BIN ?? 'claude') {}

  capabilities(): DriverCapabilities {
    return {
      structuredStream: true,
      llmInterception: 'base-url',
      mcpTransports: ['stdio', 'http', 'sse'],
      toolPermissionControl: true,
      nativeBudgetControl: true,
    };
  }

  async run(opts: RunOptions): Promise<RunRecord> {
    const runId = `claude-${runCounter++}`;
    const factory = new EventFactory(runId);
    const events: AgentEvent[] = [];

    const child = spawn(this.bin, buildArgs(opts), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      let obj: unknown;
      try {
        obj = JSON.parse(s);
      } catch {
        return; // tolerate non-JSON noise
      }
      for (const e of parseClaudeEvent(obj, factory, runId)) events.push(e);
    });

    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));

    let timer: NodeJS.Timeout | undefined;
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => resolve(code));
      if (opts.timeoutMs) timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
      opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }).finally(() => timer && clearTimeout(timer));

    const ended = events.find((e) => isEvent(e, 'run.end'));
    const reason: RunEndReason = ended && isEvent(ended, 'run.end') ? ended.payload.reason : exitCode === 0 ? 'completed' : 'crash';
    if (!ended) {
      // synthesize a terminal event so the stream is always well-formed (SPEC §6)
      events.push(
        factory.make(
          { type: 'run.end', runId, exitCode, reason },
          { turnId: 'result', source: 'runner', agentNativeType: 'synthetic' },
        ),
      );
    }

    const result: RunResult = { exitCode, reason, usage: aggregateUsage(events) };
    return new RunRecord(events, result);
  }
}
