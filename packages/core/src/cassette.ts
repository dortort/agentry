/**
 * Ordered, session-positional cassettes (SPEC §7.4, §7.4.1) — the record/replay
 * substrate that makes `replay` runs deterministic and free (SPEC §5).
 *
 * Playwright matches HAR statelessly on `URL+method+body`. LLM calls are
 * history-accumulating and non-deterministic, so a stateless body match yields
 * *false matches* (replaying the wrong response into a plausible-looking run).
 * Agentry instead keys each exchange by its **position** in the session
 * (`turnIndex`/`callIndex`) plus a **canonicalized** content hash, with every
 * volatile field (provider/request ids, message & tool-use ids, timestamps,
 * `cache_control` breakpoints, key ordering) stripped *before* hashing — so two
 * runs that differ only in fresh ids/timestamps canonicalize, and therefore
 * replay, identically.
 *
 * Collision is a hard error ("ambiguous cassette entry"), never silent
 * first-match (SPEC §7.4.1).
 */
import { createHash } from 'node:crypto';

/** Cassette schema version. Bumped on breaking changes to the on-disk shape. */
const CASSETTE_VERSION = 1;

/** Sampling params kept in the canonical LLM request (SPEC §7.4.1). */
const SAMPLING_PARAMS = ['max_tokens', 'temperature', 'top_p', 'stream'] as const;

/** Top-level fields dropped before hashing (volatile / non-content). */
const VOLATILE_TOP_LEVEL = new Set(['request_id', 'id', 'metadata']);

// ── Public shapes ────────────────────────────────────────────────────────────

/** One recorded LLM or MCP exchange, addressed by its session position + key. */
export interface CassetteEntry {
  kind: 'llm' | 'mcp';
  /** i-th model turn of the session (0-based). */
  turnIndex: number;
  /** i-th call within the turn (0-based). */
  callIndex: number;
  /** Logical endpoint, e.g. `llm://anthropic/messages` or `mcp://fs/read_file`. */
  endpoint: string;
  /** The canonicalized request (volatile fields stripped) — for inspection/diffing. */
  requestCanonical: unknown;
  /** The recorded response served back on replay. */
  response: unknown;
  /** sha256 positional match key (see {@link matchKey}). */
  key: string;
}

/** An ordered log of exchanges for one session (the `routeFromHAR` analog). */
export interface Cassette {
  version: number;
  sessionId: string;
  entries: CassetteEntry[];
}

/** Input to {@link CassetteRecorder.record}. */
export interface RecordInput {
  kind: 'llm' | 'mcp';
  turnIndex: number;
  callIndex: number;
  endpoint: string;
  body: unknown;
  response: unknown;
}

/** Input to {@link CassettePlayer.lookup}. */
export interface LookupInput {
  kind: 'llm' | 'mcp';
  turnIndex: number;
  callIndex: number;
  endpoint: string;
  body: unknown;
}

// ── Low-level helpers ────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Recursively sort object keys so JSON output is order-independent (arrays kept). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}

/** Stable JSON stringify with deterministically sorted keys (hash input). */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Keys whose values are clocks/sequence stamps and must not enter the hash. */
function isTimestampLikeKey(key: string): boolean {
  const k = key.toLowerCase();
  if (k === 'timestamp' || k === 'time' || k === 'date' || k === 'ts') return true;
  if (k === 'created' || k === 'updated' || k === 'created_at' || k === 'updated_at') return true;
  return k.endsWith('_at') || k.endsWith('_ts') || k.endsWith('timestamp');
}

function isDroppedTopLevelKey(key: string): boolean {
  return VOLATILE_TOP_LEVEL.has(key) || isTimestampLikeKey(key);
}

/**
 * First-seen ordinal map for tool ids found anywhere in the body. Anthropic
 * `tool_use.id` / `tool_result.tool_use_id` (and OpenAI-style `tool_calls[].id`
 * / `tool_call_id`) are collected in traversal order so the same original id
 * maps to the same `tool#N` everywhere it is referenced.
 */
