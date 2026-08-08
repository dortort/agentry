# Agentry — Roadmap, Scope & Open Questions

Companion to [`SPEC.md`](./SPEC.md). Defines what ships when, the validation that must precede
architecture, and the decisions still open. **Revised v2** after two pre-implementation reviews.

---

## 1. Scope decisions (locked with owner, 2026-06-27)

| Axis | Decision |
|---|---|
| Language/runtime | TypeScript / Node |
| Agent driver | Pluggable `AgentDriver`, CLI subprocess automation first |
| Substrate | Structured/headless primary; PTY/TUI secondary |
| Assertion model | Two-tier: structural exact + semantic |
| Determinism | Record/replay cassettes (ordered, session-positional); **replay default**, live periodic |
| Authoring | Code-first TypeScript v1; declarative YAML deferred |
| **Target types in v1** | **All four — skills, plugins, MCP gateways, LLM gateways** (skills & plugins = one workstream → "three workstreams"). **Committed GA.** |
| **Agents** | **Claude, Codex, Gemini, and Antigravity** drivers shipped; **Cursor** remains a spike-gated fast-follow |
| North star | Follow Playwright; diverge only for LLM non-determinism (3 divergences — SPEC §1.4) |

---

## 2. The scope tension (resolved — held firm, with a redefinition)

Both the pre-planning analyst **and** both pre-implementation reviews (Claude critic + Codex)
recommended cutting v1 to a single target (MCP-only) and demoting the rest. **Owner held firm: all
four target types are committed GA.**

The reviews' strongest objection was that **skills/plugins might be unobservable** without modifying
the agent. That objection is **resolved by redefinition, not by hope:**

- Skills and plugins work by **mutating what the agent sends to the model** (visible on **CH1**, the
  LLM-gateway wire) and **changing its behavior** (provable by **CH6**, the with/without
  differential). See SPEC §6.1 and §9.2.
- So skill/plugin tests assert **observable-effect contracts** (context injection, tool
  registration, hook effects, downstream calls, side-effects, behavioral delta) — **not** internal
  "was it invoked" events. Matchers are tagged `observed` vs `inferred`.

This gives Phase 2 a concrete implementation path on the existing spine, **no agent modification
required.** The de-risking that makes "all four committed" defensible:

1. **Shared spine** — runner, config, sandbox, reporters, trace are built once. *Honest caveat:*
   each target still needs its own **observation mechanism**; that (not the matchers) is the real
   per-target cost, and Phase 0 validates each.
2. **Sequenced, not simultaneous** — targets land one at a time on a finished spine.
3. **Phase 0 gates the spend** — every risky assumption is a cheap spike *before* architecture.
4. **Assertion strategies capped** — Tiers 1–2 full, 3–4 thin, 5 + `custom()` escape hatch.

---

## 3. Phase 0 — Validation spikes (BLOCKING; ~2–3 days, before architecture)

Cheap experiments that de-risk weeks of work; each has a binary outcome. *No production code until
these are answered and written up in `docs/research/phase0-findings.md` (local).*

### Claude (reference path)
| # | Question | Why it matters |
|---|---|---|
| 0.1 | `claude -p --output-format stream-json --verbose` drives headlessly (no TTY); tool/MCP/usage events structured? | Confirms primary substrate |
| 0.2 | `ANTHROPIC_BASE_URL` honored for LLM proxy? | LLM interception viability |
| 0.3 | MCP transports (stdio / http+sse); does the **stdio shim** (SPEC §7.2) relay JSON-RPC + init/cancel/progress cleanly? | MCP interception architecture |
| 0.4 | Idle/exit cleanly detectable in `-p` (terminal `result` + exit)? | Avoid fragile idle heuristics |
| 0.5 | Sandbox + HOME-remap runs without leaking host `~/.claude`, **and** explicit credential injection works? | Isolation + auth-in-sandbox |

