# Agentry — Specification

> **Playwright for AI Agents.** End-to-end testing for the things AI agents interact with —
> **skills, plugins, MCP gateways, and LLM gateways** — by driving real agent CLIs
> (Claude, Codex, Gemini, Cursor) through scripted scenarios and asserting on what they *do*.

**Status:** Draft for review · **Owner:** dortort · **Last updated:** 2026-06-27

Companion docs:
- [`ROADMAP.md`](./ROADMAP.md) — MVP scope, phased delivery, Phase 0 spikes, open questions.
- `docs/research/` — *local-only* Playwright research notes (gitignored; reference for implementers).

---

## 1. Vision & Positioning

### 1.1 What Agentry is

Playwright drives a real browser to test web apps. **Agentry drives a real AI agent to test the
agent's surrounding ecosystem.** You write code-first TypeScript tests that:

1. Launch a real agent CLI (Claude Code first) in a sandbox with a given prompt/scenario.
2. Observe everything it does through a normalized event stream — assistant turns, tool calls,
   MCP requests/responses, LLM gateway traffic, token usage, timing, filesystem side-effects.
3. Assert on that behavior with Playwright-style `expect()` matchers that auto-retry.
4. Run deterministically and for free in CI via record/replay cassettes; run live periodically.

### 1.2 The one-line positioning

> **promptfoo tests *prompts*. Agentry tests the *infrastructure agents interact with*** —
> skills, plugins, MCP servers, and gateways.

### 1.3 What Agentry is NOT (and what it borrows)

| Tool | Relationship |
|---|---|
| **Playwright** | The model we deliberately mirror: test runner, `expect()`, fixtures, projects, config-as-code, interception, HAR/cassettes, trace viewer, codegen. See [§16 mapping](#16-appendix-playwright--agentry-mapping). |
| **promptfoo** | Borrow the provider abstraction and assertion vocabulary. **Do not** copy the eval-grid (prompt × vars) model — Agentry tests *multi-turn stateful scenarios*, not single-prompt evals. |
| **deepeval / Braintrust / LangSmith** | Borrow structured trace capture and LLM-as-judge metrics *selectively*. **Do not** adopt tracing-as-product positioning — Agentry is testing-first; tracing is a means. |
| **MCP Inspector** | Borrow protocol-level visibility into MCP JSON-RPC traffic. |
| **Jest snapshots** | Snapshot **tool-call sequences / structural traces**, never raw LLM text. |

### 1.4 Guiding principle

**Follow the Playwright model as closely as possible; diverge only where LLM non-determinism
forces it.** Every subsystem below names its Playwright equivalent first, then justifies any
divergence. The two intentional divergences are **semantic assertions** (§8) and **record/replay
as the default run mode** (§7).

---

## 2. Core Concepts & Mental Model

### 2.1 The structured-vs-pixels thesis

Playwright's reliability comes from asserting on the **structured protocol** (DOM + accessibility
tree via CDP), never pixels. Pixels (`toHaveScreenshot`) are an explicit, opt-in exception.

Agentry applies the identical discipline. An agent exposes two surfaces:

- **Structured/headless surface** — `claude -p --output-format stream-json`, JSONL transcripts,
  and intercepted gateway traffic. This is our **CDP**: the reliable source of truth.
- **Interactive TUI surface** — the full-screen terminal app. This is our **pixels**: faithful to
  what a human sees, but flaky to assert on. Opt-in only, via the secondary PTY driver.

**Decision: structured/headless is the primary substrate for all assertions and recording.**
The PTY/TUI driver is a secondary layer for the few tests that genuinely need interactive UX.

### 2.2 The two load-bearing invariants

1. **Structure is asserted exactly; content is asserted semantically.** Which tool was called,
   what MCP request went out, how many tokens were spent — deterministic, exact matchers. The
   free-text *meaning* of a reply — fuzzy matchers (LLM-as-judge, schema, semantic-contains).
2. **Record/replay is the default run mode.** Intercepting the agent's LLM (and MCP) traffic is
   *how* a test becomes deterministic. Replay = fast, free, deterministic (default CI). Live =
   real agents, run periodically to catch model/provider drift.

### 2.3 Vocabulary

