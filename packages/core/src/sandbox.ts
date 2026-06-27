/**
 * Directory sandbox (SPEC §13). Provides a fresh temp workspace per scenario,
 * file helpers, and a before/after snapshot diff that yields `fs` events.
 *
 * NOTE (honest scope): directory mode is *reproducibility* isolation, not a
 * security boundary — it does not confine network or block host access. True
 * confinement is the container/vm levels (post-MVP).
 */
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import type { FsPayload } from './events';

/** relative-path -> content sha256 */
export type FsSnapshot = Map<string, string>;

export interface SandboxOptions {
  /** base dir to create the temp workspace in (default: os tmpdir) */
  root?: string;
  prefix?: string;
}

const IGNORED = new Set(['.git', 'node_modules']);

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

async function walk(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (IGNORED.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(abs, base)));
    else if (e.isFile()) out.push(relative(base, abs));
  }
  return out;
}

export class Sandbox {
  private constructor(public readonly dir: string) {}

  static async create(opts: SandboxOptions = {}): Promise<Sandbox> {
    const base = opts.root ?? tmpdir();
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, opts.prefix ?? 'agentry-'));
    return new Sandbox(dir);
  }

  /** Absolute path for a workspace-relative path. */
  path(rel: string): string {
    return join(this.dir, rel);
  }

  async write(rel: string, content: string): Promise<void> {
    const p = this.path(rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }

  async read(rel: string): Promise<string> {
    return readFile(this.path(rel), 'utf8');
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await stat(this.path(rel));
      return true;
    } catch {
      return false;
    }
  }

  /** All file paths (workspace-relative), sorted, excluding ignored dirs. */
  async list(): Promise<string[]> {
    return (await walk(this.dir, this.dir)).sort();
  }

  /** Content-hash snapshot of every file, for before/after diffing. */
  async snapshot(): Promise<FsSnapshot> {
    const files = await this.list();
    const m: FsSnapshot = new Map();
    for (const rel of files) m.set(rel, sha256(await readFile(this.path(rel))));
    return m;
  }

  /** Diff two snapshots into create/modify/delete `fs` payloads (path-sorted). */
  diff(before: FsSnapshot, after: FsSnapshot): FsPayload[] {
    const out: FsPayload[] = [];
    for (const [p, h] of after) {
      if (!before.has(p)) out.push({ type: 'fs', op: 'create', path: p });
      else if (before.get(p) !== h) out.push({ type: 'fs', op: 'modify', path: p });
    }
    for (const p of before.keys()) {
      if (!after.has(p)) out.push({ type: 'fs', op: 'delete', path: p });
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async cleanup(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
