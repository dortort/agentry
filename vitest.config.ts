import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@agentry/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@agentry/claude': new URL('./packages/claude/src/index.ts', import.meta.url).pathname,
      '@agentry/codex': new URL('./packages/codex/src/index.ts', import.meta.url).pathname,
      '@agentry/gemini': new URL('./packages/gemini/src/index.ts', import.meta.url).pathname,
      '@agentry/antigravity': new URL('./packages/antigravity/src/index.ts', import.meta.url).pathname,
      '@agentry/mcp': new URL('./packages/mcp/src/index.ts', import.meta.url).pathname,
    },
  },
});
