/**
 * LLM wire helpers (SPEC §6.1 CH1). Pure functions that normalize an Anthropic
 * `/v1/messages` request body into the fields the `llm_request` event and the
 * CH1 matchers (`toInjectContext`, `toRegisterTools`) read. No I/O — unit-testable.
 */
import type { LlmRequestPayload, ToolDef } from './events';

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const SAMPLING_KEYS = ['max_tokens', 'temperature', 'top_p', 'top_k', 'stream', 'stop_sequences'];

/** Parse an Anthropic request body into a normalized `llm_request` payload (sans `type`). */
export function parseAnthropicRequest(body: unknown): Omit<LlmRequestPayload, 'type'> {
  const b = isObject(body) ? body : {};
  const tools: ToolDef[] = Array.isArray(b.tools)
    ? b.tools.filter(isObject).map((t) => ({
        name: typeof t.name === 'string' ? t.name : '',
        description: typeof t.description === 'string' ? t.description : undefined,
        inputSchema: t.input_schema,
      }))
    : [];
  const params: Record<string, unknown> = {};
  for (const k of SAMPLING_KEYS) if (k in b) params[k] = b[k];
  return {
    model: typeof b.model === 'string' ? b.model : '',
    system: b.system,
    messages: Array.isArray(b.messages) ? b.messages : [],
    tools,
    params,
  };
}

/** Normalize an Anthropic `system` (string | text blocks) into plain text. */
export function systemText(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (isObject(b) && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

/**
 * Concatenate all text visible in a request (system + message text/tool-result
 * blocks) — the search surface for CH1 context-injection assertions.
 */
export function collectRequestText(req: { system?: unknown; messages: readonly unknown[] }): string {
  const parts: string[] = [systemText(req.system)];
  for (const m of req.messages) {
    const content = isObject(m) ? m.content : undefined;
    if (typeof content === 'string') {
      parts.push(content);
    } else if (Array.isArray(content)) {
      for (const blk of content) {
        if (!isObject(blk)) continue;
        if (typeof blk.text === 'string') parts.push(blk.text);
        if (typeof blk.content === 'string') parts.push(blk.content); // tool_result text
      }
    }
  }
  return parts.join('\n');
}

/** Names of the tools declared in a request — for `toRegisterTools`. */
export function toolNames(req: { tools?: readonly ToolDef[] }): string[] {
  return (req.tools ?? []).map((t) => t.name);
}
