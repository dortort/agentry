# Agentry — Specification

> **Playwright for AI Agents.** End-to-end testing for the things AI agents interact with —
> **skills, plugins, MCP gateways, and LLM gateways** — by driving real agent CLIs
> (Claude, Codex, Gemini, Antigravity, and Cursor) through scripted scenarios and asserting on what they *do*.

**Status:** Draft v2 (post-review) · **Owner:** dortort · **Last updated:** 2026-06-27

This revision incorporates two independent pre-implementation reviews (Claude critic + Codex
second-opinion); their full text lives in `docs/research/` (local-only).

Companion docs:
- [`ROADMAP.md`](./ROADMAP.md) — scope, phased delivery, Phase 0 spikes, open questions.
- `docs/research/` — *local-only* research + review notes (gitignored; reference for implementers).

> **Target terminology (used consistently below):** there are **four target *types*** —
> **skills, plugins, MCP gateways, LLM gateways** — all committed for v1. "Skills & plugins" are
> built as **one workstream** because they share an observation strategy (§9.2–9.3), which is why
> the roadmap sometimes says "three workstreams." Four types, three workstreams.

---

## 1. Vision & Positioning

### 1.1 What Agentry is

Playwright drives a real browser to test web apps. **Agentry drives a real AI agent to test the
agent's surrounding ecosystem.** You write code-first TypeScript tests that:

1. Launch a real agent CLI (Claude Code first) in a sandbox with a given prompt/scenario.
2. Observe everything it does through a normalized, causal event stream — assistant turns, tool
   calls, MCP requests/responses, LLM gateway traffic, token usage, timing, filesystem side-effects.
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

### 1.4 Guiding principle & intentional divergences

**Follow the Playwright model as closely as possible; diverge only where LLM non-determinism
forces it.** Every subsystem names its Playwright equivalent first, then justifies any divergence.
The **three** intentional divergences are:

1. **Semantic assertions** (§8) — content meaning can't be exact-matched.
2. **Record/replay as the default run mode** (§5, §7) — Playwright treats HAR as niche; for us it's
   the default determinism/cost strategy.
3. **Ordered, session-scoped cassette matching** (§7.3) — Playwright's HAR matches statelessly on
   `URL+method+body`; non-deterministic, history-accumulating LLM calls force a *positional* match
   key instead.

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
| **Event** | A normalized, causal record in the stream (§6). |
| **Cassette** | A recorded, ordered set of LLM+MCP exchanges (the HAR analog) for deterministic replay. |
| **Target** | The thing under test: a skill, plugin, MCP gateway, or LLM gateway. |
| **Driver** | An adapter that controls one agent CLI and normalizes its surface to the event model. |
| **Trace** | The full debuggable artifact of a run (events + gateway traffic + tokens + timing). |

---

## 3. Architecture

### 3.1 The interception (proxy) architecture

Agentry sits **between the agent CLI and its dependencies**, the way Playwright sits between the
test and the browser (via CDP). This gives total visibility and control without modifying the agent.

```
                 ┌─────────────────────────── Agentry test process ───────────────────────────┐
                 │  Test Runner ── Fixtures ── Assertion Engine ── Reporter ── Trace Writer     │
                 └───────────────┬───────────────────────────────────────────────┬─────────────┘
                                 │ drives (spawn, prompt, await idle)              │ reads events
                                 ▼                                                 ▼
   ┌──────────────┐   stdio /   ┌──────────────────┐   normalizes   ┌──────────────────────────┐
   │  Agent CLI    │  stream-json│  Agent Driver     │───────────────▶│ Causal Event Stream (§6)  │
   │ (claude -p …) │◀───────────▶│ (Claude adapter)  │                └──────────────────────────┘
   └──────┬────────┘             └──────────────────┘
          │ LLM calls (base-URL override)             │ MCP calls (http/sse proxy OR stdio shim)
          ▼                                            ▼
   ┌────────────────────┐                      ┌────────────────────┐
   │ LLM Gateway Proxy   │  observe / mock /    │ MCP Interceptor     │  observe / mock /
   │  (record / replay)  │  fault / passthrough │  (proxy + stdio shim)│  fault / replay / live
   └─────────┬──────────┘                      └─────────┬──────────┘
             ▼ (live mode only)                          ▼ (mcp:live mode)
     Real LLM provider API                        Real MCP server(s)
```

### 3.2 Components (the "spine")

| Component | Responsibility | Playwright analog |
|---|---|---|
| **Test Runner** | Discover/schedule scenarios, projects, workers, retries, sharding. | `@playwright/test` runner |
| **Agent Driver** | Spawn/prompt/await an agent CLI; normalize its surface to events. | Browser + CDP connection |
| **Event Model** | Canonical, agent-agnostic causal event graph (§6). | DOM / accessibility tree |
| **Interception Layer** | Proxy LLM + MCP traffic: observe, mock, fault-inject, record/replay. | `page.route` / `routeFromHAR` |
| **Assertion Engine** | Two-tier matchers over the event stream; auto-retry, soft, snapshots. | `expect` + web-first assertions |
| **Sandbox** | Isolated workspace, HOME remap, network policy, secret redaction, cleanup. | `BrowserContext` isolation |
| **Cost/Budget Guard** | Layered token & dollar caps (preflight + proxy gate + CLI-native). | (Agentry-specific) |
| **Trace Writer + Reporter** | Emit trace bundles + reports (console/JUnit/JSON/HTML). | Tracing + reporters |

