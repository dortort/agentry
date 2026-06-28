import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import {
  startLlmProxy,
  SingleUpstream,
  EventFactory,
  isEvent,
  type StartedProxy,
  type Cassette,
  type WireResponse,
} from '@agentry/core';

// ── stub upstream + cleanup tracking ────────────────────────────────────────
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function stubUpstream(respBody: string): Promise<{ url: string; calls: { n: number } }> {
  const calls = { n: 0 };
  const srv = createServer((req, res) => {
    calls.n++;
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(respBody);
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
  return { url: `http://127.0.0.1:${port}`, calls };
}

async function proxy(opts: Parameters<typeof startLlmProxy>[0]): Promise<StartedProxy> {
  const p = await startLlmProxy(opts);
  cleanups.push(() => p.stop());
  return p;
}

const REQ = {
  model: 'claude-haiku-4-5',
  stream: true,
  system: 'You are helpful. SKILL: seo-audit loaded.',
  tools: [{ name: 'Read' }, { name: 'mcp__fs__search' }],
  messages: [{ role: 'user', content: 'hi' }],
};

function post(url: string, body: unknown) {
  return fetch(`${url}/v1/messages?beta=true`, { method: 'POST', body: JSON.stringify(body) });
}

describe('LlmProxy', () => {
  it('record: forwards byte-faithfully, captures a cassette entry, emits CH1 events', async () => {
    const up = await stubUpstream('event: x\ndata: hello\n\n');
    const p = await proxy({ mode: 'record', sessionId: 's', factory: new EventFactory('s', () => 0), upstream: new SingleUpstream(up.url) });

    const res = await post(p.url, REQ);
    expect(await res.text()).toBe('event: x\ndata: hello\n\n'); // byte-faithful
    expect(up.calls.n).toBe(1);

    const cass = p.cassette();
    expect(cass.entries).toHaveLength(1);

    const reqs = p.events.filter((e) => isEvent(e, 'llm_request'));
    expect(reqs).toHaveLength(1);
    expect(isEvent(reqs[0]!, 'llm_request') && reqs[0]!.payload.tools?.map((t) => t.name)).toEqual(['Read', 'mcp__fs__search']);
    expect(p.events.some((e) => isEvent(e, 'llm_response'))).toBe(true);
  });

  it('wire-replay: serves recorded bytes with ZERO upstream calls', async () => {
    const up = await stubUpstream('event: x\ndata: recorded\n\n');
    const rec = await proxy({ mode: 'record', sessionId: 's', factory: new EventFactory('s', () => 0), upstream: new SingleUpstream(up.url) });
    await post(rec.url, REQ);
    const cassette: Cassette = rec.cassette();

    const rp = await proxy({ mode: 'wire-replay', sessionId: 's', factory: new EventFactory('s', () => 0), upstream: new SingleUpstream('http://unused.invalid'), cassette });
    const res = await post(rp.url, REQ);
    expect(await res.text()).toBe('event: x\ndata: recorded\n\n');
    expect(rp.upstreamCalls.count).toBe(0);
  });

  it('wire-replay: a request with no recording returns 502', async () => {
    const rp = await proxy({ mode: 'wire-replay', sessionId: 's', factory: new EventFactory('s', () => 0), upstream: new SingleUpstream('http://unused.invalid'), cassette: { version: 1, sessionId: 's', entries: [] } });
    const res = await post(rp.url, { model: 'm', messages: [] });
    expect(res.status).toBe(502);
  });

  it('budget gate: denies the next request before any upstream call', async () => {
    const up = await stubUpstream('nope');
    const p = await proxy({
      mode: 'record',
      sessionId: 's',
      factory: new EventFactory('s', () => 0),
      upstream: new SingleUpstream(up.url),
      budget: { capUSD: 0.01, costSoFar: () => 0.02 },
    });
    const res = await post(p.url, REQ);
    expect(res.status).toBe(429);
    expect(up.calls.n).toBe(0);
    expect(p.events.some((e) => isEvent(e, 'error') && e.payload.kind === 'budget')).toBe(true);
  });

  it('record: redacts secrets in the captured body, key unaffected', async () => {
    const up = await stubUpstream('token=sk-ABC123XYZ done');
    const p = await proxy({
      mode: 'record',
      sessionId: 's',
      factory: new EventFactory('s', () => 0),
      upstream: new SingleUpstream(up.url),
      redact: (t) => t.replace(/sk-\w+/g, '<redacted>'),
    });
    await post(p.url, REQ);
    const entry = p.cassette().entries[0]!;
    const body = (entry.response as WireResponse).body;
    expect(body).toContain('<redacted>');
    expect(body).not.toContain('sk-ABC123XYZ');
  });

  it('answers non-POST connectivity probes with 200', async () => {
    const p = await proxy({ mode: 'live', sessionId: 's', factory: new EventFactory('s', () => 0), upstream: new SingleUpstream('http://unused.invalid') });
    const res = await fetch(`${p.url}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
  });
});