| Term | Meaning |
|---|---|
| **Scenario** (`test()`) | One agent task: a prompt (or multi-turn script) + expected behavior. |
| **Suite** (`describe()`) | A capability grouping (e.g. "file-edit skill", "MCP auth"). |
| **Run / Session** | One execution of an agent against a scenario, producing an event stream. |
| **Event** | A normalized record in the stream (message, tool_use, mcp_request, usage, …). |
| **Cassette** | A recorded set of LLM+MCP exchanges (the HAR analog) for deterministic replay. |
| **Target** | The thing under test: a skill, plugin, MCP gateway, or LLM gateway. |
| **Driver** | An adapter that controls one agent CLI and normalizes its surface to the event model. |
| **Trace** | The full debuggable artifact of a run (events + gateway traffic + tokens + timing). |

---

## 3. Architecture

### 3.1 The interception (proxy) architecture

Agentry sits **between the agent CLI and its dependencies**, the way Playwright sits between the
test and the browser (via CDP). This gives total visibility and control without modifying the
agent.

```
                 ┌─────────────────────────── Agentry test process ───────────────────────────┐
                 │  Test Runner ── Fixtures ── Assertion Engine ── Reporter ── Trace Writer     │
                 └───────────────┬───────────────────────────────────────────────┬─────────────┘
                                 │ drives (spawn, prompt, await idle)              │ reads events
                                 ▼                                                 ▼
   ┌──────────────┐   stdio /   ┌──────────────────┐   intercepts   ┌──────────────────────────┐
   │  Agent CLI    │  stream-json│  Agent Driver     │───────────────▶│   Normalized Event Stream │
   │ (claude -p …) │◀───────────▶│ (Claude adapter)  │                └──────────────────────────┘
   └──────┬────────┘             └──────────────────┘
          │ LLM calls (ANTHROPIC_BASE_URL)            │ MCP calls (.mcp.json → proxy)
          ▼                                            ▼
   ┌────────────────────┐                      ┌────────────────────┐
   │ LLM Gateway Proxy   │  observe / mock /    │ MCP Gateway Proxy   │  observe / mock /
   │  (record / replay)  │  fault / passthrough │  (record / replay)  │  fault / passthrough
   └─────────┬──────────┘                      └─────────┬──────────┘
             ▼ (live mode only)                          ▼ (live mode only)
     Real LLM provider API                        Real MCP server(s)
```

### 3.2 Components (the "spine")

| Component | Responsibility | Playwright analog |
|---|---|---|
| **Test Runner** | Discover/schedule scenarios, projects, workers, retries, sharding. | `@playwright/test` runner |
| **Agent Driver** | Spawn/prompt/await an agent CLI; normalize its surface to events. | Browser + CDP connection |
| **Event Model** | Canonical, agent-agnostic event schema (§6). | DOM / accessibility tree |
| **Interception Layer** | Proxy LLM + MCP traffic: observe, mock, fault-inject, record/replay. | `page.route` / `routeFromHAR` |
| **Assertion Engine** | Two-tier matchers over the event stream; auto-retry, soft, snapshots. | `expect` + web-first assertions |
| **Sandbox** | Isolated workspace, HOME remap, network allowlist, secret redaction, cleanup. | `BrowserContext` isolation |
| **Cost/Budget Guard** | Per-turn/test/suite token & dollar caps with hard circuit-breaker. | (Agentry-specific) |
| **Trace Writer + Reporter** | Emit trace bundles + reports (console/JUnit/JSON/HTML). | Tracing + reporters |

**The spine is target-agnostic.** Skills, plugins, MCP gateways, and LLM gateways are
*assertion surfaces and fixtures* layered on the same spine (§9), which is what makes "all three
targets in v1" feasible — see [`ROADMAP.md`](./ROADMAP.md).

---

## 4. Agent Drivers

### 4.1 The `AgentDriver` interface (pluggable)

```ts
interface AgentDriver {
  readonly id: string;                       // 'claude' | 'codex' | 'gemini' | 'cursor'
  capabilities(): DriverCapabilities;        // structured output? MCP? streaming? PTY?
  launch(opts: LaunchOptions): Promise<AgentSession>;
}

interface AgentSession {
  prompt(input: string | Message): Promise<void>;   // send a turn
  events(): AsyncIterable<AgentEvent>;              // normalized event stream (§6)
  waitForIdle(opts?: { timeout?: number }): Promise<RunResult>;
  waitForToolCall(name: string | RegExp, predicate?): Promise<ToolCallEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  readonly workspace: Sandbox;
  readonly usage: UsageMeter;
}
```