function collectToolIds(body: unknown): Map<string, string> {
  const map = new Map<string, string>();
  let next = 0;
  const remember = (id: unknown): void => {
    if (typeof id === 'string' && !map.has(id)) map.set(id, `tool#${next++}`);
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isObject(node)) return;
    if (node.type === 'tool_use') remember(node.id);
    remember(node.tool_use_id);
    remember(node.tool_call_id);
    if (Array.isArray(node.tool_calls)) {
      for (const call of node.tool_calls) if (isObject(call)) remember(call.id);
    }
    for (const k of Object.keys(node)) visit(node[k]);
  };
  visit(body);
  return map;
}

/**
 * Deep transform: drop top-level volatile keys, remove `cache_control`
 * everywhere, and remap any collected tool id to its ordinal — applied
 * consistently across the whole body.
 */
function clean(node: unknown, idMap: Map<string, string>, topLevel: boolean): unknown {
  if (Array.isArray(node)) return node.map((n) => clean(n, idMap, false));
  if (isObject(node)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'cache_control') continue;
      if (topLevel && isDroppedTopLevelKey(k)) continue;
      out[k] = clean(v, idMap, false);
    }
    return out;
  }
  if (typeof node === 'string' && idMap.has(node)) return idMap.get(node);
  return node;
}

/** Normalize an Anthropic `system` (string or text blocks) to a plain string. */
function normalizeSystem(system: unknown): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (isObject(b) && typeof b.text === 'string' ? b.text : ''))
      .join('\n');
  }
  return '';
}

function toolName(tool: unknown): string {
  return isObject(tool) && typeof tool.name === 'string' ? tool.name : '';
}

