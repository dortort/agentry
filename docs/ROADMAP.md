# Agentry — Roadmap, Scope & Open Questions

Companion to [`SPEC.md`](./SPEC.md). This doc defines what ships when, the validation work that
must precede architecture, and the decisions still open.

---

## 1. Scope decisions (locked with owner, 2026-06-27)

| Axis | Decision |
|---|---|
| Language/runtime | TypeScript / Node |
| Agent driver | Pluggable `AgentDriver`, CLI subprocess automation first |
| Substrate | Structured/headless primary; PTY/TUI secondary |
| Assertion model | Two-tier: structural exact + semantic |
| Determinism | Record/replay cassettes; **replay default**, live periodic |
| Authoring | Code-first TypeScript v1; declarative YAML deferred |
| **Targets in v1** | **All three: skills & plugins, MCP gateways, LLM gateways** |
| **Agents in MVP** | **Claude**; Codex + Gemini + **Cursor** are fast-follow adapters within the v1 objective |
| North star | Follow Playwright; diverge only for LLM non-determinism |

---

## 2. The scope tension (flagged, eyes-open)

The pre-planning analyst **strongly recommended a single-target MVP** (MCP servers only, Claude
only, two assertion strategies) and rated "3 CLIs × 4 targets × 5 assertion types" as a **High**
scope-creep risk.

**Owner decision: v1 includes all three target types** (built in sequence), Claude-first.

**Why this is acceptable, and how we de-risk it:**

1. **The spine is target-agnostic.** Drivers, event model, interception, assertions, sandbox,
   trace/reporting are built once. Each target is mostly *fixtures + a matcher pack* over that
   spine, not a new subsystem. Most of the cost is the spine, which is shared.
2. **Sequenced, not simultaneous.** Targets land one at a time on the finished spine (Phase 2–4),
   so we never debug three half-built surfaces at once.
3. **Phase 0 validation gates the spend.** The analyst's "Critical/High" risks are empirical
   unknowns; we resolve them in a time-boxed spike *before* committing to the architecture.
4. **Assertion strategies are capped, not proliferated.** Ship Tiers 1–2 fully, Tier 3–4 thinly,
   Tier 5 + a `custom()` escape hatch. Resist built-in strategy sprawl until patterns emerge.

If Phase 0 surfaces a blocker (e.g. an agent fundamentally un-proxyable), we fall back to the
analyst's narrow MVP and re-sequence — see §7.

---

## 3. Phase 0 — Validation spikes (BLOCKING; ~1–2 days, before architecture)

These are cheap experiments that de-risk weeks of work. Each has a binary outcome that steers the
design. *No production code until these are answered and written up.*

| # | Question | Method | Why it matters |
|---|---|---|---|
| 0.1 | Does `claude -p --output-format stream-json` drive headlessly with **no TTY**, and do tool/MCP/usage events appear structured? | Run it in a pipe; inspect JSON | Confirms the primary substrate. (Expected: yes.) |
| 0.2 | Does Claude Code honor **`ANTHROPIC_BASE_URL`** so we can proxy LLM traffic? | Point at a logging proxy | Determines LLM interception viability. |
| 0.3 | How does Claude Code reach **MCP servers** (stdio / HTTP+SSE), and can `.mcp.json` point at our proxy? | Configure a passthrough MCP proxy | Determines MCP interception architecture. |
| 0.4 | Is **idle/exit** cleanly detectable in `-p` mode (terminal `result` event + process exit)? | Observe process lifecycle | Confirms we avoid fragile idle heuristics. |
| 0.5 | Can a **sandbox with HOME-remap** run the agent without leaking host `~/.claude` config? | Run in temp HOME | Confirms isolation approach. |
| 0.6 | Does **replay** exercise the same MCP-server code paths as live (state/time dependence)? | Diff a live vs replay run against a real server | Confirms replay fidelity for server-side targets. |

**Exit criteria:** a short `docs/research/phase0-findings.md` (local) with a yes/no + evidence per
spike, and any architecture deltas folded into `SPEC.md`.

---

## 4. Delivery phases

### Phase 1 — The spine (Claude, MCP-shaped first, no target polish)
Driver (Claude headless) · normalized event model · LLM + MCP interception with
**record/replay cassettes** · assertion engine (Tier 1 tool-call + Tier 2 side-effect, auto-retry,
soft, `.not`, allow/deny/required) · directory sandbox + HOME remap + redaction · **hard budget
cap** · cost-aware console reporter · `agentry init|test|record` · `agentry.config.ts` + projects.
**Milestone:** the §"MVP success criteria" walkthrough passes end-to-end for one MCP scenario.

