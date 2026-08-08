import { defineConfig } from 'agentry-test';

export default defineConfig({
  testDir: './tests',
  mode: 'replay', // default; `agentry record` captures, `--mode live` hits the real agent
  use: { agent: 'claude', model: 'claude-haiku-4-5' },
  budget: { perTest: { usd: 0.25 } },
});