### Skills / plugins observability (the redefinition — validate the channels)
| # | Question | Why it matters |
|---|---|---|
| 0.6 | **CH1:** after a skill is triggered, does its body appear in the next LLM request? Do plugin tools appear in `tools[]`? Do hook `<system-reminder>`s appear in `messages[]`? | Confirms effect-observability (SPEC §9.2) |
| 0.7 | **CH2:** does stream-json surface native skill-invocation / hook events (→ `observed`), or must they be `inferred`? | Sets matcher confidence tags |
| 0.8 | **CH6:** is a with/without **differential** run stable enough to assert behavioral deltas? | Confirms the hero technique |

### Cassettes & replay fidelity
| # | Question | Why it matters |
|---|---|---|
| 0.9 | Record a 3-turn run; re-run; does the **ordered positional canonicalization** (SPEC §7.4.1) match with zero false-matches? Edit a turn → clean `notFound`? | Core determinism engine |
| 0.10 | Does `mcp-live` (llm-replay + mcp-live) exercise the **real MCP server's** code paths while keeping LLM deterministic? State-reset hooks work? | MCP-server test fidelity |

### Cross-agent feasibility (per SPEC §4.3 matrix — gate each adapter)
| # | Question | Why it matters |
|---|---|---|
| 0.11 | **Codex:** `codex exec --json`; LLM proxy via `model_providers.<id>.base_url` under `CODEX_HOME`; MCP support | Codex adapter feasibility — **✅ shipped** (`@agentry/codex`; stream verified against codex-cli 0.147; interception is `provider-config`, not wired to the Anthropic proxy) |
| 0.12 | **Gemini:** structured stream; base-URL interception (unproven); MCP config | Gemini adapter feasibility — **✅ shipped** (`@agentry/gemini`; `--output-format stream-json` verified against gemini-cli 0.54; assistant text coalesced from deltas; base-URL interception still unproven → `none`) |
| 0.13 | **Cursor (highest risk):** does `cursor-agent` run headless/structured at all (probing previously hung)? LLM/MCP interception? | Cursor adapter feasibility — may demote to fast-follow if it fails |
| 0.14 | **Antigravity (`agy`):** `agy -p --output-format stream-json`; `event`-discriminated stream; permissions via `--dangerously-skip-permissions` | Antigravity adapter feasibility — **✅ shipped** (`@agentry/antigravity`; usage + `run.end` from the terminal `result`; sandbox fs-diff best-effort since agy uses its own scratch dir) |

**Exit criteria:** yes/no + evidence per spike; architecture deltas folded into `SPEC.md`. A failed
cross-agent spike (esp. 0.13) demotes that agent to post-v1 without affecting the Claude GA path.

**Progress (2026-06-27, Claude reference path):** **0.1 ✅** (headless stream-json, no TTY) ·
**0.4 ✅** (clean `result`+exit; cost/usage/timing in terminal event) · **0.2 ✅** (`ANTHROPIC_BASE_URL`
honored; full request — system/tools/messages/params — capturable on the wire = CH1) · **0.6/0.7 🟡**
(plugins/skills/tools/MCP-status in the `init` event and hook firing in `hook_*` events are `observed`
via stream-json — **critic C2 substantially resolved**; skill-*body*-on-invocation still to confirm) ·
plus config isolation via `--strict-mcp-config` ✅ and the `--max-budget-usd` native budget flag ✅.
Full evidence in `docs/research/phase0-findings.md`. No findings contradict SPEC v2.

---

## 4. Delivery phases

### Phase 1 — The spine (Claude, MCP-shaped, no target polish)
Claude driver (headless) · **causal event model + raw preservation** · LLM proxy + MCP
proxy/stdio-shim with **ordered cassettes** (record/replay) · assertion engine (Tier 1 tool-call +
Tier 2 side-effect; auto-retry, soft, `.not`, allow/deny/required) · directory sandbox + HOME remap
+ structural redaction · **layered budget guard** · cost-aware console reporter · `agentry
init|test|record|doctor` · config + projects.
**Milestone:** the §5 "5-minute test" passes end-to-end for one MCP scenario in both `replay` and
`mcp-live`.