### Phase 2 — Skills & plugins target
Skill/plugin fixtures + matcher pack (invoke detection, args, output, side-effects, downstream
behavior; plugin load/hook/context-injection/tool-registration; with/without behavioral diff).

### Phase 3 — MCP gateways target (deepen)
`MockMcpServer` fixture, protocol-compliance matchers, error-code/lifecycle/concurrency assertions,
state-reset hooks for real servers.

### Phase 4 — LLM gateways target
Gateway assertion pack (routing, fallback, cache, rate-limit, transformation, token-accuracy,
latency overhead, error propagation) over the existing LLM interceptor.

### Phase 5 — Cross-agent adapters (v1 objective)
Codex (`codex exec`), Gemini (non-interactive), Cursor (`cursor-agent`) drivers against the proven
interface; capability gating; shared suites run across the matrix.

### Phase 6 — Tier-3/4 assertions + JUnit/JSON/HTML reporters + parallelism hardening
Structured-output (schema/AST) + LLM-as-judge (cheaper model, majority vote, soft scorecards);
rate-limit-aware parallelism; HTML report linking to trace bundles.

### Phase 7+ (post-v1) — Deferred
Trace viewer UI · `codegen` record-to-test · PTY/TUI interactive driver + terminal snapshots ·
container/VM isolation · declarative YAML authoring · sharding ergonomics · GitHub Actions
first-class integration · semantic snapshot tooling.

---

## 5. MVP success criteria (the 5-minute test)

A developer can:
1. `npm i -D agentry` and `npx agentry init` in <5 min.
2. Write a test that starts Claude Code, sends a prompt triggering an MCP tool, and asserts on the
   tool call + a side-effect.
3. Run in **replay** mode in <2s and **live** in <120s.
4. See clear pass/fail **with a cost summary**.
5. Run in CI with nothing beyond an API key.

---

## 6. Acceptance criteria (measurable, from analyst)

- **Isolation:** two parallel scenarios writing the same relative path both succeed with their own
  content.
- **Budget:** exceeding the token budget terminates the agent within ~5s and fails with a `budget`
  error.
- **Transcript completeness:** a scenario with N tool calls yields exactly N `tool_use` events.
- **Replay fidelity:** every test passing live also passes in replay (record 10, replay 10, all green).
- **Framework overhead:** startup-to-first-assertion (excluding agent response) <10s.
- **Error quality:** every failed assertion names which assertion failed, expected vs actual, and
  points to the relevant trace section.

### Edge cases the suite must distinguish (not collapse into "timeout")
Refusal · infinite loop (budget/timeout catches; message says "looped" not "slow") · MCP server
crash mid-run · agent asks for clarification · record/replay model-version drift (warn) · 429s under
parallelism (retry w/ backoff, not failure) · correct result via unexpected tool path (side-effect
passes, strict-sequence fails — guide users to the resilient matcher) · large file outputs (capture
caps) · secrets echoed in output (redaction catches) · cleanup failure (force-kill + retry).

---

## 7. Open questions for the owner

These don't block drafting but should be settled before/early in implementation:

1. **License & business model** — OSS (MIT/Apache) vs OSS-core + paid cloud? Affects whether the
   trace viewer is local-only or has a SaaS option. *(Recommendation: MIT, local-only viewer for v1.)*
2. **Primary persona for messaging/docs** — MCP-server dev vs skill/plugin author vs gateway
   operator? (Scope says "all three"; docs still need a *lead* persona. *Recommendation: MCP-server
   dev as the lead narrative, given the clearest competitive gap.*)
3. **MCP server lifecycle** — does Agentry start/stop MCP servers (like Playwright manages the
   browser) or expect them running? *(Recommendation: manage them, via a `webServer`-style config +
   `MockMcpServer` fixture.)*
4. **Cassette storage** — committed to the repo under test, or a separate cache/artifact store?
   *(Recommendation: committed by default for hermetic CI; `attachmentsBaseURL`-style override for
   large ones.)*
5. **Repo shape** — single package vs monorepo (`@agentry/core`, `/claude`, `/mcp`, `/reporters`)?
   *(Recommendation: monorepo so optional pieces stay out of the lean core.)*
6. **Phase 0 ownership** — do you want to run the spikes interactively (you have the agent CLIs
   installed), or should Agentry's first code be the spike harness?

---

## 8. Status

- [x] Foundational decisions locked (§1)
- [x] Spec drafted (`SPEC.md`)
- [x] Roadmap drafted (this doc)
- [ ] Spec review pass (separate reviewer/critic lane)
- [ ] Phase 0 spikes
- [ ] Implementation