**The spine is mostly target-agnostic — with one honest caveat.** The runner, config, sandbox,
reporters, and trace system are fully shared. But **each target needs its own *observation
mechanism*** (transport interception for MCP/LLM; on-the-wire + differential observation for
skills/plugins — §9). That observation work, not the matchers, is the real per-target cost. The
roadmap (Phase 0) validates each before committing.

---

## 4. Agent Drivers

### 4.1 The `AgentDriver` / `AgentSession` interface (pluggable)

```ts
interface AgentDriver {
  readonly id: 'claude' | 'codex' | 'gemini' | 'antigravity' | 'cursor' | string;
  capabilities(): DriverCapabilities;
  launch(opts: LaunchOptions): Promise<AgentSession>;
}

interface DriverCapabilities {
  structuredStream: boolean;       // machine-readable event stream (e.g. stream-json)
  llmInterception: 'base-url' | 'provider-config' | 'http-proxy' | 'none';
  mcpTransports: Array<'stdio' | 'http' | 'sse'>;
  toolPermissionControl: boolean;  // can we allow/deny tools non-interactively?
  configIsolation: 'env' | 'home' | 'cli-flag' | 'config-home'; // how to sandbox its config
  sessionPersistence: 'optional' | 'forced' | 'none';
  nativeBudgetControl: boolean;    // e.g. claude --max-budget-usd
  skillPluginSignals: Array<'context-injection' | 'tool-registration' | 'native-event' | 'hook'>;
  unsupported: string[];           // known gaps, for capability gating
}

interface AgentSession {
  // control
  prompt(input: string | Message): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  // observation
  events(): AsyncIterable<EventEnvelope>;     // §6
  waitForIdle(opts?: { timeout?: number }): Promise<RunResult>;
  waitForToolCall(name: string | RegExp, predicate?: (e: ToolCallEvent) => boolean): Promise<ToolCallEvent>;
  waitForLLMRequest(predicate?: (e: LlmRequestEvent) => boolean): Promise<LlmRequestEvent>;
  // accessors (read the materialized stream)
  readonly messages: MessageEvent[];
  readonly toolCalls: ToolCallEvent[];
  readonly lastMessage: string;               // assistant's final text
  readonly output: string;                    // canonical final result text/JSON
  readonly systemPrompt: string;              // assembled system prompt seen on the wire
  readonly availableTools: string[];          // tools declared to the model
  readonly askedForClarification: boolean;
  readonly usage: UsageMeter;
  readonly workspace: Sandbox;
  readonly trace: TraceHandle;
}

interface RunResult { exitCode: number | null; reason: 'completed'|'refusal'|'timeout'|'crash'|'budget'|'loop'; usage: Usage; }
```

Each driver's only hard job: **translate its CLI's native surface into the common event model.**
Everything above the driver is agent-agnostic. The interface preserves raw native events (§6) so
nothing is lost in normalization.

### 4.2 Claude driver (MVP, reference implementation)

Reference invocation:

```
claude -p "<prompt>" \
  --output-format stream-json --verbose \      # --verbose is REQUIRED for stream-json to emit full events
  --model <pinned-snapshot> \
  --strict-mcp-config --mcp-config <generated> \   # only Agentry's MCP config; ignore host config
  --no-session-persistence \                   # hermetic: no cross-run session state
  --max-budget-usd <cap>                        # CLI-native budget backstop (see §13)
```

- **No TTY required.** Headless print mode streams structured JSON to stdout — resolving the TTY
  risk for the primary path.
- **Idle/exit is free.** `-p` emits a terminal `result` event and the process exits; no
  stdout-quiescence heuristics.
- **Structured tool/MCP/usage events** come straight from `stream-json`.
- **LLM interception** via base-URL override (`ANTHROPIC_BASE_URL`) → Agentry's LLM proxy.
- **MCP interception** via §7.2 (http/sse proxy or stdio shim), wired through the generated
  `--mcp-config`.
- **Skill/plugin observation** via the channels in §6.1 / §9.

### 4.3 Per-agent capability & interception matrix

Claude, Codex, Gemini, and Antigravity are shipped; the cells below reflect each driver's actual
`capabilities()` and invocation. Cursor is not yet built (ROADMAP spike 0.13).

| Capability | Claude | Codex | Gemini | Antigravity | Cursor |
|---|---|---|---|---|---|
| Machine-readable stream | `stream-json` ✓ | `codex exec --json` ✓ | `--output-format stream-json` ✓ | `agy -o stream-json` ✓ (`event`-discriminated) | `cursor-agent` ⚠️ unverified |
| `llmInterception` | `base-url` (`ANTHROPIC_BASE_URL`) | `provider-config` (`model_providers.<id>.base_url`; **not** wired to Agentry's Anthropic proxy) | `none` (base-URL unproven) | `none` (routed through Antigravity's backend) | unverified |
| `mcpTransports` | stdio + http/sse | stdio | stdio + http/sse | none (unverified) | unverified |
| Config isolation / hermeticity | `--strict-mcp-config`, `--no-session-persistence` | `--ephemeral`, `--skip-git-repo-check` | `--skip-trust` | `--add-dir` (agent still writes to its own scratch dir) | unverified |
| `toolPermissionControl` | ✓ (`--permission-mode`) | ✓ (`--sandbox` / `--dangerously-bypass-approvals-and-sandbox`) | ✓ (`--approval-mode`, `--allowed-tools`) | ✓ (`--dangerously-skip-permissions`) | unverified |
| `nativeBudgetControl` | ✓ (`--max-budget-usd`) | ✗ | ✗ | ✗ | unverified |
| Known risk / caveat | low | no cost reported; no terminal event (`run.end` synthesized on exit) | assistant text streams as deltas (coalesced); auth-tier changes across CLI versions | writes to a scratch dir → sandbox fs-diff best-effort; MCP unverified | **highest** (`cursor-agent --help` hung during probing) |

