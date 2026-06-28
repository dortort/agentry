/**
 * LLM interception proxy (SPEC §7). Sits at `ANTHROPIC_BASE_URL` between the
 * agent and the provider, emitting CH1 `llm_request`/`llm_response` events and
 * (in `record`) capturing byte-faithful wire cassettes for hermetic
 * `wire-replay`. Budget gate denies the next call once cost crosses the cap.
 *
 * Positionable (SPEC §7 positioning principle): the upstream is resolved via an
 * {@link Upstream} seam, so the same proxy forwards to a real provider, chains
 * to a real gateway, or (Phase 4) impersonates a provider pool — Agentry never
 * has to *replace* the component under test.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { type AgentEvent, type EventFactory } from './events';
import { parseAnthropicRequest } from './llm';
import { CassetteRecorder, type Cassette } from './cassette';

export type ProxyMode = 'record' | 'live' | 'wire-replay';

const ENDPOINT = 'llm://anthropic/messages';

/** Captured/served HTTP response for a single LLM exchange (byte-faithful body). */
export interface WireResponse {
  status: number;
  contentType?: string;
  body: string;
}

/** Resolves an inbound request to an upstream target. Single-upstream now; a
 *  provider-pool resolver drops in for Phase 4 gateway testing (SPEC §9.3). */
export interface Upstream {
  resolve(req: { method: string; path: string; body: unknown }): { baseUrl: string; provider?: string };
}

export class SingleUpstream implements Upstream {
  constructor(private readonly baseUrl: string) {}
  resolve(): { baseUrl: string } {
    return { baseUrl: this.baseUrl };
  }
}

export interface LlmProxyOptions {
  mode: ProxyMode;
  sessionId: string;
  factory: EventFactory;
  /** Upstream resolver (positioning seam). */
  upstream: Upstream;
  /** Required for `wire-replay`. */
  cassette?: Cassette;
  /** Budget gate: deny the next request once `costSoFar() >= capUSD`. */
  budget?: { capUSD?: number; costSoFar: () => number };
  /** Applied to captured response bodies before persistence (secret redaction). */
  redact?: (text: string) => string;
}

export interface StartedProxy {
  url: string;
  port: number;
  /** Live event buffer, appended as requests flow (CH1 + budget errors). */
  readonly events: AgentEvent[];
  /** Recorded wire cassette (record mode). */
  cassette(): Cassette;
  /** Count of real upstream calls made (0 in wire-replay — asserted in tests). */
  readonly upstreamCalls: { count: number };
  stop(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(
  baseUrl: string,
  path: string,
  method: string,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, baseUrl);
    const lib = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const h: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (v == null) continue;
      if (k.toLowerCase() === 'host' || k.toLowerCase() === 'content-length') continue;
      h[k] = v;
    }
    h.host = u.host;
    h['content-length'] = String(Buffer.byteLength(body));
    h['accept-encoding'] = 'identity'; // capture/serve uncompressed bytes (no gzip to relabel)
    const req = lib(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: h,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 502,
            contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : undefined,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function send(res: import('node:http').ServerResponse, r: WireResponse): void {
  res.writeHead(r.status, { 'content-type': r.contentType ?? 'application/json' });
  res.end(r.body);
}

/** Start an LLM proxy. The agent is pointed at the returned `url` via ANTHROPIC_BASE_URL. */
export async function startLlmProxy(opts: LlmProxyOptions): Promise<StartedProxy> {
  const events: AgentEvent[] = [];
  const upstreamCalls = { count: 0 };
  const recorder = new CassetteRecorder(opts.sessionId);
  let callIndex = 0;

  const emit = (payload: Parameters<EventFactory['make']>[0], turnId: string) =>
    events.push(opts.factory.make(payload, { turnId, source: 'llm-proxy', capability: 'llm', transport: 'http' }));

  const server: Server = createServer((req, res) => {
    void (async () => {
      // Connectivity probes (Phase 0: claude sends HEAD /) — answer so it proceeds.
      if (req.method !== 'POST' || !(req.url ?? '').includes('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }

      const raw = await readBody(req);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        body = {};
      }
      const idx = callIndex++;
      const turnId = `llm:${idx}`;
      emit({ type: 'llm_request', ...parseAnthropicRequest(body) }, turnId);

      // Budget gate (SPEC §13 layer 2): deny before spending.
      if (opts.budget?.capUSD != null && opts.budget.costSoFar() >= opts.budget.capUSD) {
        emit({ type: 'error', kind: 'budget', detail: { capUSD: opts.budget.capUSD, costSoFar: opts.budget.costSoFar() } }, turnId);
        send(res, {
          status: 429,
          body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'agentry: budget cap reached' } }),
        });
        return;
      }

      if (opts.mode === 'wire-replay') {
        // Positional VCR: the i-th call is served the i-th recorded response. Real
        // agent requests carry dynamic system content (date, cwd, env), so a
        // content-hash gate would miss on legitimate re-runs (SPEC §7.4.1). The
        // canonical key is kept on each entry for integrity/debugging, not gating.
        const entry = opts.cassette?.entries[idx];
        if (entry) {
          emit({ type: 'llm_response', model: parseAnthropicRequest(body).model }, turnId);
          send(res, entry.response as WireResponse);
        } else {
          send(res, {
            status: 502,
            body: JSON.stringify({ type: 'error', error: { type: 'agentry_no_recording', message: `no wire-cassette entry for call #${idx}` } }),
          });
        }
        return;
      }

      // record | live → forward to the resolved upstream.
      const { baseUrl } = opts.upstream.resolve({ method: req.method, path: req.url ?? '', body });
      upstreamCalls.count++;
      let response: WireResponse;
      try {
        response = await forward(baseUrl, req.url ?? '/v1/messages', 'POST', req.headers, raw);
      } catch (err) {
        emit({ type: 'error', kind: 'api', detail: String(err) }, turnId);
        send(res, { status: 502, body: JSON.stringify({ type: 'error', error: { type: 'agentry_upstream_error', message: String(err) } }) });
        return;
      }
      emit({ type: 'llm_response', model: parseAnthropicRequest(body).model }, turnId);

      if (opts.mode === 'record') {
        const persisted: WireResponse = {
          ...response,
          body: opts.redact ? opts.redact(response.body) : response.body,
        };
        recorder.record({ kind: 'llm', turnIndex: 0, callIndex: idx, endpoint: ENDPOINT, body, response: persisted });
      }
      send(res, response);
    })().catch((err) => {
      try {
        send(res, { status: 500, body: JSON.stringify({ error: String(err) }) });
      } catch {
        /* response already sent */
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    events,
    cassette: () => recorder.toJSON(),
    upstreamCalls,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
