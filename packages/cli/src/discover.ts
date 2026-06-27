import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TEST_RE = /\.agentry\.(ts|js|mts|mjs|cts|cjs)$/;
const SKIP = new Set(['node_modules', '__agentry__', 'dist']);

/** Recursively find `*.agentry.{ts,js,...}` test files under `dir`. */
export async function discoverTests(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (TEST_RE.test(e.name)) out.push(p);
    }
  }
  await walk(dir);
  return out.sort();
}
