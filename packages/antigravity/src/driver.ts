/**
 * Antigravity (`agy`) driver. Drives `agy -p --output-format stream-json`
 * headlessly (stdin ignored so the CLI never blocks) and normalizes the native
 * `event`-discriminated stream into AgentEvents.
 *
 * `parseAntigravityEvents` is a pure whole-stream mapping (native events →
 * AgentEvents) so it can be unit-tested without spawning the CLI. Note: agy
 * writes to its own project/scratch dir by default, so sandbox fs-diff capture
 * is best-effort even though event-stream normalization is faithful.
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

/** Map a full agy `stream-json` stream into the normalized AgentEvent stream. */
export function parseAntigravityEvents(raws: Raw[], f: EventFactory, runId: string): AgentEvent[] {
  const out: AgentEvent[] = [];
  let bufferIndex: number | undefined;
  let bufferText = '';

  const flush = () => {
    if (bufferIndex === undefined) return;
    out.push(
      f.make(
        { type: 'message', role: 'assistant', text: bufferText },
        { turnId: `step-${bufferIndex}`, source: 'agent', agentNativeType: 'agent_response' },
      ),
    );
    bufferIndex = undefined;
    bufferText = '';
  };

  for (const raw of raws) {
    const event = raw?.event;

    if (event === 'init') {
      out.push(
        f.make(
          { type: 'run.start', runId, agent: 'antigravity', model: raw.model ?? '' },
          { turnId: 'init', source: 'agent', agentNativeType: 'init', raw },
        ),
      );
      continue;
    }

    if (event === 'step_update') {
      const su = raw.step_update ?? {};
      if (su.step_type === 'tool') {
        if (bufferIndex !== undefined && su.step_index !== bufferIndex) flush();
        if (su.state === 'ACTIVE') {
          out.push(
            f.make(
              { type: 'tool_use', id: String(su.step_index), name: su.tool_name, args: su.tool_info?.parameters },
              { turnId: `step-${su.step_index}`, source: 'agent', capability: 'tool', agentNativeType: 'step_update/tool', raw: su },
            ),
          );
        } else if (su.state === 'DONE') {
          out.push(
            f.make(
              { type: 'tool_result', id: String(su.step_index), name: su.tool_name, result: su.tool_info?.result, isError: false },
              { turnId: `step-${su.step_index}`, source: 'agent', capability: 'tool', agentNativeType: 'step_update/tool', raw: su },
            ),
          );
        }
      } else if (su.step_type === 'agent_response' && su.text_delta !== undefined) {
        if (bufferIndex !== undefined && su.step_index !== bufferIndex) flush();
        bufferIndex = su.step_index;
        bufferText += su.text_delta;
      } else if (bufferIndex !== undefined && su.step_index !== bufferIndex) {
        flush();
      }
      continue;
    }

    if (event === 'result') {
      flush();
      const r = raw.result ?? {};
      const u = r.usage ?? {};
      out.push(
        f.make(
          {
            type: 'usage',
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_tokens,
          },
          { turnId: 'result', source: 'agent', agentNativeType: 'result.usage', raw: u },
        ),
      );
      const reason: RunEndReason = r.status === 'SUCCESS' ? 'completed' : 'error';
      out.push(
        f.make(
          { type: 'run.end', runId, exitCode: r.status === 'SUCCESS' ? 0 : 1, reason },
          { turnId: 'result', source: 'agent', agentNativeType: 'result', raw },
        ),
      );
      continue;
    }
  }

  flush();
  return out;
}

/** Aggregate the authoritative usage (from the terminal `result` usage event). */
function aggregateUsage(events: AgentEvent[]): Usage {
  const totals: Usage = { inputTokens: 0, outputTokens: 0 };
  for (const e of events) {
    if (isEvent(e, 'usage')) {
      totals.inputTokens += e.payload.inputTokens;
      totals.outputTokens += e.payload.outputTokens;
      if (e.payload.cacheReadTokens !== undefined) {
        totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + e.payload.cacheReadTokens;
      }
    }
  }
  return totals;
}

export function buildArgs(opts: RunOptions): string[] {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--model', opts.model, '--add-dir', opts.cwd];
  if (opts.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  return args;
}

let runCounter = 0;

export class AntigravityDriver implements AgentDriver {
  readonly id = 'antigravity';
  constructor(private readonly bin = process.env.AGENTRY_ANTIGRAVITY_BIN ?? 'agy') {}

  capabilities(): DriverCapabilities {
    return {
      structuredStream: true,
      llmInterception: 'none',
      mcpTransports: [],
      toolPermissionControl: true,
      nativeBudgetControl: false,
    };
  }

  async run(opts: RunOptions): Promise<RunRecord> {
    const runId = `antigravity-${runCounter++}`;
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

    const events = parseAntigravityEvents(raws, factory, runId);

    const ended = events.find((e) => isEvent(e, 'run.end'));
    const reason: RunEndReason = ended && isEvent(ended, 'run.end') ? ended.payload.reason : exitCode === 0 ? 'completed' : 'crash';
    if (!ended) {
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