> These are **not interchangeable adapters.** Each driver's `capabilities()` drives capability
> gating (`test.skip(!caps.mcp)`). Claude is the reference; Codex, Gemini, and Antigravity are shipped
> and their rows reflect real, verified behavior. **Cursor** remains an unvalidated Phase 0 spike
> (ROADMAP 0.13). Only Claude wires the LLM proxy today, so **wire cassettes apply to Claude alone** —
> transcript record/replay works for every driver.

### 4.4 Codex, Gemini, and Antigravity drivers (shipped)

Each mirrors the Claude reference — a pure native-event → `AgentEvent` mapper, a pure `buildArgs`, and
a `Driver` class that spawns its CLI with stdin ignored (so the process never blocks on stdin). Event
schemas were captured live from the CLIs (codex-cli 0.147, gemini-cli 0.54, agy 1.1) and drive the
unit tests.

- **Codex** (`@agentry/codex`) — `codex exec --json -C <cwd> -m <model> --ephemeral --skip-git-repo-check`,
  plus `--dangerously-bypass-approvals-and-sandbox` (bypass) or `--sandbox workspace-write`. The stream is
  `type`-discriminated (`thread.started`, `item.started/completed{agent_message|command_execution|file_change}`,
  `turn.completed`); shell runs → tool `shell`, patches → `apply_patch`; usage from `turn.completed`. Codex
  emits no terminal event, so `run.end` is synthesized on exit, and it reports no per-run cost. Interception
  is `provider-config`, so the Anthropic LLM proxy is not wired (no wire cassettes).
- **Gemini** (`@agentry/gemini`) — `gemini -p --output-format stream-json -m <model> --skip-trust`
  (`--skip-trust` is required for headless untrusted workspaces), plus `--approval-mode yolo|default`.
  `type`-discriminated (`init`, `message`, `tool_use`, `tool_result`, `error`, `result`); assistant text
  arrives as `delta` chunks that are **coalesced into one message** per turn; usage + `run.end` from the
  terminal `result`. Base-URL interception is unproven → `none`.
- **Antigravity** (`@agentry/antigravity`) — `agy -p --output-format stream-json --model <name> --add-dir <cwd>`,
  plus `--dangerously-skip-permissions`. The stream is **`event`-discriminated** (`init`, `step_update`,
  `result`); `agent_response` text is coalesced per `step_index`, and usage + `run.end` come from the
  authoritative terminal `result`. agy writes to its own project/scratch dir by default, so sandbox fs-diff
  capture is best-effort; MCP support is unverified (`mcpTransports: []`).

`agentry doctor` probes all four CLIs and prints each driver's `capabilities()`.

### 4.5 Secondary PTY/TUI driver

For interactive UX tests, a `node-pty` + `@xterm/headless` driver drives the real TUI and parses
screen state. Inherits the harder problems (idle detection, ANSI noise); **opt-in, off the MVP
critical path**, used for PTY recording and terminal snapshots only.

---

## 5. Run Modes

Two independent channels — **LLM** and **MCP** — each `live | record | replay` (MCP adds `mock`).
Named presets compose them; pick per-scenario via tags or config.

| Preset | LLM channel | MCP channel | Use | Speed / Cost |
|---|---|---|---|---|
| **`replay`** (default) | replay | replay | client / **skill / plugin** / agent-behavior tests | <2s · $0 |
| **`mcp-live`** | replay | live | **MCP-server / gateway** tests (must exercise real server code paths) | medium · $0 LLM |
| **`record`** | record | record | authoring / re-baselining | slow · $$ |
| **`live`** | live | live | nightly drift / protocol-conformance | slow · $$ |
| **`dry`** | — (no launch) | — | lint test files & assertions | instant · $0 |

**Why split:** replaying MCP responses from a cassette does **not** exercise the MCP server's own
code — fine when the agent is the unit under test, wrong when the *server* is. `mcp-live` keeps LLM
calls deterministic/free while running the real server, with per-test **state-reset and lifecycle
hooks** (§7.2, §9.1).

Performance contract: **`replay` total < 2s**, of which **framework overhead < 1.5s** + cassette
serving. (Reconciles the earlier §5/§6 contradiction.)

---

## 6. The Normalized Event Model (causal graph)

A single agent-agnostic, append-only stream. Every event is wrapped in an envelope that records
**causality** and **preserves the raw native event** (never discarded — normalization is lossy, so
we keep the original for debugging and forward-compat).