### Phase 2 — Skills & plugins target (observable-effect contracts)
CH1 context-injection + tool-registration matchers, hook-effect matchers, downstream-behavior
matchers, and the **CH6 differential harness** (`baseline` fixture). Matchers tagged
`observed`/`inferred` per spikes 0.6–0.8.

### Phase 3 — MCP gateways target (deepen)
`MockMcpServer` fixture, protocol-compliance matchers, error-code/lifecycle/concurrency assertions,
state-reset hooks for real servers under `mcp-live`.

### Phase 4 — LLM gateways target
Routing, fallback, cache, rate-limit, transformation, token-accuracy, latency-overhead, error-
propagation matchers over the existing LLM interceptor.

### Phase 5 — Cross-agent adapters (committed v1 objective, spike-gated)
The **Codex, Gemini, and Antigravity** drivers ship against the proven interface (`@agentry/codex`,
`@agentry/gemini`, `@agentry/antigravity`), each mirroring the Claude reference (pure parser +
`buildArgs` + honest `capabilities()`), with per-agent capability gating. **Cursor** remains, gated on
spike 0.13; shared suites run across the full matrix once it lands.

### Phase 6 — Tier-3/4 assertions + JUnit/JSON/HTML reporters + parallelism hardening
Structured-output (schema/AST) + LLM-as-judge (recorded for free replay, §8.5); rate-limit-aware
parallelism; HTML report linking to trace bundles.

### Phase 7+ (post-v1) — Deferred
Trace viewer UI · `codegen` record-to-test · PTY/TUI interactive driver + terminal snapshots ·
container/VM isolation as default · declarative YAML authoring · sharding ergonomics · GitHub
Actions first-class integration.

---

## 5. MVP success criteria (the 5-minute test)

A developer can:
1. `npm i -D agentry` and `npx agentry init` in <5 min.
2. Write a test that starts Claude Code, sends a prompt triggering an MCP tool, and asserts on the
   tool call + a side-effect.
3. Run in **`replay`** in <2s and **`mcp-live`/`live`** in <120s.
4. See clear pass/fail **with a cost summary**.
5. Run in CI with nothing beyond an API key.

---

## 6. Acceptance criteria (measurable)

- **Isolation:** two parallel scenarios writing the same relative path both succeed with their own
  content.
- **Budget:** exceeding the cap stops cleanly via the proxy gate (no orphaned children, cassette
  intact) and fails with a `budget` error within ~5s; process-kill only as last resort.
- **Transcript completeness:** a scenario with N tool calls yields exactly N `tool_use` events;
  raw native events preserved.
- **Replay fidelity (LLM):** every test passing live also passes in `replay` (record 10, replay 10,
  all green), with **zero false cassette matches** on the positional key.
- **Replay fidelity (MCP server):** MCP-server tests run under `mcp-live` (real server code paths)
  with deterministic LLM replay; state-reset hooks isolate runs.
- **Skill/plugin observability:** for a known skill and a known plugin hook, the corresponding CH1
  effect is asserted as `observed`; the CH6 differential reproduces the intended behavioral delta.
- **Performance:** framework overhead (startup-to-first-assertion, excl. agent response) **<1.5s**;
  total `replay` run **<2s**. *(Reconciled — these are now consistent.)*
- **Error quality:** every failed assertion names which assertion failed, expected vs actual, and
  points to the relevant trace section.

### Edge cases the suite must distinguish (not collapse into "timeout")
Refusal · infinite loop ("looped" ≠ "slow") · MCP server crash mid-run · agent asks for
clarification · record/replay model-version drift (warn) · 429s under parallelism (backoff, not
failure) · correct result via unexpected tool path (side-effect passes, strict-sequence fails —
guide to the resilient matcher) · large file outputs (capture caps) · secrets echoed (redaction
catches) · cleanup failure (force-kill + retry).

---

## 7. Open questions for the owner

Resolved since v1: ~~skills/plugins observability~~ (→ effect contracts, §2); ~~scope~~ (→ held
firm). Still open:

1. **License & business model** — OSS (MIT/Apache) vs OSS-core + paid cloud? *(Rec: MIT, local-only
   viewer for v1.)*
