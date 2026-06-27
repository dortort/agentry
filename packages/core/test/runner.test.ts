import { describe, it, expect as v, afterEach } from 'vitest';
import { mkdir, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  test as aTest,
  setCurrentFile,
  clearRegistry,
  getRegistry,
  runTests,
  transcriptPathFor,
  resolveConfig,
  recordTranscript,
  serializeTranscript,
  EventFactory,
  RunRecord,
  summarize,
  type AgentEvent,
  type RegisteredTest,
} from '@agentry/core';

let dir: string;
afterEach(async () => {
  clearRegistry();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function transcriptJson(files?: Record<string, string>): string {
  const f = new EventFactory('rec', () => 0);
  const events: AgentEvent[] = [
    f.make({ type: 'tool_use', id: '1', name: 'read_file', args: { path: 'notes/todo.md' } }, { turnId: 't', source: 'agent' }),
    f.make({ type: 'message', role: 'assistant', text: 'milk' }, { turnId: 't', source: 'agent' }),
  ];
  const rec = new RunRecord(events, { exitCode: 0, reason: 'completed', usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.001 } });
  return serializeTranscript(recordTranscript(rec, { prompt: 'p', model: 'claude-haiku-4-5', files }));
}

async function writeTranscriptFor(t: RegisteredTest, testDir: string, json: string) {
  const p = transcriptPathFor(t, testDir);
  await mkdir(join(p, '..'), { recursive: true });
  await writeFile(p, json, 'utf8');
}

describe('runner (replay mode)', () => {
  it('passes a scenario with tool-call + side-effect assertions, records cost', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentry-runner-'));
    setCurrentFile(join(dir, 'demo.agentry.ts'));
    aTest.describe('mcp', () => {
      aTest('reads todo', async ({ agent, workspace, expect }) => {
        await agent.run('What is on my todo list?');
        await expect(agent).toHaveToolCall('read_file', { path: 'notes/todo.md' });
        await expect(workspace).toHaveFile('out/report.md', { containing: 'refund' });
      });
    });
    const config = resolveConfig({ use: { model: 'claude-haiku-4-5' }, testDir: dir });
    await writeTranscriptFor(getRegistry()[0]!, dir, transcriptJson({ 'out/report.md': 'a refund was issued' }));

    const results = await runTests(getRegistry(), { mode: 'replay', config });
    v(results[0]!.status).toBe('passed');
    v(results[0]!.costUSD).toBeCloseTo(0.001);
    v(summarize(results)).toMatchObject({ passed: 1, failed: 0 });
  });

  it('fails when an assertion does not hold', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentry-runner-'));
    setCurrentFile(join(dir, 'demo.agentry.ts'));
    aTest('wrong tool', async ({ agent, expect }) => {
      await agent.run('p');
      await expect(agent).toHaveToolCall('write_file');
    });
    const config = resolveConfig({ use: { model: 'claude-haiku-4-5' }, testDir: dir });
    await writeTranscriptFor(getRegistry()[0]!, dir, transcriptJson());

    const results = await runTests(getRegistry(), { mode: 'replay', config });
    v(results[0]!.status).toBe('failed');
    v(results[0]!.error).toMatch(/write_file/);
  });

  it('fails with a clear message when no recording exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentry-runner-'));
    setCurrentFile(join(dir, 'demo.agentry.ts'));
    aTest('unrecorded', async ({ agent, expect }) => {
      await agent.run('p');
      await expect(agent).toHaveToolCall('read_file');
    });
    const config = resolveConfig({ use: { model: 'claude-haiku-4-5' }, testDir: dir });

    const results = await runTests(getRegistry(), { mode: 'replay', config });
    v(results[0]!.status).toBe('failed');
    v(results[0]!.error).toMatch(/no recording/);
  });

  it('skips in dry mode without executing the body', async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentry-runner-'));
    setCurrentFile(join(dir, 'demo.agentry.ts'));
    let ran = false;
    aTest('should not run', async ({ agent }) => {
      ran = true;
      await agent.run('p');
    });
    const config = resolveConfig({ use: { model: 'claude-haiku-4-5' }, testDir: dir });
    const results = await runTests(getRegistry(), { mode: 'dry', config });
    v(results[0]!.status).toBe('skipped');
    v(ran).toBe(false);
  });
});
