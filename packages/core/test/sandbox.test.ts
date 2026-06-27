import { describe, it, expect, afterEach } from 'vitest';
import { Sandbox } from '@agentry/core';

let boxes: Sandbox[] = [];
async function box() {
  const b = await Sandbox.create({ prefix: 'agentry-test-' });
  boxes.push(b);
  return b;
}
afterEach(async () => {
  await Promise.all(boxes.map((b) => b.cleanup()));
  boxes = [];
});

describe('Sandbox', () => {
  it('writes, reads, and reports existence within an isolated dir', async () => {
    const b = await box();
    await b.write('notes/todo.md', '- buy milk');
    expect(await b.exists('notes/todo.md')).toBe(true);
    expect(await b.read('notes/todo.md')).toBe('- buy milk');
    expect(await b.exists('missing.md')).toBe(false);
    expect(b.path('a').startsWith(b.dir)).toBe(true);
  });

  it('snapshot/diff detects create, modify, and delete', async () => {
    const b = await box();
    await b.write('a.txt', 'one');
    await b.write('keep.txt', 'same');
    const before = await b.snapshot();

    await b.write('a.txt', 'one-modified');
    await b.write('b.txt', 'new');
    await rmFile(b, 'keep.txt');
    const after = await b.snapshot();

    const diff = b.diff(before, after);
    expect(diff).toEqual([
      { type: 'fs', op: 'modify', path: 'a.txt' },
      { type: 'fs', op: 'create', path: 'b.txt' },
      { type: 'fs', op: 'delete', path: 'keep.txt' },
    ]);
  });

  it('two sandboxes are isolated from each other', async () => {
    const a = await box();
    const c = await box();
    await a.write('x.txt', 'A');
    await c.write('x.txt', 'C');
    expect(await a.read('x.txt')).toBe('A');
    expect(await c.read('x.txt')).toBe('C');
    expect(a.dir).not.toBe(c.dir);
  });
});

async function rmFile(b: Sandbox, rel: string) {
  const { rm } = await import('node:fs/promises');
  await rm(b.path(rel));
}