2. **Lead persona for docs** — all four types are in scope, but docs need a *lead* narrative. *(Rec:
   MCP-server developer — clearest competitive gap.)*
3. **MCP server lifecycle** — Agentry starts/stops servers (`webServer`-style) vs expects them
   running. *(Rec: manage them + `MockMcpServer` fixture.)*
4. **Cassette storage** — committed to the repo under test vs separate cache. *(Rec: committed for
   hermetic CI; external-store override for large ones.)*
5. ~~**Repo shape**~~ — **RESOLVED (2026-06-27): monorepo** (`@agentry/core`, `/claude`, `/mcp`,
   `/reporters`, …).
6. ~~**Phase 0 ownership**~~ — **RESOLVED (2026-06-27): Agentry runs the spikes** in the owner's
   environment (in progress — see §3 and `docs/research/phase0-findings.md`).

---

## 8. Status

- [x] Foundational decisions locked (§1)
- [x] Spec drafted + revised post-review (`SPEC.md` v2)
- [x] Roadmap drafted + revised (this doc v2)
- [x] Independent review pass (Claude critic + Codex; in `docs/research/`)
- [~] Phase 0 spikes — **in progress**: 0.1 / 0.2 / 0.4 ✅, 0.6 / 0.7 🟡, config isolation ✅,
  cross-agent Codex (0.11) / Gemini (0.12) / Antigravity (0.14) ✅;
  remaining: MCP shim (0.3), HOME-remap (0.5), cassette canonicalization (0.9), mcp-live (0.10),
  Cursor (0.13)
- [x] Repo shape = monorepo; Phase 0 ownership = Agentry-runs (§7)
- [~] **Implementation — MVP spine + LLM-proxy phase + cross-agent drivers SHIPPED** (108 unit tests, CI green):
  - [x] **Phase 1 (spine):** monorepo · event model · RunRecord · Sandbox (fs diff) · config
    (model-pin) · assertion engine (Tiers 1–3) · cassette engine · Claude driver (live) · transcript
    record/replay · runner + fixtures · console reporter · CLI (init/test/record/doctor). MVP §5
    success criteria met end-to-end (`agentry record` → `agentry test` replay ~10ms).
  - [x] **LLM proxy + wire cassettes:** `LlmProxy` (record/live/wire-replay) at `ANTHROPIC_BASE_URL`
    — CH1 `llm_request`/`llm_response` events, byte-faithful wire cassettes, budget proxy-gate,
    secret redaction, positionable `Upstream` seam. **`wire-replay`** mode (hermetic re-execution,
    positional VCR) validated live (~6s, $0 real spend).
  - [~] **Phase 2 (skills/plugins):** `toHaveLoadedPlugin` / `toFireHook` (CH2) + `toInjectContext` /
    `toRegisterTools` (CH1, via the proxy) shipped. Remaining: CH6 differential harness.
  - [~] **Phase 3 (MCP):** `MockMcpServer` + `toExposeTools` / `toHaveReceived` shipped; remaining
    live agent→mock fixture wiring + protocol-compliance matchers.
  - [~] **Phase 4 (LLM gateways):** foundation laid (observable `llm_request`/`llm_response` +
    positionable proxy + provider-impersonation seam, SPEC §9.3); remaining: provider-pool resolver
    + routing/fallback/cache matchers.
  - [~] **Phase 5 (cross-agent adapters):** Claude + **Codex + Gemini + Antigravity** drivers shipped
    (each mirrors the reference: pure parser + `buildArgs` + `capabilities()`); `agentry doctor` probes
    all four CLIs. Remaining: **Cursor** (spike 0.13).
  - [ ] **Phase 6** (Tier 4 LLM-as-judge, HTML/JUnit reporters) · **Phase 7+** (trace viewer, codegen,
    PTY driver) — not started.

  *Known gaps:* wire cassettes capture host config until HOME-remap sandboxing (spike 0.5) lands, so
  they're not committed for the example yet; `wire-replay` cost display shows recorded (not $0) spend.
