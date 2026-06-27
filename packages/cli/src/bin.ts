#!/usr/bin/env node
import { cmdRun } from './commands/run';
import { cmdInit } from './commands/init';
import { cmdDoctor } from './commands/doctor';

const HELP = `agentry — Playwright for AI Agents

Usage:
  agentry init [dir]                       scaffold config + first test
  agentry test [--mode <m>] [--grep <s>]   run scenarios (default mode from config: replay)
  agentry record [--grep <s>]              run live and capture transcripts for replay
  agentry doctor                           probe agent CLIs + driver capabilities

Options:
  --mode <replay|mcp-live|live|record|dry>
  --grep <substring>     filter scenarios by "suite name" match
  --config <path>        config file (default: ./agentry.config.ts)
  --dir <path>           test directory (default: config.testDir)
`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'test':
      return cmdRun(rest);
    case 'record':
      return cmdRun(rest, 'record');
    case 'init':
      return cmdInit(rest);
    case 'doctor':
      return cmdDoctor();
    case undefined:
    case '-h':
    case '--help':
      console.log(HELP);
      return 0;
    default:
      console.error(`agentry: unknown command '${cmd}'\n`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
