/**
 * Codex CLI driver (SPEC §4.2). Drives `codex exec --json` headlessly and
 * normalizes the native thread/item stream into AgentEvents.
 *
 * `parseCodexEvent` is a pure mapping (one native event → zero+ AgentEvents)
 * so it can be unit-tested without spawning the CLI. Codex normalizes shell as
 * tool `shell` and patches as `apply_patch`; LLM interception is provider-config
 * (not wired to Agentry's Anthropic proxy); `reasoning` items and non-live
 * `mcp_tool_call` mapping are best-effort/dropped in the MVP.
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

/** Map a single Codex `exec --json` event into zero or more AgentEvents. */
export function parseCodexEvent(raw: Raw, f: EventFactory, runId: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  const type = raw?.type;

  if (type === 'thread.started') {
    out.push(
      f.make(
        { type: 'run.start', runId, agent: 'codex', model: raw.model ?? '' },
        { turnId: 'init', source: 'agent', agentNativeType: 'thread.started', raw },
      ),
    );
    return out;
  }

  if (type === 'turn.started') {
    return out;
  }

  if (type === 'item.started' || type === 'item.completed') {
    const item = raw.item ?? {};
    const turn = item.id ?? 'item';

    if (item.type === 'agent_message' && type === 'item.completed') {
      out.push(
        f.make(
          { type: 'message', role: 'assistant', text: item.text ?? '' },
          { turnId: turn, source: 'agent', agentNativeType: 'item.agent_message', raw: item },
        ),
      );
      return out;
    }

    if (item.type === 'command_execution') {
      if (type === 'item.started') {
        out.push(
          f.make(
            { type: 'tool_use', id: item.id, name: 'shell', args: { command: item.command } },
            { turnId: turn, source: 'agent', capability: 'tool', agentNativeType: 'item.command_execution', raw: item },
          ),
        );
      } else {
        out.push(
          f.make(
            {
              type: 'tool_result',
              id: item.id,
              name: 'shell',
              result: item.aggregated_output,
              isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
            },
            { turnId: turn, source: 'agent', capability: 'tool', agentNativeType: 'item.command_execution', raw: item },
          ),
        );
      }
      return out;
    }

    if (item.type === 'file_change') {
      if (type === 'item.started') {
        out.push(
          f.make(
            { type: 'tool_use', id: item.id, name: 'apply_patch', args: { changes: item.changes } },
            { turnId: turn, source: 'agent', capability: 'tool', agentNativeType: 'item.file_change', raw: item },
          ),
        );
      } else {
        out.push(
          f.make(
            { type: 'tool_result', id: item.id, name: 'apply_patch', result: item.changes, isError: false },
            { turnId: turn, source: 'agent', capability: 'tool', agentNativeType: 'item.file_change', raw: item },
          ),
        );
      }
      return out;
    }

    if (item.type === 'mcp_tool_call' && type === 'item.started') {
      out.push(
        f.make(
          {
            type: 'mcp_request',
            server: item.server ?? '',
            method: 'tools/call',
            params: { name: item.tool ?? item.name, arguments: item.arguments ?? item.args },
          },
          { turnId: turn, source: 'agent', capability: 'mcp', agentNativeType: 'item.mcp_tool_call', raw: item },
        ),
      );
      return out;
    }

    return out;
  }

  if (type === 'turn.completed') {
    const u = raw.usage ?? {};
    out.push(
      f.make(
        {
          type: 'usage',
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cached_input_tokens,
          cacheCreationTokens: u.cache_write_input_tokens,
        },
        { turnId: 'turn', source: 'agent', agentNativeType: 'turn.completed', raw: u },
      ),
    );
    return out;
  }

  if (type === 'error') {
    out.push(
      f.make(
        { type: 'error', kind: 'api', detail: { message: raw.message } },
        { turnId: 'error', source: 'agent', agentNativeType: 'error', raw },
      ),
    );
    return out;
  }

  return out;
}

/** Aggregate usage across the stream's `usage` events (Codex reports no cost). */
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
  const args = [
    'exec',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--ephemeral',
    '-C',
    opts.cwd,
    '-m',
    opts.model,
  ];
  if (opts.permissionMode === 'bypassPermissions') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'workspace-write');
  }
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push(opts.prompt);
  return args;
}

let runCounter = 0;

export class CodexDriver implements AgentDriver {
  readonly id = 'codex';
  constructor(private readonly bin = process.env.AGENTRY_CODEX_BIN ?? 'codex') {}

  capabilities(): DriverCapabilities {
    return {
      structuredStream: true,
      llmInterception: 'provider-config',
      mcpTransports: ['stdio'],
      toolPermissionControl: true,
      nativeBudgetControl: false,
    };
  }

  async run(opts: RunOptions): Promise<RunRecord> {
    const runId = `codex-${runCounter++}`;
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
      for (const e of parseCodexEvent(obj, factory, runId)) events.push(e);
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
      // Codex emits no terminal event; synthesize run.end so the stream is well-formed (SPEC §6)
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
