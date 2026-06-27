/**
 * The materialized read-model of a single agent run (SPEC §4.1, §8).
 *
 * A driver produces a flat {@link AgentEvent} stream; `RunRecord` aggregates it
 * into the accessors that assertions operate on. The `RunView` interface is the
 * contract assertions accept, so both a `RunRecord` and a live `AgentSession`
 * can be passed to `expect(...)`.
 */
import {
  type AgentEvent,
  type MessageEvent,
  type ToolUseEvent,
  type McpRequestEvent,
  type FsPayload,
  type SkillEvent,
  type PluginEvent,
  type RunEndReason,
  type Usage,
  isEvent,
} from './events';

export interface RunResult {
  exitCode: number | null;
  reason: RunEndReason;
  usage: Usage;
}

/** Accessors shared by RunRecord and a live AgentSession; what matchers consume. */
export interface RunView {
  readonly events: AgentEvent[];
  readonly toolCalls: ToolUseEvent[];
  readonly messages: MessageEvent[];
  readonly assistantMessages: MessageEvent[];
  readonly lastMessage: string;
  readonly output: string;
  readonly usage: Usage;
  readonly turns: number;
  readonly mcpRequests: McpRequestEvent[];
  readonly skills: SkillEvent[];
  readonly plugins: PluginEvent[];
  findToolCalls(name: string | RegExp): ToolUseEvent[];
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUSD: 0 };

export class RunRecord implements RunView {
  constructor(
    public readonly events: AgentEvent[],
    public readonly result?: RunResult,
  ) {}

  get toolCalls(): ToolUseEvent[] {
    return this.events.filter((e): e is ToolUseEvent => isEvent(e, 'tool_use'));
  }

  get messages(): MessageEvent[] {
    return this.events.filter((e): e is MessageEvent => isEvent(e, 'message'));
  }

  get assistantMessages(): MessageEvent[] {
    return this.messages.filter((m) => m.payload.role === 'assistant');
  }

  get lastMessage(): string {
    const a = this.assistantMessages;
    return a.length ? a[a.length - 1]!.payload.text : '';
  }

  /** MVP: the run's canonical output is the final assistant text. */
  get output(): string {
    return this.lastMessage;
  }

  get mcpRequests(): McpRequestEvent[] {
    return this.events.filter((e): e is McpRequestEvent => isEvent(e, 'mcp_request'));
  }

  get skills(): SkillEvent[] {
    return this.events.filter((e): e is SkillEvent => isEvent(e, 'skill'));
  }

  get plugins(): PluginEvent[] {
    return this.events.filter((e): e is PluginEvent => isEvent(e, 'plugin'));
  }

  /** Number of model turns (assistant messages) — used by toFinishWithin. */
  get turns(): number {
    return this.assistantMessages.length;
  }

  /** Aggregate usage: prefer the run result, else sum `usage` events. */
  get usage(): Usage {
    if (this.result?.usage) return this.result.usage;
    const totals = { ...EMPTY_USAGE };
    for (const e of this.events) {
      if (isEvent(e, 'usage')) {
        totals.inputTokens += e.payload.inputTokens;
        totals.outputTokens += e.payload.outputTokens;
        totals.costUSD = (totals.costUSD ?? 0) + (e.payload.costUSD ?? 0);
      }
    }
    return totals;
  }

  findToolCalls(name: string | RegExp): ToolUseEvent[] {
    const match = (n: string) => (typeof name === 'string' ? n === name : name.test(n));
    return this.toolCalls.filter((e) => match(e.payload.name));
  }

  /** Filesystem side-effects observed in the sandbox. */
  fsChanges(): FsPayload[] {
    return this.events.filter((e) => isEvent(e, 'fs')).map((e) => e.payload as FsPayload);
  }
}

/** Something that can produce a RunView (e.g. the live `agent` fixture). */
export interface RunViewProvider {
  toRunView(): RunView;
}

/** Coerce a matcher's `received` (RunRecord | RunView | RunViewProvider) into a RunView. */
export function asRunView(received: unknown): RunView {
  if (received && typeof received === 'object') {
    if (typeof (received as RunViewProvider).toRunView === 'function') {
      return (received as RunViewProvider).toRunView();
    }
    if ('events' in received && 'toolCalls' in received) return received as RunView;
  }
  throw new TypeError('expected an Agentry RunRecord/RunView (got something else)');
}
