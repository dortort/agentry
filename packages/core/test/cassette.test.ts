import { describe, it, expect } from 'vitest';
import {
  canonicalizeRequest,
  matchKey,
  CassetteRecorder,
  CassettePlayer,
  serializeCassette,
  parseCassette,
  type Cassette,
} from '../src/cassette';

const SESSION = 'sess-1';
const ENDPOINT = 'llm://anthropic/messages';

let reqSeq = 0;

/** Anthropic `/v1/messages`-shaped body with a volatile `request_id`. */
function body(opts: { userText?: string; toolId?: string } = {}) {
  const userText = opts.userText ?? 'Read a.ts';
  const toolId = opts.toolId ?? 'toolu_aaa';
  return {
    request_id: `req_${reqSeq++}`, // volatile — must be stripped before hashing
    model: 'claude-opus-4-8-20260101',
    system: 'You are helpful.',
    max_tokens: 1024,
    temperature: 0,
    // intentionally out of name order to exercise tool sorting
    tools: [
      { name: 'write_file', description: 'w', input_schema: { type: 'object' } },
      { name: 'read_file', description: 'r', input_schema: { type: 'object' } },
    ],
    messages: [
      { role: 'user', content: userText },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: toolId, name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content: 'file contents' }],
      },
    ],
  };
}

/** Same logical body, but with `cache_control` breakpoints sprinkled in. */
function cachedBody(toolId = 'toolu_zzz') {
  const b = body({ toolId }) as Record<string, unknown>;
  b.system = [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }];
  (b.tools as Record<string, unknown>[])[1]!.cache_control = { type: 'ephemeral' };
  const asstContent = (b.messages as Array<{ content: Record<string, unknown>[] }>)[1]!.content;
  asstContent[1]!.cache_control = { type: 'ephemeral' };
  return b;
}

function keyFor(b: unknown, turnIndex = 0, callIndex = 0): string {
  const { toolSchemaHash, messagesHash } = canonicalizeRequest('llm', ENDPOINT, b);
  return matchKey({ sessionId: SESSION, turnIndex, callIndex, endpoint: ENDPOINT, toolSchemaHash, messagesHash });
}

describe('cassette record/replay', () => {
  it('records then replays the same position+body (volatile request_id ignored)', () => {
    const rec = new CassetteRecorder(SESSION);
    rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body(), response: { text: 'ok' } });
    const player = new CassettePlayer(rec.toJSON());

    // Fresh body() has a different random request_id but is otherwise identical.
    const hit = player.lookup({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body() });
    expect(hit).toEqual({ hit: true, response: { text: 'ok' } });
  });

  it('misses when a message\'s text changes (messagesHash differs)', () => {
    const rec = new CassetteRecorder(SESSION);
    rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body(), response: { text: 'ok' } });
    const player = new CassettePlayer(rec.toJSON());

    const edited = player.lookup({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body({ userText: 'Read b.ts' }) });
    expect(edited).toEqual({ hit: false });

    // Sanity: only the messagesHash moved.
    const a = canonicalizeRequest('llm', ENDPOINT, body());
    const b = canonicalizeRequest('llm', ENDPOINT, body({ userText: 'Read b.ts' }));
    expect(a.messagesHash).not.toBe(b.messagesHash);
    expect(a.toolSchemaHash).toBe(b.toolSchemaHash);
  });

  it('remaps tool ids: bodies differing ONLY in tool_use ids share a key and replay', () => {
    expect(keyFor(body({ toolId: 'toolu_aaa' }))).toBe(keyFor(body({ toolId: 'toolu_bbb' })));

    const rec = new CassetteRecorder(SESSION);
    rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body({ toolId: 'toolu_aaa' }), response: { text: 'remapped' } });
    const player = new CassettePlayer(rec.toJSON());

    const hit = player.lookup({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body({ toolId: 'toolu_bbb' }) });
    expect(hit).toEqual({ hit: true, response: { text: 'remapped' } });
  });

  it('throws on a duplicate positional key', () => {
    const rec = new CassetteRecorder(SESSION);
    rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body(), response: { text: 'first' } });
    expect(() =>
      rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body(), response: { text: 'second' } }),
    ).toThrow(/ambiguous cassette entry/);
  });

  it('serializes and parses round-trip; rejects unknown versions', () => {
    const rec = new CassetteRecorder(SESSION);
    rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body(), response: { text: 'a' } });
    rec.record({ kind: 'mcp', turnIndex: 0, callIndex: 1, endpoint: 'mcp://fs/read_file', body: { method: 'read_file', params: { path: 'a.ts' } }, response: { contents: 'x' } });
    const cassette = rec.toJSON();

    const round = parseCassette(serializeCassette(cassette));
    expect(round).toEqual(cassette);

    const bad: Cassette = { ...cassette, version: 2 };
    expect(() => parseCassette(JSON.stringify(bad))).toThrow(/version/);
  });

  it('ignores cache_control differences in the key', () => {
    expect(keyFor(body({ toolId: 'toolu_xxx' }))).toBe(keyFor(cachedBody('toolu_zzz')));

    const rec = new CassetteRecorder(SESSION);
    rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body(), response: { text: 'cached' } });
    const player = new CassettePlayer(rec.toJSON());

    const hit = player.lookup({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: cachedBody() });
    expect(hit).toEqual({ hit: true, response: { text: 'cached' } });
  });

  it('is positional: the same body at a different turn/call does not match', () => {
    const rec = new CassetteRecorder(SESSION);
    rec.record({ kind: 'llm', turnIndex: 0, callIndex: 0, endpoint: ENDPOINT, body: body(), response: { text: 'ok' } });
    const player = new CassettePlayer(rec.toJSON());

    expect(player.lookup({ kind: 'llm', turnIndex: 1, callIndex: 0, endpoint: ENDPOINT, body: body() })).toEqual({ hit: false });
    expect(player.lookup({ kind: 'llm', turnIndex: 0, callIndex: 1, endpoint: ENDPOINT, body: body() })).toEqual({ hit: false });
  });
});