/** Order-insensitive tool set: clone + sort by name (already `cache_control`-free). */
function sortTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  return [...tools].sort((a, b) => {
    const an = toolName(a);
    const bn = toolName(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

// ── Canonicalization & match key (SPEC §7.4.1) ───────────────────────────────

/**
 * Canonicalize a request into a stable form plus the two content hashes the
 * match key consumes. Volatile fields are stripped *before* hashing:
 * request/message/tool ids, timestamps and `cache_control` (SPEC §7.4.1).
 *
 * For Anthropic `/v1/messages`-shaped bodies the canonical keeps `model`,
 * normalized `system` text, normalized `messages`, name-sorted `tools`, and the
 * sampling params. Any other body is canonicalized generically (volatile fields
 * stripped) and hashed whole into `messagesHash`.
 */
export function canonicalizeRequest(
  kind: 'llm' | 'mcp',
  endpoint: string,
  body: unknown,
): { canonical: unknown; toolSchemaHash: string; messagesHash: string } {
  const idMap = collectToolIds(body);
  const cleaned = clean(body, idMap, true);

  const isMessagesShaped = kind === 'llm' && isObject(body) && Array.isArray(body.messages);
  if (!isMessagesShaped || !isObject(cleaned)) {
    return {
      canonical: cleaned,
      toolSchemaHash: '',
      messagesHash: sha256(stableStringify(cleaned)),
    };
  }

  const system = normalizeSystem(cleaned.system);
  const messages = Array.isArray(cleaned.messages) ? cleaned.messages : [];
  const tools = sortTools(cleaned.tools);

  const canonical: Record<string, unknown> = {};
  if ('model' in cleaned) canonical.model = cleaned.model;
  canonical.system = system;
  canonical.messages = messages;
  canonical.tools = tools;
  for (const p of SAMPLING_PARAMS) {
    if (p in cleaned) canonical[p] = cleaned[p];
  }

  return {
    canonical,
    toolSchemaHash: tools.length ? sha256(stableStringify(tools)) : '',
    messagesHash: sha256(stableStringify({ system, messages })),
  };
}

/**
 * Positional match key (SPEC §7.4.1):
 * `sha256(sessionId · turnIndex · callIndex · endpoint · toolSchemaHash · messagesHash)`.
 * `turnIndex`/`callIndex` are the primary discriminators, so identical-looking
 * requests at different points in the session still resolve correctly.
 */
export function matchKey(parts: {
  sessionId: string;
  turnIndex: number;
  callIndex: number;
  endpoint: string;
  toolSchemaHash: string;
  messagesHash: string;
}): string {
  return sha256(
    [
      parts.sessionId,
      String(parts.turnIndex),
      String(parts.callIndex),
      parts.endpoint,
      parts.toolSchemaHash,
      parts.messagesHash,
    ].join(' '),
  );
}

// ── Recorder / Player ────────────────────────────────────────────────────────

/** Records exchanges in order, rejecting any duplicate positional key. */
export class CassetteRecorder {
  private readonly entries: CassetteEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(public readonly sessionId: string) {}

  record(input: RecordInput): CassetteEntry {
    const { canonical, toolSchemaHash, messagesHash } = canonicalizeRequest(
      input.kind,
      input.endpoint,
      input.body,
    );
    const key = matchKey({
      sessionId: this.sessionId,
      turnIndex: input.turnIndex,
      callIndex: input.callIndex,
      endpoint: input.endpoint,
      toolSchemaHash,
      messagesHash,
    });
    if (this.seen.has(key)) {
      throw new Error(
        `ambiguous cassette entry: duplicate key at turn ${input.turnIndex}, call ` +
          `${input.callIndex} (${input.endpoint}) — two requests canonicalize identically`,
      );
    }
    this.seen.add(key);
    const entry: CassetteEntry = {
      kind: input.kind,
      turnIndex: input.turnIndex,
      callIndex: input.callIndex,
      endpoint: input.endpoint,
      requestCanonical: canonical,
      response: input.response,
      key,
    };
    this.entries.push(entry);
    return entry;
  }

  toJSON(): Cassette {
    return { version: CASSETTE_VERSION, sessionId: this.sessionId, entries: [...this.entries] };
  }
}

/** Replays exchanges by recomputing each request's positional key. */
export class CassettePlayer {
  private readonly sessionId: string;
  private readonly byKey = new Map<string, CassetteEntry>();

  constructor(cassette: Cassette) {
    this.sessionId = cassette.sessionId;
    for (const entry of cassette.entries) {
      if (this.byKey.has(entry.key)) {
        throw new Error(`ambiguous cassette entry: duplicate key ${entry.key}`);
      }
      this.byKey.set(entry.key, entry);
    }
  }

  lookup(input: LookupInput): { hit: true; response: unknown } | { hit: false } {
    const { toolSchemaHash, messagesHash } = canonicalizeRequest(
      input.kind,
      input.endpoint,
      input.body,
    );
    const key = matchKey({
      sessionId: this.sessionId,
      turnIndex: input.turnIndex,
      callIndex: input.callIndex,
      endpoint: input.endpoint,
      toolSchemaHash,
      messagesHash,
    });
    const entry = this.byKey.get(key);
    return entry ? { hit: true, response: entry.response } : { hit: false };
  }
}

// ── (De)serialization ────────────────────────────────────────────────────────

/** Pretty, key-stable JSON for committing cassettes to the repo. */
export function serializeCassette(cassette: Cassette): string {
  return `${JSON.stringify(sortKeys(cassette), null, 2)}\n`;
}

/** Parse + validate a cassette; throws on unsupported version or bad shape. */
export function parseCassette(json: string): Cassette {
  const parsed: unknown = JSON.parse(json);
  if (!isObject(parsed)) {
    throw new Error('invalid cassette: expected a JSON object');
  }
  if (parsed.version !== CASSETTE_VERSION) {
    throw new Error(
      `unsupported cassette version: ${String(parsed.version)} (expected ${CASSETTE_VERSION})`,
    );
  }
  if (typeof parsed.sessionId !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error('invalid cassette: missing sessionId or entries');
  }
  return parsed as unknown as Cassette;
}
