/**
 * Programmable Mock MCP server (SPEC §9.1) — the in-process fixture that backs
 * the MCP assertion surface (`toExposeTools`, `toHaveToolCall`, `toHaveError`,
 * …) without a real server or network.
 *
 * {@link McpServerCore} is transport-agnostic: it consumes/produces JSON-RPC 2.0
 * objects and records *every* request it receives (method + params, in order)
 * so tests can assert discovery and invocation deterministically — no
 * timestamps, no ids in the record. {@link runStdioServer} adapts that core to
 * the stdio shim form (SPEC §7.2): newline-delimited JSON-RPC, one object per
 * line, over stdin/stdout.
 */
import { createInterface } from 'node:readline';

// ── Public shapes ────────────────────────────────────────────────────────────

/** A tool the mock advertises via `tools/list` and answers via `tools/call`. */
export interface MockTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** Static result returned by `tools/call` when no {@link MockTool.handler} is set. */
  result?: unknown;
  /** Dynamic result computed from the call's `arguments`; takes precedence over `result`. */
  handler?: (args: unknown) => unknown;
}

/** One received request, captured deterministically (no timestamps/ids). */
export interface RecordedCall {
  method: string;
  params?: unknown;
}

/** Inbound JSON-RPC 2.0 request (notifications omit `id`). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

/** Outbound JSON-RPC 2.0 response — exactly one of `result`/`error` is set. */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ── Core ─────────────────────────────────────────────────────────────────────

/**
 * Transport-agnostic mock MCP endpoint. Feed it JSON-RPC requests via
 * {@link McpServerCore.handle}; it records each one in {@link McpServerCore.received}
 * and returns a response (or `null` for notifications, which carry no `id`).
 */
export class McpServerCore {
  /** Every request received, in arrival order (method + params). */
  readonly received: RecordedCall[] = [];
  private readonly tools: MockTool[];
  private readonly serverName: string;

  constructor(opts: { tools: MockTool[]; serverName?: string }) {
    this.tools = opts.tools;
    this.serverName = opts.serverName ?? 'agentry-mock';
  }

  /** Names of the tools this mock advertises (for the toExposeTools matcher). */
  get toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  handle(msg: JsonRpcRequest): JsonRpcResponse | null {
    this.record(msg);

    // Notifications carry no id and never receive a response (e.g. notifications/initialized).
    if (msg.id === undefined) return null;
    const id = msg.id;

    switch (msg.method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: this.serverName, version: '0.0.0' },
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, {
          tools: this.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case 'tools/call':
        return this.callTool(id, msg.params);
      default:
        return fail(id, -32601, `method not found: ${msg.method}`);
    }
  }

  private record(msg: JsonRpcRequest): void {
    const call: RecordedCall = { method: msg.method };
    if (msg.params !== undefined) call.params = msg.params;
    this.received.push(call);
  }

  private callTool(id: string | number | null, params: unknown): JsonRpcResponse {
    const name = isObject(params) ? params.name : undefined;
    const args = isObject(params) ? params.arguments : undefined;
    const tool = this.tools.find((t) => t.name === name);
    if (!tool) {
      return fail(id, -32602, `unknown tool: ${String(name)}`);
    }
    const value = tool.handler ? tool.handler(args) : tool.result;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return ok(id, { content: [{ type: 'text', text }] });
  }
}

// ── stdio transport (SPEC §7.2) ──────────────────────────────────────────────

/**
 * Wire a {@link McpServerCore} to newline-delimited JSON-RPC over streams
 * (default `process.stdin`/`process.stdout`). Each input line is parsed as one
 * JSON object; parse failures are skipped. Responses are written as
 * `JSON.stringify(response) + '\n'`; notifications (a `null` from `handle`)
 * produce no output.
 */
export function runStdioServer(
  core: McpServerCore,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): void {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;

  const rl = createInterface({ input });
  rl.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg: unknown;
    try {
      msg = JSON.parse(s);
    } catch {
      return; // skip non-JSON lines
    }
    if (!isObject(msg) || typeof msg.method !== 'string') return;
    const response = core.handle(msg as unknown as JsonRpcRequest);
    if (response) output.write(`${JSON.stringify(response)}\n`);
  });
}
