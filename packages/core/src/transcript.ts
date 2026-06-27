/**
 * Transcript record/replay — the MVP's deterministic, free replay path.
 *
 * A transcript is the recorded normalized run (events + result). In `record`
 * mode the live driver runs once and we persist the transcript; in `replay`
 * mode {@link ReplayDriver} reconstructs the RunRecord WITHOUT spawning an
 * agent — fast (<2s), free, deterministic.
 *
 * This is distinct from the wire-level {@link Cassette} (SPEC §7.4), which
 * intercepts LLM/MCP HTTP for true hermetic re-execution and gateway testing
 * (later phases). For asserting on recorded agent behavior, transcript replay
 * is the robust MVP choice.
 */
import { RunRecord, type RunResult } from './run';
import type { AgentDriver, DriverCapabilities, RunOptions } from './driver';
import type { AgentEvent } from './events';

const TRANSCRIPT_VERSION = 1;

export interface Transcript {
  version: number;
  /** The prompt that produced this run (for provenance / drift detection). */
  prompt?: string;
  model?: string;
  events: AgentEvent[];
  result: RunResult;
}

const FALLBACK_RESULT: RunResult = {
  exitCode: 0,
  reason: 'completed',
  usage: { inputTokens: 0, outputTokens: 0, costUSD: 0 },
};

/** Capture a completed RunRecord as a serializable transcript. */
export function recordTranscript(rec: RunRecord, meta?: { prompt?: string; model?: string }): Transcript {
  return {
    version: TRANSCRIPT_VERSION,
    prompt: meta?.prompt,
    model: meta?.model,
    events: rec.events,
    result: rec.result ?? { ...FALLBACK_RESULT, usage: rec.usage },
  };
}

export function serializeTranscript(t: Transcript): string {
  return `${JSON.stringify(t, null, 2)}\n`;
}

export function parseTranscript(json: string): Transcript {
  const parsed = JSON.parse(json) as Transcript;
  if (parsed?.version !== TRANSCRIPT_VERSION) {
    throw new Error(`unsupported transcript version: ${String(parsed?.version)} (expected ${TRANSCRIPT_VERSION})`);
  }
  if (!Array.isArray(parsed.events) || !parsed.result) {
    throw new Error('invalid transcript: missing events or result');
  }
  return parsed;
}

/** A driver that replays a recorded transcript instead of spawning an agent. */
export class ReplayDriver implements AgentDriver {
  readonly id = 'replay';
  constructor(private readonly transcript: Transcript) {}

  capabilities(): DriverCapabilities {
    return {
      structuredStream: true,
      llmInterception: 'none',
      mcpTransports: [],
      toolPermissionControl: false,
      nativeBudgetControl: false,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async run(_opts: RunOptions): Promise<RunRecord> {
    return new RunRecord(this.transcript.events, this.transcript.result);
  }
}
