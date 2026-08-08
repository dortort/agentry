/**
 * Gemini CLI driver (SPEC §4.2). Drives `gemini -p --output-format stream-json`
 * headlessly and normalizes the native stream into AgentEvents.
 *
 * Gemini streams assistant text as delta chunks, so `parseGeminiEvents` is a
 * pure whole-stream mapping (native events → AgentEvents) that coalesces
 * consecutive assistant deltas into a single message. LLM interception via
 * base-url is unproven, so declared 'none' and not wired to Agentry's proxy;
 * transcript record/replay works, wire cassette does not apply. The final
 * `result` event carries authoritative stats (no per-token cost).
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

/** Map a full Gemini `stream-json` stream into AgentEvents, coalescing assistant deltas. */
export function parseGeminiEvents(raws: Raw[], f: EventFactory, runId: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  let pending = '';

  const flush = () => {
    if (!pending) return;
    out.push(
      f.make(
        { type: 'message', role: 'assistant', text: pending },
        { turnId: 'assistant', source: 'agent', agentNativeType: 'message' },
      ),
    );
    pending = '';
  };

  for (const raw of raws) {
    const type = raw?.type;

    if (type === 'init') {
      out.push(
        f.make(
          { type: 'run.start', runId, agent: 'gemini', model: raw.model },
          { turnId: 'init', source: 'agent', agentNativeType: 'init', raw },
        ),
      );
      continue;
    }

    if (type === 'message') {
      if (raw.role === 'assistant') {
        pending += raw.content ?? '';
        continue;
      }
      flush();
      out.push(
        f.make(
          { type: 'message', role: 'user', text: raw.content ?? '' },
          { turnId: 'user', source: 'agent', agentNativeType: 'message', raw },
        ),
      );
      continue;
    }

    if (type === 'tool_use') {
      flush();
      out.push(
        f.make(
          { type: 'tool_use', id: raw.tool_id, name: raw.tool_name, args: raw.parameters },
          { turnId: 'assistant', source: 'agent', capability: 'tool', agentNativeType: 'tool_use', raw },
        ),
      );
      continue;
    }

    if (type === 'tool_result') {
      out.push(
        f.make(
          { type: 'tool_result', id: raw.tool_id, name: '', result: raw.output, isError: raw.status === 'error' },
          { turnId: 'tool', source: 'agent', capability: 'tool', agentNativeType: 'tool_result', raw },
        ),
      );
      continue;
    }

    if (type === 'error') {
      out.push(
        f.make(
          { type: 'error', kind: 'api', detail: { severity: raw.severity, message: raw.message } },
          { turnId: 'error', source: 'agent', agentNativeType: 'error', raw },
        ),
      );
      continue;
    }

    if (type === 'result') {
      flush();
      const stats = raw.stats ?? {};
      out.push(
        f.make(
          {
            type: 'usage',
            inputTokens: stats.input_tokens ?? 0,
            outputTokens: stats.output_tokens ?? 0,
            cacheReadTokens: stats.cached,
          },
          { turnId: 'result', source: 'agent', agentNativeType: 'result.usage', raw: stats },
        ),
      );
      const reason: RunEndReason = raw.status === 'error' ? 'error' : 'completed';
      out.push(
        f.make(
          { type: 'run.end', runId, exitCode: raw.status === 'error' ? 1 : 0, reason },
          { turnId: 'result', source: 'agent', agentNativeType: 'result', raw },
        ),
      );
      continue;
    }
  }

  flush();
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
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '-m', opts.model, '--skip-trust'];
  if (opts.permissionMode === 'bypassPermissions') args.push('--approval-mode', 'yolo');
  else args.push('--approval-mode', 'default');
  if (opts.allowedTools?.length) args.push('--allowed-tools', ...opts.allowedTools);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

let runCounter = 0;

export class GeminiDriver implements AgentDriver {
  readonly id = 'gemini';
  constructor(private readonly bin = process.env.AGENTRY_GEMINI_BIN ?? 'gemini') {}

  capabilities(): DriverCapabilities {
    return {
      structuredStream: true,
      llmInterception: 'none',
      mcpTransports: ['stdio', 'http', 'sse'],
      toolPermissionControl: true,
      nativeBudgetControl: false,
    };
  }

  async run(opts: RunOptions): Promise<RunRecord> {
    const runId = `gemini-${runCounter++}`;
    const factory = new EventFactory(runId);
    const raws: unknown[] = [];

    const child = spawn(this.bin, buildArgs(opts), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      try {
        raws.push(JSON.parse(s));
      } catch {
        return; // tolerate non-JSON noise
      }
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

    const events = parseGeminiEvents(raws, factory, runId);

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
