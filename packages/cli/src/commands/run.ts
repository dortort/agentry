import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import {
  resolveConfig,
  clearRegistry,
  setCurrentFile,
  getRegistry,
  runTests,
  reportConsole,
  type RunMode,
  type AgentryConfig,
  type AgentDriver,
} from '@agentry/core';
import { ClaudeDriver } from '@agentry/claude';
import { CodexDriver } from '@agentry/codex';
import { discoverTests } from '../discover';

function selectDriver(agent: string | undefined): AgentDriver {
  switch (agent) {
    case 'codex':
      return new CodexDriver();
    case 'claude':
    default:
      return new ClaudeDriver();
  }
}

/** `agentry test` / `agentry record`. Returns a process exit code. */
export async function cmdRun(args: string[], forceMode?: RunMode): Promise<number> {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      grep: { type: 'string' },
      config: { type: 'string' },
      dir: { type: 'string' },
    },
  });

  const configPath = resolve(values.config ?? 'agentry.config.ts');
  let raw: AgentryConfig = {};
  if (existsSync(configPath)) {
    const mod = (await import(pathToFileURL(configPath).href)) as { default?: AgentryConfig };
    raw = mod.default ?? {};
  }
  const config = resolveConfig(raw);

  const mode: RunMode = forceMode ?? (values.mode as RunMode | undefined) ?? config.mode;
  const testDir = resolve(values.dir ?? config.testDir);

  const files = await discoverTests(testDir);
  if (files.length === 0) {
    console.error(`agentry: no *.agentry.ts tests found under ${testDir}`);
    return 1;
  }

  clearRegistry();
  for (const file of files) {
    setCurrentFile(file);
    await import(pathToFileURL(file).href);
  }
  setCurrentFile(undefined);

  let tests = getRegistry();
  if (values.grep) {
    const g = values.grep;
    tests = tests.filter((t) => [...t.suite, t.name].join(' ').includes(g));
  }

  console.log(`\nagentry — ${tests.length} scenario(s) · mode=${mode}\n`);
  const liveDriver = selectDriver(config.use.agent);
  const results = await runTests(tests, { mode, config, liveDriver });
  const summary = reportConsole(results);
  return summary.failed > 0 ? 1 : 0;
}