```ts
interface EventEnvelope {
  eventId: string;
  parentId?: string;             // causal parent (e.g. the model turn that issued this tool call)
  turnId: string;                // groups events within one model turn
  source: 'agent' | 'llm-proxy' | 'mcp-proxy' | 'sandbox' | 'runner';
  transport?: 'stdio' | 'http' | 'sse' | 'pty';
  capability?: 'mcp' | 'skill' | 'plugin' | 'tool' | 'llm';
  agentNativeType?: string;      // the CLI's own event type, pre-normalization
  raw: unknown;                  // preserved native payload — never dropped
  redactionStatus: 'none' | 'redacted';
  ts: number;
  payload: AgentEventPayload;
}

type AgentEventPayload =
  | { type: 'run.start';    runId; agent; model; scenario }
  | { type: 'message';      role: 'assistant'|'user'|'system'; text }
  | { type: 'tool_use';     id; name; args }                 // NOTE: field is `args` everywhere
  | { type: 'tool_result';  id; name; result; isError }
  | { type: 'mcp_request';  server; method; params }
  | { type: 'mcp_response'; server; method; result; error }
  | { type: 'llm_request';  model; system; messages; tools; params }   // full assembled context
  | { type: 'llm_response'; model; finishReason; usage }
  | { type: 'skill';        name; phase: 'available'|'invoke'|'result'; args?; result?; confidence: 'observed'|'inferred' }
  | { type: 'plugin';       name; event: 'tool-registered'|'context-injected'|'hook-fired'; detail; confidence: 'observed'|'inferred' }
  | { type: 'fs';           op: 'create'|'modify'|'delete'; path }      // from sandbox diff
  | { type: 'usage';        inputTokens; outputTokens; cacheTokens; costUSD }
  | { type: 'error';        kind: 'refusal'|'timeout'|'crash'|'budget'|'loop'; detail }
  | { type: 'run.end';      runId; exitCode; result };
```

- **`fs` events** come from a **post-hoc sandbox diff** by default (snapshot before/after; robust,
  no watcher races); an optional live watcher (chokidar) is available for streaming traces.
- **`skill`/`plugin` events carry a `confidence` tag** (`observed` vs `inferred`) — see §6.1/§9.
- **Crash handling:** if the agent dies mid-run, the driver synthesizes a terminal
  `error`+`run.end` so the stream is always well-formed and the partial trace is captured.

### 6.1 Observation channels (how facts reach the stream)

| Ch | Source | Carries | Used by |
|---|---|---|---|
| **CH1** | LLM gateway (the wire) | full per-turn request: `system`, `tools[]`, `messages[]` (incl. injected skill bodies & hook reminders), params | **skills, plugins**, LLM gateways |
| **CH2** | stream-json | assistant turns, `tool_use`/`tool_result`, native skill/hook events | all |
| **CH3** | MCP interceptor | tool discovery + JSON-RPC calls/results | MCP gateways, downstream behavior |
| **CH4** | sandbox FS diff | files created/modified/deleted | side-effects |
| **CH5** | process | exit code, stderr, lifecycle | error classification |
| **CH6** | differential | with-vs-without comparison of CH1–CH5 | **skills, plugins** (behavioral contracts) |

> **Normalization rules** (the "freeze animations" analog): strip/normalize volatile fields
> (timestamps, request/message IDs, randomized ordering) before snapshotting/hashing; redact
> secrets *structurally before persistence* (§13) — but compute cassette match-hashes on the
> pre-redaction, canonicalized form (§7.3).

---

## 7. Interception & Record/Replay (the `page.route` analog)

A single interception layer fronts **both** the LLM gateway and the MCP servers, with the same
verbs as Playwright's `Route`.

**Positioning principle.** Agentry is a *positionable* proxy: it always impersonates the **next
hop's upstream**, and **whatever is under test is what points at Agentry**. Testing the agent /
skills / MCP → the agent's `ANTHROPIC_BASE_URL` points at Agentry (Agentry = the provider, real or
replayed). Testing an LLM gateway → the agent points at the *real* gateway and the **gateway's**
provider config points at Agentry (Agentry = the provider pool it routes among; §9.3). The proxy's
upstream is therefore **configurable** — forward to a real provider, chain to a real gateway, or
impersonate a multi-provider pool — so Agentry never has to *replace* the component it is testing.

### 7.1 Routing API

```ts
agentry.route(matcher, handler)   // suite-wide (cf. context.route)
session.route(matcher, handler)   // scoped to one run (cf. page.route)
```

`matcher` targets **logical** endpoints: `llm://anthropic/messages`, `mcp://<server>/<tool>`,
glob/RegExp/predicate — Playwright's matching model.

### 7.2 Transport handling (two MCP forms)

`.mcp.json → proxy` only works when the agent speaks MCP over **HTTP/SSE**. For **stdio** MCP
servers (a child process speaking JSON-RPC over pipes) we need a shim:

- **HTTP/SSE proxy** — the generated MCP config points the agent at an Agentry URL; we proxy to the
  real server (or a `MockMcpServer`).
- **stdio shim** — the generated config launches `agentry-mcp-shim <server-id>`; the shim spawns
  the **real** server command, relays JSON-RPC over stdio, and **records/observes** traffic while
  preserving `initialize`, `cancel`, progress, and notifications.

