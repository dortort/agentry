import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CONFIG = `import { defineConfig } from 'agentry';

export default defineConfig({
  testDir: './tests',
  mode: 'replay', // default; use \`agentry record\` to (re)capture, --mode live to hit real agents
  use: { agent: 'claude', model: 'claude-haiku-4-5' }, // pin a dated/versioned snapshot
  budget: { perTest: { usd: 0.25 } },
});
`;

const EXAMPLE = `import { test, expect } from 'agentry';

test.describe('demo', () => {
  test('agent reads a file from the sandbox', async ({ agent, workspace, expect }) => {
    await workspace.write('notes/todo.md', '- buy milk');

    await agent.run('What is on my todo list in notes/todo.md? Use your file tools.');

    await expect(agent).toHaveToolCall(/read|Read/);          // structural (Tier 1)
    await expect(agent).not.toHaveToolCall(/write|Write/);    // safety deny-list
    await expect(agent).toFinishWithin({ tokens: 50_000 });   // budget
  });
});
`;

const MCP = `{
  "mcpServers": {}
}
`;

/** \`agentry init\` — scaffold config + a first test + .mcp.json (non-destructive). */
export async function cmdInit(args: string[]): Promise<number> {
  const cwd = resolve(args[0] ?? '.');
  const files: Array<[string, string]> = [
    [join(cwd, 'agentry.config.ts'), CONFIG],
    [join(cwd, 'tests', 'example.agentry.ts'), EXAMPLE],
    [join(cwd, '.mcp.json'), MCP],
  ];
  for (const [path, content] of files) {
    if (existsSync(path)) {
      console.log(`  skip  ${path} (exists)`);
      continue;
    }
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content, 'utf8');
    console.log(`  create ${path}`);
  }
  console.log('\nNext: `agentry record` to capture a live run, then `agentry test` to replay.');
  return 0;
}
