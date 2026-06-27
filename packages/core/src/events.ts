/**
 * Normalized, causal event model (SPEC §6).
 *
 * Every event is wrapped in an {@link EventEnvelope} that records causality
 * (`parentId`/`turnId`), provenance (`source`/`transport`), and — crucially —
 * preserves the driver's `raw` native payload so normalization is never lossy.
 *
 * Drivers translate an agent CLI's native surface into this single
 * agent-agnostic stream; assertions and traces read only this.
 */

export type EventSource = 'agent' | 'llm-proxy' | 'mcp-proxy' | 'sandbox' | 'runner';
export type Transport = 'stdio' | 'http' | 'sse' | 'pty';
export type Capability = 'mcp' | 'skill' | 'plugin' | 'tool' | 'llm';

/** Whether a skill/plugin signal was directly observed or only inferred (SPEC §9.2). */
export type Confidence = 'observed' | 'inferred';

/** Reason a run ended — distinguishes failure modes that must not collapse into "timeout". */
export type RunEndReason =
  | 'completed'
  | 'refusal'
  | 'timeout'
  | 'crash'
  | 'budget'
  | 'loop'
  | 'error';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUSD?: number;
}

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

// ── Payload variants ────────────────────────────────────────────────────────

export interface RunStartPayload {
  type: 'run.start';
  runId: string;
  agent: string;
  model: string;
  scenario?: string;
}

export interface MessagePayload {
  type: 'message';
  role: 'assistant' | 'user' | 'system';
  text: string;
}

export interface ToolUsePayload {
  type: 'tool_use';
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResultPayload {
  type: 'tool_result';
  id: string;
  name: string;
  result: unknown;
  isError: boolean;
}

export interface McpRequestPayload {
  type: 'mcp_request';
  server: string;
  method: string;
  params?: unknown;
}

export interface McpResponsePayload {
  type: 'mcp_response';
  server: string;
  method: string;
  result?: unknown;
  error?: unknown;
}

export interface LlmRequestPayload {
  type: 'llm_request';
  model: string;
  system?: unknown;
  messages: unknown[];
  tools?: ToolDef[];
  params?: Record<string, unknown>;
}

export interface LlmResponsePayload {
  type: 'llm_response';
  model: string;
  finishReason?: string;
  usage?: Usage;
}

export interface SkillPayload {
  type: 'skill';
  name: string;
  phase: 'available' | 'invoke' | 'result';
  args?: unknown;
  result?: unknown;
  confidence: Confidence;
}

export interface PluginPayload {
  type: 'plugin';
  name: string;
  event: 'loaded' | 'tool-registered' | 'context-injected' | 'hook-fired';
  detail?: unknown;
  confidence: Confidence;
}

export interface FsPayload {
  type: 'fs';
  op: 'create' | 'modify' | 'delete';
  path: string;
}

export interface UsagePayload extends Usage {
  type: 'usage';
}

export interface ErrorPayload {
  type: 'error';
  kind: 'refusal' | 'timeout' | 'crash' | 'budget' | 'loop' | 'api';
  detail?: unknown;
}

export interface RunEndPayload {
  type: 'run.end';
  runId: string;
  exitCode: number | null;
  reason: RunEndReason;
}

export type AgentEventPayload =
  | RunStartPayload
  | MessagePayload
  | ToolUsePayload
  | ToolResultPayload
  | McpRequestPayload
  | McpResponsePayload
  | LlmRequestPayload
  | LlmResponsePayload
  | SkillPayload
  | PluginPayload
  | FsPayload
  | UsagePayload
  | ErrorPayload
  | RunEndPayload;

export type EventType = AgentEventPayload['type'];

export interface EventEnvelope<P extends AgentEventPayload = AgentEventPayload> {
  eventId: string;
  parentId?: string;
  turnId: string;
  source: EventSource;
  transport?: Transport;
  capability?: Capability;
  /** The CLI's own event type, pre-normalization. */
  agentNativeType?: string;
  /** Preserved native payload — never discarded. */
  raw?: unknown;
  redactionStatus: 'none' | 'redacted';
  ts: number;
  payload: P;
}

// ── Convenience aliases for typed envelopes ──────────────────────────────────

export type AgentEvent = EventEnvelope;
export type ToolUseEvent = EventEnvelope<ToolUsePayload>;
export type ToolResultEvent = EventEnvelope<ToolResultPayload>;
export type McpRequestEvent = EventEnvelope<McpRequestPayload>;
export type McpResponseEvent = EventEnvelope<McpResponsePayload>;
export type LlmRequestEvent = EventEnvelope<LlmRequestPayload>;
export type LlmResponseEvent = EventEnvelope<LlmResponsePayload>;
export type MessageEvent = EventEnvelope<MessagePayload>;
export type SkillEvent = EventEnvelope<SkillPayload>;
export type PluginEvent = EventEnvelope<PluginPayload>;

/** Narrow an envelope to a payload type (type guard). */
export function isEvent<T extends EventType>(
  e: EventEnvelope,
  type: T,
): e is EventEnvelope<Extract<AgentEventPayload, { type: T }>> {
  return e.payload.type === type;
}

/**
 * Stamps envelopes with deterministic, sequential event ids within a run
 * (`<runId>:<n>`), so cassettes and snapshots stay stable. `ts` is injected so
 * callers can supply a monotonic clock (and tests can stub it).
 */
export class EventFactory {
  private seq = 0;
  constructor(
    private readonly runId: string,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  make<P extends AgentEventPayload>(
    payload: P,
    meta: Omit<EventEnvelope<P>, 'eventId' | 'ts' | 'payload' | 'redactionStatus'> &
      Partial<Pick<EventEnvelope<P>, 'redactionStatus'>>,
  ): EventEnvelope<P> {
    return {
      eventId: `${this.runId}:${this.seq++}`,
      ts: this.clock(),
      redactionStatus: meta.redactionStatus ?? 'none',
      ...meta,
      payload,
    };
  }
}