Both forms expose the same `Route` verbs and `mcp:live|replay|mock` semantics; `mcp-live` adds
**per-test server lifecycle** (start/stop, like Playwright's `webServer`) and **state-reset hooks**.

### 7.3 `Route` verbs

| Verb | Agentry meaning |
|---|---|
| `route.fulfill({ json \| path \| body, status, headers })` | **Stub** a canned LLM completion or MCP tool result. |
| `route.abort('timedout' \| 'connectionreset' \| …)` | **Fault-inject** transport failures (Playwright's error vocabulary). |
| `route.continue({ model, messages, params, headers })` | **Pass-through with mutation** — swap model, inject system prompt, redact, reroute. |
| `route.fallback()` | **Layered chain**: mock → cassette → live. |
| `route.fetch()` + `fulfill({ response })` | **Capture-then-mutate** — call real, then truncate/corrupt/drop before the agent sees it. |
| `route.delay(ms)` / `route.status(429,{retryAfter}) / 500` / `route.malformed()` | Latency, rate-limit, server-error, malformed-payload faults. |

### 7.4 Cassettes (the `routeFromHAR` analog) — ordered, session-scoped

```ts
session.routeFromCassette(path, { notFound: 'abort' | 'fallback', llm?: 'replay'|'live', mcp?: 'replay'|'live' })
```

Playwright matches HAR statelessly on `URL+method+body`. LLM calls are **history-accumulating and
non-deterministic**, so stateless body matching produces *false matches* (replaying the wrong
response into a plausible-looking run). Agentry instead uses an **ordered, positional** key.

#### 7.4.1 Canonicalization & match key (was the weakest section — now specified)

**Match key:**
```
sha256( sessionId · turnIndex · callIndex · endpoint · normalizedToolSchemaHash · normalizedMessagesHash )
```
- **Positional:** `turnIndex`/`callIndex` are the primary discriminators (i-th LLM call of the
  session), so identical-looking requests at different points still resolve correctly.
- **Volatile fields stripped before hashing:** provider request IDs; message/`tool_use`/`tool_call`
  IDs (remapped to ordinals); timestamps; `cache_control` breakpoints & cache usage; randomized key
  ordering; absolute sandbox paths (→ workspace-relative); model alias date suffix when pinned.
- **Stable fields hashed:** endpoint, normalized message contents, normalized tool-schema set
  (order-insensitive), sampling params.
- **Multi-turn indexing:** purely positional within the `sessionId`; the cassette is an ordered log,
  not a content-addressed bag.
- **Collision/ambiguity:** two entries with the same key ⇒ **hard error** ("ambiguous cassette
  entry"), never silent first-match.
- **`notFound: 'abort'`** (default) = **hermetic** (unrecorded call fails the test).
  **`'fallback'`** = once any call falls through, the **remainder of that session runs live**
  (because the trajectory may now diverge — no Frankenstein mixing within a session).
- **Fuzzy matching is NOT default.** It exists only as an authoring-time repair (`agentry record
  --repair`) to help re-bind a cassette after an intentional prompt edit; CI replay is always exact
  on the canonicalized key.

**Worked example:** a 3-turn run records `[t0c0 llm, t0c0 mcp(read_file), t1c0 llm, t2c0 llm]`.
Replay normalizes each outgoing request (strip IDs/timestamps, remap tool_use ids to ordinals,
relativize paths), recomputes the positional key, and serves the recorded response. Editing turn-2's
prompt changes `normalizedMessagesHash` at `t2c0` → `notFound` (abort fails the test; fallback goes
live from t2). `agentry record --repair` re-records from the first divergence.

### 7.5 Streaming (the `routeWebSocket` analog)

For SSE/streamed completions and stdio/WS MCP: a per-message handler API (mock = scripted stream;
intercept = tap the real stream and inject mid-stream faults/truncation/reordering).

### 7.6 `waitForToolCall` (the `waitForResponse` analog)

```ts
const call = session.waitForToolCall('search', e => /invoice/.test(e.args.query)); // arm
await session.prompt('Find the unpaid invoice');                                   // act
expect((await call).args.query).toContain('invoice');                              // await
```

In replay, the event stream is emitted with the same async ordering as live (responses are served
from the cassette but still flow through the stream), so `waitForToolCall` behaves identically in
replay and live — preserving the "replay = same behavior" invariant.

---

## 8. Assertion Model

### 8.1 Two tiers, five strategies

Structure is exact; content is semantic. Five strategies (steer users to 1–2):

| Tier | Strategy | Determinism | Example |
|---|---|---|---|
| **1** | **Tool-call assertions** (hero feature) | High | `expect(agent).toHaveToolCall('read_file', { path: '/a.ts' })` |
| **2** | **Side-effect assertions** | High | `expect(workspace).toHaveFile('src/u.ts', { containing: 'export' })` |
| **3** | **Structured-output assertions** | High (when applicable) | `expect(agent.output).toMatchSchema(Invoice)` |
| **4** | **Semantic (LLM-as-judge)** | Low; expensive | `expect(agent.lastMessage).toSatisfyRubric('confirms file created', { threshold: 0.8 })` |
| **5** | **Pattern/heuristic** | Brittle; use sparingly | `expect(agent.output).toContain('done')` |

**Allow/deny/required** lists tolerate different valid paths to the same outcome:

```ts
expect(agent).toUseToolsFrom(['read_file','search']);   // allow-list
expect(agent).not.toHaveToolCall('rm');                 // deny-list (safety)
expect(agent).toHaveCalledAll(['plan','write','test']); // required, order-insensitive
```

> **Naming:** assertions take the **`agent`** session (`expect(agent)`), and tool args are
> **`args`** everywhere (matching the Anthropic `tool_use` block). `expect(workspace)` /
> `expect(mcp)` take their respective fixtures (§10).

### 8.2 Web-first behavior (auto-retry over the event stream)

Structural matchers **auto-retry**, polling the growing stream until the event appears or timeout
fires. Materialized scalars use non-retrying value assertions. All support `.not`.

- `expect.poll(() => judge(agent.output, rubric)).toBeGreaterThanOrEqual(0.8)` — score-until-pass.
- `expect(async () => { … }).toPass({ timeout })` — bundle checks; **always set an explicit
  timeout** (unbounded default would burn money per probe).
- **Agent-tuned intervals** default to `[1000, 2000, 5000]`.

### 8.3 Soft assertions, profiles, custom matchers

- `expect.soft(...)` → accumulate *all* failures into a per-run **scorecard**; assert
  `test.info().errors` at the end.
- `expect.configure({ timeout, soft })` → eval **profiles**: `judgeExpect` (slow, soft) vs
  `strictExpect` (fast, hard — safety gates).
- All matchers are `expect.extend` customs returning `{ pass, message, name, expected, actual }`,
  honoring `this.isNot`/`this.timeout`. Rich `message` (judge rationale, schema diff, arg diff)
  makes failures debuggable.

### 8.4 Snapshots with semantic tolerance (the `toMatchAriaSnapshot` analog)

Snapshot the **structural execution trace** (tool-call tree / message skeleton) as YAML — stable
structure exact, volatile leaves regex/omitted (`/children: contain` tolerates incidental calls).
For free-text, store a rubric/embedding baseline; pass within a **semantic-distance threshold**.
Re-baseline via `--update-snapshots` (`missing`/`changed`/`all`).

### 8.5 LLM-as-judge protocol (the Agentry-specific differentiator — now specified)

- **Rubric:** a natural-language criterion, or a structured rubric of weighted points.
- **Judge call:** a *different/cheaper* model than the agent under test (avoids echo-chamber bias),
  returning structured `{ score: 0..1, rationale: string }`.
- **Voting & threshold (reconciled):** `votes: N` runs **N independent judge samples**; the
  **aggregate score = mean** of the N; the assertion **passes iff mean ≥ threshold**. (So config
  `{ votes: 3, threshold: 0.66 }` = 3 samples, pass if mean ≥ 0.66; a per-assertion `threshold:
  0.8` overrides.) Single continuous scale — no separate majority-vote semantics.
- **Determinism in replay:** judge requests/responses are themselves recorded into the cassette, so
  replay re-evaluates **for free and deterministically** (no judge calls in CI replay).
- **Cost:** N judge calls per assertion per live/record run; counts against the budget (§13). Docs
  label Tier-4 "expensive — use sparingly."

---

## 9. Per-Target Assertion Surfaces

Four target types ride the shared spine; each adds fixtures + a matcher pack. **MCP and LLM
gateways** are observed at the transport layer (CH1/CH3). **Skills and plugins** are observed by
their *effect on the wire* (CH1) and by **differential** comparison (CH6) — see §9.2.

### 9.1 MCP gateways/servers (transport-observed; richest, most concrete)
Tool discovery (`toExposeTools`), invocation (`toHaveToolCall`), response schema (`toMatchSchema`),
content, resources/prompts exposure, error codes (`toHaveError({ code: -32602 })`), connection
lifecycle, concurrency, protocol compliance (`toBeValidMcpProtocol`). Fixture: `MockMcpServer`
(programmable) **or** a real server via the proxy/shim with lifecycle + state-reset hooks (run under
`mcp-live`).

### 9.2 Skills & plugins (effect-observed — redefined objectives)

Skills and plugins are **not** asserted by "did the internal thing fire?" but by **observable
effect contracts**, because both fundamentally work by *mutating what the agent sends to the model*
(visible on CH1) and *changing its behavior* (provable by CH6 differential). Each matcher is tagged
`observed` or `inferred`.

**Observable signals**

| Signal | Channel | Confidence |
|---|---|---|
| Skill body / plugin context injected into the request | CH1 | observed |
| Plugin tools registered / skill made available | CH1 (`tools[]`) / CH3 | observed |
| Hook fired → injected `<system-reminder>` | CH1 (next request) | observed |
| Hook blocked/modified a tool call | CH2 (+CH1) | observed |
| Plugin's MCP servers reachable | CH3 | observed |
| Downstream tool/MCP calls a skill drives | CH2/CH3 | observed |
| Side-effects / artifacts | CH4 | observed |
| Explicit native invocation event + args | CH2 | observed *if CLI surfaces it* |
| Behavioral modification (the whole point) | CH6 differential | observed *as a delta* |
| "Caused this decision" / internal "loaded" state | — | inferred → use CH6 |

**Matcher pack (reframed):**
```ts
expect(agent).toInjectContext(/skill: seo-audit/);                 // CH1, observed
expect(agent).toRegisterTools(['notepad_write','notepad_read']);   // CH1/CH3, observed
expect(agent).toFireHook('PreToolUse', { injects: /system-reminder/ });  // CH1, observed
expect(agent).toBlockTool('rm', { byHook: true });                 // CH2, observed
expect(agent.afterSkill('seo-audit')).toHaveToolCall('edit');      // CH2, observed (downstream)
expect(agent).toHaveInvokedSkill('seo-audit');                     // CH2, observed-if-surfaced (else inferred)
await expect(agent).toChangeBehaviorVs(baseline, { in: 'toolCalls' }); // CH6, the hero technique
```

**The differential method (CH6) is the backbone:** run the scenario **with vs. without** the
skill/plugin (or with/without a specific hook) and assert the intended *delta* in CH1–CH5. It needs
zero internal observability and is fully agent-agnostic — the Playwright-philosophy fit ("test what
it did"). `agentry` provides a `baseline` fixture to capture the no-skill/no-plugin run.

### 9.3 LLM gateways (transport-observed)

**Topology — the gateway-under-test points its provider config at Agentry.** Agentry is a
*positionable* proxy (§7): it always impersonates the next hop's upstream, and *what is under test
is what points at Agentry*. So, unlike the agent/skill/MCP case (where the agent's
`ANTHROPIC_BASE_URL` points at Agentry), here the **agent points at the real gateway** and the
**gateway's provider/upstream config points at Agentry**, which impersonates the provider pool:

```
Agent → [Your Gateway = SUT] → provider base_url → [Agentry: provider-impersonation] → mock/real providers
```

> If Agentry simply replaced the base-URL and forwarded to Anthropic, it would *take the gateway's
> seat* and the gateway-under-test wouldn't be in the path — you cannot test a gateway you've
> bypassed. Positioning Agentry on the gateway's **upstream** side is what makes the gateway's
> *decisions* observable.

Agentry runs in **provider-impersonation mode**: it registers multiple logical provider endpoints,
observes which one the gateway calls, fault-injects (e.g. `429`) to force fallback, and serves
canned/recorded completions per provider. Matchers: routing (`toHaveRoutedTo('anthropic')`), fallback
(`toHaveFallenBackTo('openai')`), cache behavior, rate-limit handling, request/response
transformation, token-count accuracy, latency overhead, error-propagation fidelity — all keyed off
the per-provider traffic Agentry sees on the gateway's upstream side. (Chaining Agentry *in front* of
the gateway instead — agent → Agentry → gateway — covers the gateway's externally-observable contract
but not its internal routing, so the upstream position is the primary one for routing/fallback tests.)

---

## 10. Test Authoring API (code-first TypeScript)

```ts
import { test, expect } from 'agentry-test';

test.describe('filesystem MCP server', () => {
  test('reads a file via the MCP tool', async ({ agent, workspace, mcp }) => {
    await workspace.write('notes/todo.md', '- buy milk');

    const call = agent.waitForToolCall('read_file', e => e.args.path.endsWith('todo.md'));
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

    // Tier 4 — semantic (opt-in, recorded for free replay)
    await expect.soft(agent.lastMessage).toSatisfyRubric('mentions buying milk', { threshold: 0.7 });

    expect(await call).toBeDefined();
  });
});
```

**Fixtures** (DI by name): `agent` (running `AgentSession`), `workspace` (`Sandbox`), `mcp`
(`MockMcpServer` | proxied-server handle, exposing `toHaveReceived`/`toExposeTools`/lifecycle),
`gateway` (LLM interceptor handle), `judge` (LLM-as-judge client), `baseline` (no-skill/no-plugin
comparison run for CH6). Worker-scoped for expensive resources; test-scoped for isolation; auto
fixtures attach always-on token/cost + transcript capture.

**Multi-turn / branching / conditional:** `prompt → waitForIdle → assert → prompt`; `agent.fork()`
to branch a session at the current turn; `if (agent.askedForClarification) …`.

**Projects = the agent × model matrix** (the browsers analog); capability gates skip unsupported
combos.

---

## 11. Configuration (`agentry.config.ts`)

```ts
import { defineConfig } from 'agentry-test';

export default defineConfig({
  testDir: './tests',
  mode: 'replay',                                 // default; live/mcp-live selected per-scenario via tags
  fullyParallel: true,
  workers: process.env.CI ? '50%' : undefined,    // bounded by API rate limits (§13)
  retries: process.env.CI ? 2 : 0,                // flaky-LLM tolerance / pass@k signal
  timeout: 120_000,                               // per-scenario run timeout
  expect: {
    timeout: 10_000,
    judge: { model: 'claude-haiku-4-5', votes: 3, threshold: 0.66 },  // §8.5: 3 samples, mean ≥ 0.66
  },

  budget: { perTest: { usd: 0.25, tokens: 100_000 }, perRun: { usd: 5 } },   // layered caps (§13)
  sandbox: { isolation: 'directory', network: 'allowlist', homeRemap: true }, // directory = reproducibility, not security
  redact: { patterns: [/sk-[A-Za-z0-9]{20,}/], env: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] },

  use: { agent: 'claude', model: 'claude-opus-4-8', trace: 'retain-on-failure' },

  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    { name: 'claude-opus',   use: { agent: 'claude', model: 'claude-opus-4-8'   }, dependencies: ['setup'] },
    { name: 'claude-sonnet', use: { agent: 'claude', model: 'claude-sonnet-4-6' }, dependencies: ['setup'] },
    // committed v1 objective, spike-gated (§4.3):
    // { name: 'codex',  use: { agent: 'codex'  } },
    // { name: 'gemini', use: { agent: 'gemini' } },
    // { name: 'cursor', use: { agent: 'cursor' } },
  ],
  reporter: process.env.CI ? [['junit'], ['blob']] : [['list'], ['html']],
});
```

**Model pinning is enforced:** Agentry **errors at config-load** if a `model` lacks a dated
snapshot suffix (rejects `-latest`/aliases). It injects `temperature=0` / `seed` where the agent
exposes them. `redact.env` reads values at runtime (no unsafe `!` assertions); unset vars are
skipped.

---

## 12. CLI

| Command | Purpose |
|---|---|
| `agentry init` | Scaffold `agentry.config.ts` + a first test + `.mcp.json` stub. |
| `agentry test [--mode replay\|mcp-live\|live\|record\|dry] [--grep @tag] [--project x] [--shard i/n] [-u]` | Run scenarios. |
| `agentry record [test] [--repair]` | Run live and write/refresh cassettes + golden snapshots (`--repair` re-binds from first divergence). |
| `agentry show-trace <bundle>` | Open the trace viewer (CLI + client-side hosted viewer). |
| `agentry doctor` | Probe installed agent CLIs, print the §4.3 capability matrix for this machine. |
| `agentry codegen [scenario]` | *(deferred)* drive an agent and generate a test from the event stream. |

`forbidOnly`, `maxFailures`, and `globalTimeout` double as **CI guards and hard spend caps**.

---

## 13. Sandboxing, Security & Cost

**Isolation is honest about what it guarantees:**

| Level | Guarantees | Use |
|---|---|---|
| `directory` (default) | **Reproducibility isolation only** — temp workspace + copied fixtures + HOME remap. In plain subprocess mode it **cannot** reliably block `curl`, keychain, XDG caches, or host config. | local dev |
| `container` | True filesystem + **network** confinement (default-deny allowlist actually enforced). | CI |
| `vm` | Full OS isolation. | agents that modify system state |

- **Config & secret injection under HOME remap:** because `~/.claude` won't exist in a remapped
  HOME, Agentry **explicitly provisions** the agent's credentials/config into the sandbox (env +
  generated config), so the agent never reads host config *and* still functions in live/record.
- **Network:** `allowlist` is advisory in `directory` mode and **enforced** in `container`/`vm`.
  Docs state this plainly.
- **Secret redaction is structural and pre-persistence:** a **secret registry** (API keys, MCP
  creds, configured patterns) drives a redaction pipeline that scrubs JSON bodies, stderr, debug
  logs, sidecar files, and tool outputs. **Cassette match-hashes are computed in memory on the
  pre-redaction canonical form (§7.4); only placeholder-normalized payloads are persisted** — so
  redaction never breaks replay matching.
- **Budget enforcement is layered** (process-kill is a last resort, because token usage often
  arrives *after* a response and killing mid-write corrupts cassettes / orphans MCP children):
  1. **Preflight estimate** — refuse to start a turn projected to exceed the cap.
  2. **Proxy-side gate** — the LLM proxy **denies the next request** once the running tally crosses
     the cap (clean stop, cassette intact).
  3. **CLI-native control** — pass `--max-budget-usd` (Claude) where available.
  4. **Hard kill + cleanup** — only if the above fail; always force-kill children and destroy the
     workspace, even on crash/timeout. Breach fails the test with a `budget` error within ~5s.
- Every report shows tokens-in/out and estimated cost (including judge-call cost, §8.5).

---

## 14. Trace & Reporting

- **Trace bundle** (zip) per run: causal event graph + intercepted gateway traffic (full req/resp,
  model, params) + per-step tokens/cost/latency + before/after context & FS snapshots + preserved
  raw events. Modes mirror Playwright (`on-first-retry`, `retain-on-failure`) plus a `live`
  streaming mode. Viewer is **client-side/local** (traces contain prompts + keys).
- **Reporters:** `list`/`line` (local), `junit`/`json` (CI), `html` (self-contained, links each
  scenario to its trace; default `open: 'on-failure'`), `blob` + `merge-reports` to consolidate
  sharded agent×model matrix runs. Custom reporters aggregate **cost, latency, pass@k, judge
  scores**.

---

## 15. Recording (codegen analog)

| Mode | Captures | Best for |
|---|---|---|
| **Event-stream record** (primary) | Normalized stream → generated replay test with golden snapshots (semantic tolerance for free text) | Headless agents, CI, stable golden tests |
| **PTY/TUI interactive record** (deferred) | Keystrokes + terminal output of an interactive CLI | Human-in-the-loop sessions; higher fidelity, noisier |

"Pick assertion" (insert a matcher at a chosen tolerance on a captured event) and "record at cursor"
(append turns) mirror codegen's pick-locator / record-at-cursor.

---

## 16. Appendix: Playwright → Agentry mapping

| Playwright | Agentry |
|---|---|
| Browser via CDP | Agent CLI via headless `stream-json` (driver) |
| DOM / accessibility tree | Causal normalized event graph (§6) |
| `projects` (browsers) | Agent × model matrix |
| Setup project / `dependencies` | Provision sandbox / warm MCP / agent auth |
| Fixtures (`page`,`context`,`request`) | `agent`, `workspace`, `mcp`/`gateway`, `baseline` |
| Web-first auto-retrying assertions | Structural matchers polling the event stream |
| `expect.poll` / `toPass` | Score-until-pass judge loops / bundled checks |
| `expect.soft` / `configure` | Per-run scorecards / eval profiles |
| `toMatchAriaSnapshot` | Structural trace snapshot (regex/omit leaves) |
| `toHaveScreenshot` (pixels, opt-in) | Terminal/TUI snapshot via PTY driver (opt-in) |
| `page.route` / `Route` verbs | LLM+MCP interception (fulfill/abort/continue/fallback/fetch) |
| `routeFromHAR` (stateless URL+body) | Cassettes (**ordered, session-positional** matching) |
| HTTP proxy | LLM base-URL override + MCP **http/sse proxy or stdio shim** |
| `routeWebSocket` | SSE/stdio streaming interception |
| `waitForResponse` | `waitForToolCall` / `waitForLLMRequest` |
| Workers / retries / sharding | Parallel sandboxes / pass@k / matrix distribution |
| Trace viewer | Agent trace viewer (events + gateway + cost/latency) |
| codegen | Event-stream record → golden test |
| `forbidOnly`/`maxFailures`/`globalTimeout` | CI guards + hard spend caps |
| — (no analog) | Differential (with/without) testing for skills & plugins (CH6) |
| — (no analog) | Layered budget guard; structural secret redaction |