Each driver's only hard job: **translate its CLI's native surface into the common `AgentEvent`
model.** Everything above the driver is agent-agnostic.

### 4.2 Claude driver (MVP, reference implementation)

- **Headless invocation:** `claude -p "<prompt>" --output-format stream-json --verbose`
  (+ `--model`, `--mcp-config`, tool allow/deny flags, `--max-turns`).
- **No TTY required.** Headless print mode reads the prompt as an argument / stdin and streams
  structured JSON events to stdout — directly resolving the analyst's "Critical" TTY risk for the
  primary path.
- **Idle detection is free.** In `-p` mode the process emits a terminal `result` event and exits;
  no stdout-quiescence heuristics needed (unlike the interactive path).
- **Structured tool/MCP/usage events** come straight from `stream-json` — no text scraping.
- **LLM interception** via `ANTHROPIC_BASE_URL` pointed at Agentry's LLM proxy (cleaner than
  `HTTPS_PROXY`).
- **MCP interception** by generating an `.mcp.json` that points the agent at Agentry's MCP proxy,
  which fronts the real server(s) (or a `MockMcpServer`).

### 4.3 Secondary PTY/TUI driver

For tests that need the *interactive* experience (slash-command UX, interactive prompts), a driver
built on `node-pty` + `@xterm/headless` drives the real TUI and parses screen state. This path
inherits the harder problems (idle detection, ANSI noise) and is therefore **opt-in and not on the
MVP critical path**. Used for PTY-based recording and terminal snapshots only.

### 4.4 Codex, Gemini, Cursor adapters (v1 objective, fast-follow)

Implemented against the same interface after the Claude driver proves the event model:

- **Codex** — `codex exec` non-interactive + JSON output.
- **Gemini** — Gemini CLI non-interactive mode + structured output.
- **Cursor** — the headless `cursor-agent` CLI (print/stream mode).

Each adapter declares its `capabilities()`; scenarios gate on capability (`test.skip(!caps.mcp)`)
so a shared suite runs across agents wherever the surface exists. Structured-output parity varies
per agent — normalization in the driver is exactly where that variance is absorbed.

---

## 5. Run Modes

| Mode | LLM/MCP traffic | Speed | Cost | Determinism | Use |
|---|---|---|---|---|---|
| **`replay`** (default) | served from cassette | <2s | $0 | full | every PR / local dev |
| **`record`** | hit real services, write cassette | slow | $$ | n/a | authoring / re-baselining |
| **`live`** | hit real services, no cassette | slow | $$ | none | nightly drift detection |
| **`dry`** | none (validate structure only) | instant | $0 | n/a | lint test files & assertions |

`--mode` selects globally; tags (`@live`, `@replay`) + project config select per-scenario tiers.

---

## 6. The Normalized Event Model

A single agent-agnostic, append-only stream. Assertions and traces read only this.

```ts
type AgentEvent =
  | { type: 'run.start';    runId; agent; model; scenario; ts }
  | { type: 'message';      role: 'assistant'|'user'|'system'; text; ts }
  | { type: 'tool_use';     id; name; args; ts }              // agent invokes a tool/skill
  | { type: 'tool_result';  id; name; result; isError; ts }
  | { type: 'mcp_request';  server; method; params; ts }       // JSON-RPC to MCP
  | { type: 'mcp_response'; server; method; result; error; ts }
  | { type: 'llm_request';  model; messages; tools; params; ts }
  | { type: 'llm_response'; model; finishReason; usage; ts }
  | { type: 'skill';        name; phase: 'invoke'|'result'; args; result; ts }
  | { type: 'plugin';       name; event: 'load'|'hook'; detail; ts }
  | { type: 'fs';           op: 'create'|'modify'|'delete'; path; ts }   // sandbox diff
  | { type: 'usage';        inputTokens; outputTokens; cacheTokens; costUSD; ts }
  | { type: 'error';        kind: 'refusal'|'timeout'|'crash'|'budget'|'loop'; detail; ts }
  | { type: 'run.end';      runId; exitCode; result; ts };
```

