/**
 * Driver contracts (SPEC §4). A driver controls one agent CLI and normalizes
 * its native surface into the common event model. The MVP exposes a one-shot
 * headless `run()` (prompt → RunRecord); multi-turn `AgentSession` is post-MVP.
 */
import type { RunRecord } from './run';

export interface DriverCapabilities {
  structuredStream: boolean;
  llmInterception: 'base-url' | 'provider-config' | 'http-proxy' | 'none';
  mcpTransports: Array<'stdio' | 'http' | 'sse'>;
  toolPermissionControl: boolean;
  nativeBudgetControl: boolean;
}

export interface RunOptions {
  /** The user/task prompt for this headless run. */
  prompt: string;
  /** Pinned model snapshot id. */
  model: string;
  /** Working directory (the sandbox). */
  cwd: string;
  /** MCP server config object (written/forwarded as the agent's mcp config). */
  mcpConfig?: unknown;
  /** Extra environment (e.g. ANTHROPIC_BASE_URL for the LLM proxy). */
  env?: Record<string, string>;
  /** CLI-native hard budget cap, in USD. */
  maxBudgetUSD?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  appendSystemPrompt?: string;
  /** Permission mode passed through to the agent (e.g. 'bypassPermissions'). */
  permissionMode?: string;
  /** Per-run wall-clock timeout (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentDriver {
  readonly id: string;
  capabilities(): DriverCapabilities;
  /** One-shot headless run: drive the agent to completion and return its record. */
  run(opts: RunOptions): Promise<RunRecord>;
}