**Normalization rules** (the "freeze animations" analog for stable snapshots): strip/normalize
volatile fields (timestamps, request IDs, randomized ordering) before snapshotting; redact secrets
on the way in (§13).

---

## 7. Interception & Record/Replay (the `page.route` analog)

A single interception layer fronts **both** the LLM gateway and the MCP gateway/servers, with
the same verbs as Playwright's `Route`.

### 7.1 Routing API

```ts
// suite-wide (cf. context.route)              // scoped to one run (cf. page.route)
agentry.route(matcher, handler)                session.route(matcher, handler)
```

`matcher` targets **logical** endpoints, not raw URLs: `llm://anthropic/messages`,
`mcp://<server>/<tool>`, glob/RegExp/predicate — exactly Playwright's matching model.

### 7.2 `Route` verbs

| Verb | Agentry meaning |
|---|---|
| `route.fulfill({ json \| path \| body, status, headers })` | **Stub** a canned LLM completion or MCP tool result — the core determinism primitive. |
| `route.abort('timedout' \| 'connectionreset' \| …)` | **Fault-inject** transport failures (reuse Playwright's error vocabulary). |
| `route.continue({ model, messages, params, headers })` | **Pass-through with mutation** — swap model, inject system prompt, redact secrets, reroute. |
| `route.fallback()` | **Layered chain**: mock → cassette → live. |
| `route.fetch()` + `fulfill({ response })` | **Capture-then-mutate** — call real, then truncate/corrupt/drop a tool-call before the agent sees it. |
| `route.delay(ms)` / `route.status(429,{retryAfter}) / 500` / `route.malformed()` | Latency, rate-limit, server-error, and malformed-payload faults. |

### 7.3 Cassettes (the HAR / `routeFromHAR` analog) — the determinism centerpiece

```ts
session.routeFromCassette(path, { notFound: 'abort' | 'fallback', update?: boolean, url? })
```

- **Match key** = hash over `{ target (model/tool) + canonicalized request body }`. Because LLM
  requests carry volatile fields, the cassette **canonicalizes** the request (ignore/normalize
  volatile fields; optional fuzzy prompt match) — a deliberate, documented extension beyond
  Playwright's exact `URL+method+postData` matching.
- **`notFound: 'abort'`** (default) = **hermetic**: an unrecorded call fails the test (guarantees
  the cassette is complete). **`'fallback'`** = **record-extend**: new calls hit live and append.
- **`update: true`** = re-record. Large tool outputs/completions stored as sidecar files
  (`updateContent: 'attach'` analog); record only what's needed to replay (`updateMode: 'minimal'`).
- **Workflow:** record once against real services → commit cassette → CI replays for free and
  deterministically. *This is the single most valuable Playwright→Agentry transfer.*

### 7.4 Streaming (the `routeWebSocket` analog)

For SSE/streamed completions and stdio/WS MCP: a per-message handler API (mock = fully scripted
stream; intercept = tap the real stream and inject mid-stream faults/truncation/reordering).

### 7.5 `waitForToolCall` (the `waitForResponse` analog) — the headline sync primitive

```ts
const call = session.waitForToolCall('search', r => /invoice/.test(r.params.query)); // arm
await session.prompt('Find the unpaid invoice');                                     // act
expect((await call).params.query).toContain('invoice');                              // await
```

Arm-before-act/await-after, resolving when a matching tool call or LLM turn appears deep inside an
autonomous run — exactly how `waitForResponse` pinpoints one network call in a complex flow.

---

## 8. Assertion Model

### 8.1 Two tiers, five strategies

Structure is exact; content is semantic. Concretely, five strategies (steer users to 1–2):

| Tier | Strategy | Determinism | Example |
|---|---|---|---|
| **1** | **Tool-call assertions** (hero feature) | High | `expect(run).toHaveToolCall('read_file', { path: '/a.ts' })` |
| **2** | **Side-effect assertions** | High | `expect(workspace).toHaveFile('src/u.ts', { containing: 'export' })` |
| **3** | **Structured-output assertions** | High (when applicable) | `expect(run.output).toMatchSchema(Invoice)` |
| **4** | **Semantic (LLM-as-judge)** | Low; expensive | `expect(run.lastMessage).toSatisfyRubric('confirms file created', { judge: 'claude-haiku-4-5', threshold: 0.8 })` |
| **5** | **Pattern/heuristic** | Brittle; use sparingly | `expect(run.output).toContain('done')` |

**Allow/deny/required** lists are more resilient than strict sequences (tolerate different valid
paths to the same outcome):

```ts
expect(run).toUseToolsFrom(['read_file','search']);   // allow-list
expect(run).not.toHaveToolCall('rm');                 // deny-list (safety)
expect(run).toHaveCalledAll(['plan','write','test']); // required, order-insensitive
```

### 8.2 Web-first behavior (auto-retry over the event stream)

Structural matchers **auto-retry**, polling the growing event stream until the event appears or the
timeout fires (the DOM-re-fetch analog). Already-materialized scalars use non-retrying value
assertions. All support `.not`.

- `expect.poll(() => judge(run.output, rubric)).toBeGreaterThanOrEqual(0.8)` — score-until-pass.
- `expect(async () => { … }).toPass({ timeout })` — bundle fuzzy+structural checks; **always set an
  explicit timeout** (Playwright's unbounded default would burn money per probe).
- **Agent-tuned intervals** default to `[1000, 2000, 5000]`, not Playwright's web `[100,250,500,1000]`.

### 8.3 Soft assertions, profiles, custom matchers

- `expect.soft(...)` → accumulate *all* rubric/structural failures into a per-run **scorecard**
  instead of aborting on the first; assert `test.info().errors` at the end.
- `expect.configure({ timeout, soft })` → eval **profiles**: `judgeExpect` (slow, soft) vs
  `strictExpect` (fast, hard — for safety gates).
- All Agentry matchers are `expect.extend` custom matchers returning `{ pass, message, name,
  expected, actual }`, honoring `this.isNot` and `this.timeout` so they compose with `configure`,
  `poll`, and `toPass`. Rich `message` output (judge rationale, schema diff, arg diff) is what
  makes failures debuggable.

### 8.4 Snapshots with semantic tolerance (the `toMatchAriaSnapshot` analog)

Snapshot the **structural execution trace** (tool-call tree / message skeleton) as YAML where
stable structure is exact and volatile leaves use regex or are omitted (`/children: contain` by
default tolerates incidental extra calls). For free-text, store a rubric/embedding baseline and pass
within a **semantic-distance threshold** (the `maxDiffPixelRatio`/`threshold` analog). Re-baseline
via an `--update-snapshots`-style workflow (`missing`/`changed`/`all`).

---

## 9. Per-Target Assertion Surfaces

All four targets ride the shared spine; each adds fixtures + matchers over the event stream.

### 9.1 MCP gateways/servers (richest, most concrete)
Tool discovery (`toExposeTools`), invocation (`toHaveToolCall`), response schema (`toMatchSchema`),
content, resources/prompts exposure, error codes (`toHaveError({ code: -32602 })`), connection
lifecycle, concurrency, protocol compliance (`toBeValidMcpProtocol`). Fixture: `MockMcpServer` with
programmable responses; or a real server fronted by the MCP proxy with state-reset hooks.

### 9.2 Skills
Invocation detection (`toHaveInvokedSkill`), argument matching, output content/structure,
side-effects (`workspace.toHaveFile`), timing bounds, error handling, and **downstream behavior**
(`run.afterSkill('x').toHaveToolCall('edit')`).

### 9.3 Plugins
Load verification (`toHaveLoadedPlugin`), hook execution (`toHaveHookExecution('pre-commit')`),
context injection (`run.systemPrompt.toContain(...)`), tool registration
(`agent.availableTools.toContain(...)`), and behavioral diff (same prompt with/without plugin).

### 9.4 LLM gateways
Routing (`toHaveRoutedTo('anthropic')`), fallback (`toHaveFallenBackTo('openai')`), cache behavior,
rate-limit handling, request/response transformation, token-count accuracy, latency overhead, error
propagation fidelity. Naturally enabled by the LLM interception layer the spine already needs.

---

## 10. Test Authoring API (code-first TypeScript)

```ts
import { test, expect } from 'agentry';

test.describe('filesystem MCP server', () => {
  test('reads a file via the MCP tool', async ({ agent, workspace, mcp }) => {
    await workspace.write('notes/todo.md', '- buy milk');

    const call = agent.waitForToolCall('read_file', r => r.params.path.endsWith('todo.md'));
    await agent.prompt('What is on my todo list in notes/todo.md?');
    await agent.waitForIdle();

    // Tier 1 — structural, exact, auto-retrying
    await expect(agent).toHaveToolCall('read_file', { path: 'notes/todo.md' });
    await expect(mcp).toHaveReceived({ method: 'tools/call', name: 'read_file' });
    await expect(agent).not.toHaveToolCall('write_file');          // safety deny-list

    // Tier 2 — side-effect
    await expect(workspace).not.toHaveChangedFiles();

    // Budget
    await expect(agent).toFinishWithin({ tokens: 20_000, turns: 4 });

    // Tier 4 — semantic (opt-in, cheap judge)
    await expect.soft(agent.lastMessage)
      .toSatisfyRubric('mentions buying milk', { judge: 'claude-haiku-4-5', threshold: 0.7 });

    expect(await call).toBeDefined();
  });
});
```

- **Fixtures** (DI by name, Playwright-style): `agent` (running session), `workspace` (sandbox),
  `mcp` (mock/proxied MCP server), `gateway` (LLM interceptor handle), `judge` (LLM-as-judge
  client). Worker-scoped for expensive resources (warm MCP container, model pool); test-scoped for
  isolation (fresh workspace + transcript per scenario). Auto fixtures attach always-on
  token/cost + transcript capture.
- **Multi-turn / branching / conditional flow**: drive `prompt → waitForIdle → assert → prompt`;
  fork a session at turn N; `if (agent.askedForClarification) …`.
- **Projects = the agent × model matrix** (the browsers analog): one project per
  `(agent, model)`; shared scenarios run across all. Capability gates skip unsupported combos.

---

## 11. Configuration (`agentry.config.ts`)

```ts
import { defineConfig } from 'agentry';

export default defineConfig({
  testDir: './tests',
  mode: process.env.CI ? 'replay' : 'replay',     // live runs are nightly, tag-gated
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,                // flaky-LLM tolerance / pass@k signal
  timeout: 120_000,                               // per-scenario run timeout
  expect: { timeout: 10_000, judge: { model: 'claude-haiku-4-5', votes: 3, threshold: 0.66 } },

  budget: { perTest: { usd: 0.25, tokens: 100_000 }, perRun: { usd: 5 } },   // hard caps
  sandbox: { isolation: 'directory', network: 'allowlist', homeRemap: true },
  redact: [/sk-[A-Za-z0-9]+/, process.env.ANTHROPIC_API_KEY!],

  use: { agent: 'claude', model: 'claude-opus-4-8', trace: 'retain-on-failure' },

  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },          // provision sandbox / warm MCP
    { name: 'claude-opus',  use: { agent: 'claude', model: 'claude-opus-4-8'  }, dependencies: ['setup'] },
    { name: 'claude-sonnet',use: { agent: 'claude', model: 'claude-sonnet-4-6'}, dependencies: ['setup'] },
    // fast-follow:
    // { name: 'codex',  use: { agent: 'codex'  } },
    // { name: 'gemini', use: { agent: 'gemini' } },
    // { name: 'cursor', use: { agent: 'cursor' } },
  ],
  reporter: process.env.CI ? [['junit'], ['blob']] : [['list'], ['html']],
});
```

**Model pinning is mandatory** — config must lock a dated snapshot, never a `-latest` alias, or
provider updates silently break the suite. Agentry injects `temperature=0` / `seed` where the agent
exposes them.

---

## 12. CLI

| Command | Purpose |
|---|---|
| `agentry init` | Scaffold `agentry.config.ts` + a first test + `.mcp.json` stub. |
| `agentry test [--mode replay\|live\|record\|dry] [--grep @tag] [--project x] [--shard i/n] [-u]` | Run scenarios. |
| `agentry record <test>` | Run live and write/refresh cassettes + golden snapshots. |
| `agentry show-trace <bundle>` | Open the trace viewer (CLI + client-side hosted viewer). |
| `agentry codegen [scenario]` | *(deferred)* drive an agent and generate a test from the event stream. |

`forbidOnly`, `maxFailures`, and `globalTimeout` double as **CI guards and hard spend caps**.

---

## 13. Sandboxing, Security & Cost

- **Isolation levels** (user choice): `directory` (temp dir + copied fixtures; dev default) →
  `container` (Docker; CI) → `vm` (only for system-level agent actions). The subtle bit: agent CLIs
  read `~/.claude/`, `CLAUDE.md`, `.claude/settings.json` from fixed paths — sandbox **remaps HOME**
  or uses overlay/containers so host config never leaks in and host FS is never touched.
- **Network**: default-deny allowlist (LLM API + test MCP servers only); blocks an agent that tries
  to `curl` production.
- **Secrets**: per-test env injection (agent never sees host secrets it shouldn't); an **active
  redaction layer** scrubs secrets from transcripts, traces, logs, and reports.
- **Cost guard** (launch requirement, not a feature): per-turn/test/run token + dollar caps with a
  **hard circuit-breaker** that kills the agent process within ~5s of breach and fails the test with
  a `budget` error. Conservative default (`$0.25`/test, `$5`/run). Every report shows tokens-in/out
  and estimated cost.
- **Cleanup guarantees**: teardown (force-kill + workspace destroy) runs even on crash/timeout.

---

## 14. Trace & Reporting

- **Trace bundle** (zip) per run: ordered event stream + intercepted gateway traffic (full
  req/resp, model, params) + per-step tokens/cost/latency + before/after context & FS snapshots.
  Modes mirror Playwright: `on-first-retry`, `retain-on-failure`, plus a `live` streaming mode for
  long runs. Viewer is **client-side / local** (traces contain prompts + keys) — `agentry
  show-trace` and a hosted drag-drop viewer.
- **Reporters**: `list`/`line` (local), `junit`/`json` (CI dashboards), `html` (self-contained,
  links each scenario to its trace; default `open: 'on-failure'`), `blob` + `merge-reports` to
  consolidate sharded agent×model matrix runs. Custom reporters aggregate **cost, latency, pass@k,
  judge scores** per scenario/step.

---

## 15. Recording (codegen analog)

Two modes (see roadmap for sequencing):

| Mode | Captures | Best for |
|---|---|---|
| **Event-stream record** (primary) | Normalized stream → generated replay test with golden snapshots (semantic tolerance for free text) | Headless agents, CI, stable golden tests |
| **PTY/TUI interactive record** | Keystrokes + terminal output of an interactive CLI | Human-in-the-loop sessions; higher fidelity, noisier |

"Pick assertion" (choose a captured event, insert a matcher at a chosen tolerance) and "record at
cursor" (append turns) mirror codegen's pick-locator and record-at-cursor.

---

## 16. Appendix: Playwright → Agentry mapping

| Playwright | Agentry |
|---|---|
| Browser via CDP | Agent CLI via headless `stream-json` (driver) |
| DOM / accessibility tree | Normalized event stream (§6) |
| `projects` (browsers) | Agent × model matrix |
| Setup project / `dependencies` | Provision sandbox / warm MCP / agent auth |
| Fixtures (`page`,`context`,`request`) | `agent`, `workspace`/`transcript`, `gateway` |
| Web-first auto-retrying assertions | Structural matchers polling the event stream |
| `expect.poll` / `toPass` | Score-until-pass judge loops / bundled fuzzy checks |
| `expect.soft` / `configure` | Per-run scorecards / eval profiles |
| `toMatchAriaSnapshot` | Structural trace snapshot (regex/omit leaves) |
| `toHaveScreenshot` (pixels, opt-in) | Terminal/TUI snapshot via PTY driver (opt-in) |
| `page.route` / `Route` verbs | LLM+MCP interception (fulfill/abort/continue/fallback/fetch) |
| `routeFromHAR` / `recordHar` | Cassettes (record/replay), hermetic vs record-extend |
| `routeWebSocket` | SSE/stdio streaming interception |
| `waitForResponse` | `waitForToolCall` / `waitForLLMResponse` |
| Workers / retries / sharding | Parallel sandboxes / pass@k / matrix distribution |
| Trace viewer | Agent trace viewer (events + gateway + cost/latency) |
| codegen | Event-stream record → golden test |
| `forbidOnly`/`maxFailures`/`globalTimeout` | CI guards + hard spend caps |
