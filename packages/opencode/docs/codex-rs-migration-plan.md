# codex-rs → opencode Migration Plan

Synthesized from six parallel comparison reports run 2026-04-17 against codex_git HEAD (`/Volumes/external/sources/codex_git/codex-rs`) and opencode branch `unify/copilot-plan`. Source reports live at `/tmp/compare-{copilot,autobest,adaptive-loop,codemem,autoskill,architecture}.md`. A seventh report (`compare-autosteer.md`) was expected but not produced; autosteering coverage has been folded into the adaptive-loop section below.

---

## Table of Contents

1. [Executive summary](#1-executive-summary)
2. [Feature-by-feature status table](#2-feature-by-feature-status-table)
3. [Per-feature detail](#3-per-feature-detail)
   - [3.1 Copilot multi-account routing](#31-copilot-multi-account-routing)
   - [3.2 Autobest (post-turn continuation engine)](#32-autobest-post-turn-continuation-engine)
   - [3.3 Adaptive loop + autosteering + sub-agent delegation](#33-adaptive-loop--autosteering--sub-agent-delegation)
   - [3.4 Codemem / memories](#34-codemem--memories)
   - [3.5 Autoskill (self-improving skills)](#35-autoskill-self-improving-skills)
   - [3.6 Architecture (crate/module shape)](#36-architecture-crate-module-shape)
4. [Consolidated migration roadmap](#4-consolidated-migration-roadmap)
5. [Risk register](#5-risk-register)
6. [Suggested next milestones](#6-suggested-next-milestones)
7. [Appendix A — report index](#appendix-a--report-index)

---

## 1. Executive summary

### What is already ported well (green)

- **Session CRUD + fork skeleton** (`session/session.ts`): structurally faithful to `codex_thread.rs` for row/message/part state; fork path works but does not replay a rollout.
- **Copilot connection store & per-account headers** (`plugin/github-copilot/connections.ts`, `copilot.ts`): `ConnectionState`, `x-initiator`, `X-Interaction-Type`, machine-id plumbing are present, in several places richer than Rust (alias lanes, plan classification, `batchOrder/autobestBatch` debug).
- **MCP client, custom prompts, TUI, session history/analytics log, plugin loader**: structurally parallel; feature-complete for their surface.
- **Autobest ranking primitives** (`autobest/index.ts`): `Candidate`/`Pick`/`State`/`Decision` + history bridge — a solid substrate, even though the *LLM-driven* extractor/grounding/compact pipeline is unported.
- **Bus / event system and managed-runtime architecture**: TS-side `sync/` event-sourced projector + `Bus.Service` actually *exceed* Rust's per-Codex event channel; no migration needed.

### Substantially done but with gaps (amber)

- **Copilot pool concurrency**: the routing / alias layer is richer than Rust, but the pool itself (`runtime.ts`) lacks RAII leases, bounded acquire, primary-vs-backup separation, stepped 429 recovery, escalating headerless-429 fallbacks, and SQLite persistence of cooldowns. Default agent cap is 1 vs Rust's 7.
- **Autobest**: name-compatible but feature-incomplete — no LLM Step A, no auto-continue loop, no Step B/C/D cycle state, no grounding side-path, no compact-window integration. Today it is a bullet-scraper with durable logging.
- **Adaptive loop**: fixed-goal, reactive-to-tools only. No autosteering stagnation detector, no "where is the plan?" follow-up, no parent-turn auto-wait for async children. `task` tool is synchronous; no sub-agent siblings.
- **Skills**: static discovery + a 50-line keyword `recommend()` function. The `autoskill` config flag exists but gates only the keyword hint block. No extractor, no hot-insert, no evolution, no embedding retrieval, no env-var dependencies.
- **Provider account pooling**: only Copilot has a pool, and it is a local reinvention rather than a generic `account_pool`.

### Entirely absent (red)

- **codemem / memories subsystem**: ~17–22k LOC worth of functionality (two-phase LLM extraction, DefectSextuple knowledge record, embedding + rerank retrieval, turn-loop prompt-injection, git commit crawler, foreign-ingest pipeline for Claude/Cursor/Kiro/Codex histories). TS `history/` is a per-session JSONL telemetry log, not memory.
- **Cloud tasks + backend-client** (~6.3k Rust LOC): ChatGPT task backend, long-running task TUI, diff apply/approve flow.
- **Apps / connectors** directory (ChatGPT-hosted MCP app registry + `[$app](app://…)` mention parsing).
- **Sub-agent delegation with guardian** (`codex_delegate*` ~2.6k LOC): async child threads, `send_input`, `wait`, `auto_wait_for_active_children`, approval interception via guardian LLM.
- **Hooks crate** (`SessionStart`/`Stop`/`AfterAgent`/`PreCompact` user-defined hooks).
- **OS-level sandboxing** (seatbelt / landlock / windows-sandbox).
- **Network proxy / responses-api-proxy** audited transport layer.
- **`codex-api` as a distinct provider-API abstraction**; **`app-server-client` in-process JSON-RPC embedding**.
- **Embedding client** (provider-neutral `/v1/embeddings`) — prerequisite to memories + embedding-based skill search.
- **`keyring-store`** for credential storage.

### Priority ranking (across all features)

| Rank | Item | Rationale |
|---:|---|---|
| 1 | Copilot 429 correctness fixes (monotonic exhaustion, stale-GC, error triage, 401 mark) | Trivial patches; directly user-visible as "permanently exhausted" or "keeps hitting dead account" |
| 2 | Copilot two-step discovery (`/copilot_internal/user` → `/models`) + plan gating | Enterprise/individual routing is silently broken today |
| 3 | Adaptive-loop injection primitive inside `SessionPrompt.runLoop` | Unlocks autosteering, empty-output follow-up, stop-hook injection, auto-wait. Small core, high leverage |
| 4 | Autobest Step A LLM + auto-continue loop | Current TS autobest is effectively inert; these two steps deliver the user-visible value |
| 5 | Embedding client + memories MVP (retrieval-only; BYO sextuples) | Unlocks both codemem retrieval and real `skill_search` |
| 6 | Autoskill extractor + hot-insert + evolution scaffold | Delivers on the config flag's name; wires tool-outcome feedback |
| 7 | Generic account-pool abstraction (lift Copilot `runtime.ts` idea) | Prerequisite for multi-provider pooling; blocks Rust-parity for sub-agent leases |
| 8 | Async sub-agent model + guardian | Large architectural change; required for parallel children + `auto_wait` |
| 9 | Hooks subsystem | High-leverage, low blast radius; unblocks external integrators |
| 10 | Foreign-ingest pipeline, commit crawler | Optional features; ship after memories MVP |
| 11 | Cloud-tasks / backend-client / apps-connectors | Only relevant if ChatGPT backend parity is a product goal |
| 12 | In-process JSON-RPC transport, OS sandboxing, keyring, network-proxy | Polish; defer until core parity lands |

---

## 2. Feature-by-feature status table

| # | Feature | Status | Rust LOC (approx.) | TS LOC today | Report |
|---:|---|:---:|---:|---:|---|
| 1 | **Copilot multi-account routing** | 🟡 | ~9,300 | ~1,800 | `compare-copilot.md` |
| 2 | **Autobest continuation engine** | 🔴 | ~1,800 + grounding 776 | ~600 (ranking-only) | `compare-autobest.md` |
| 3 | **Adaptive loop / autosteering / async sub-agents** | 🟡 (loop) / 🔴 (autosteer & async siblings) | ~3,400 across `codex.rs` injection sites + `codex_delegate*` | ~2,000 in `session/prompt.ts` + `tool/task.ts` | `compare-adaptive-loop.md` |
| 4 | **Autosteering (stagnation nudge)** | 🔴 | ~100 (`codex.rs:4861-4958`) | 0 | folded into #3 |
| 5 | **Codemem / memories** | 🔴 | ~17,000 | 0 (history ≠ memory) | `compare-codemem.md` |
| 6 | **Autoskill (self-improving skills)** | 🔴 (toggle exists but feature unbuilt) | ~15,900 | ~380 | `compare-autoskill.md` |
| 7 | **Architecture (crate shape, app-server, cloud-tasks, connectors, hooks, sandbox, keyring)** | 🟡 (core) / 🔴 (cloud-tasks, connectors, hooks, sandbox, keyring, network-proxy) | varied | varied | `compare-architecture.md` |

Legend: 🟢 ported well · 🟡 substantially done, gaps identified · 🔴 essentially absent.

---

## 3. Per-feature detail

### 3.1 Copilot multi-account routing

Source: `/tmp/compare-copilot.md`.

**What is ported (🟢):** `ConnectionState` with persisted `exhaustedUntil`/`lastTestedAt`/`label`/`login`/`preferred`/`plan`/`proxyUrl`/`proxyToken`/`discovery`/`lastRoutedAt`/`machineId`; device-flow OAuth; per-account headers (`x-initiator`, `X-Interaction-Type`, `Copilot-Vision-Request`); quota bar (10-char ASCII vs Rust's 16-char Unicode — different style, same function); CLI surface (`providers quota|accounts|route-debug|proxy`). In several respects TS is a superset — alias lanes, plan classification, batch selection, route-debug tooling.

**Gaps (🔴/🟡):**

- `AccountPool` with primary + backup, RAII leases, stepped 429 recovery, bounded acquire (`account_pool.rs:429-1694`) — missing. TS uses a flat `Pool` map in `runtime.ts:22-141`, default concurrency cap of **1** (`OPENCODE_COPILOT_RUNTIME_LIMIT`) vs Rust's **7**.
- `HEADERLESS_429_FALLBACK_DELAYS = [11m, 21m, 41m]` escalator (`account_pool.rs:64-68, 1232-1242`) — TS uses fixed 11 m only (`copilot.ts:650`).
- Stepped recovery 1→2→full after 429 at 5/7/9 min — missing.
- `ACQUIRE_TIMEOUT=5min` bounded acquire — missing.
- `AccountLease::reassign` atomic hand-off — missing.
- `CopilotRateLimiter` adaptive 10 m sliding-window semaphore (`core/src/copilot_rate_limiter.rs:1-299`) — missing.
- SQLite-backed `AccountPoolPersistence` for cooldowns/429/success events (`account_pool_persistence.rs:1-400`) — missing; TS has only JSON file state, no file lock.
- `check_account_statuses` auth/rate/network triage (`lib.rs:212-264`) — partial (CLI-side only).
- `select_best_token` quota-aware startup randomization (`lib.rs:269-344`) — TS `selectAccount`/`next` is deterministic first-live, no randomized spread.
- Two-step discovery `/copilot_internal/user` → `/models` with dynamic `endpoints.api` + plan SKU (`models.rs:439-567`) — not chained in TS. Enterprise/individual routing is silently broken.
- `CopilotModelCatalog::retain_for_plan` (drop models by `billing.restricted_to` vs plan SKU) — missing (`models.rs:174-180`).
- `best_per_vendor` / `best_supported_model` tier-ranked display — missing.
- Fetch-envelope proxy protocol (`POST {proxy}/fetch { url, method, headers, body, timeout }`) — TS rewrites the URL only and attaches `x-copilot-proxy-token` header; protocols are incompatible.
- Bundled model fallback + `canonicalize_copilot_model_id` (`lib.rs:53-128`) — missing.
- `CopilotError::is_auth_error/is_rate_limited/is_network_error` triage — TS inlines ad-hoc 429/401 checks; 403 / 5xx / transport errors are neither marked nor cleared.
- Stale-exhaustion auto-clear during `get_connections` — missing; a stale `exhaustedUntil` persists forever.
- Monotonic exhaustion timestamp — `mark()` at `connections.ts:93-95` overwrites and can **shorten** a cooldown.
- `#edu-` test-account stripping in prod — missing.
- Device-flow `slow_down` retry cap (>10 → abort) — missing; TS loops forever on `slow_down`.
- OAuth scope drift: Rust `read:user,read:org,repo,gist` vs TS `read:user`.
- `BlackbirdClient` (code-search/embeddings/chunks, 509 LOC) — missing; not required for core chat.
- `transfer::export_accounts`/`import_accounts` (484 LOC) — missing.

**Behavioral drift worth calling out:**

- `machineId` persistence: Rust regenerates per-process to defeat per-machine rate-limiting; TS persists in JSON. If Copilot ever per-machine-quotas, TS gets hit, Rust does not.
- `aliasModels` and the `models` hook run separately and both write `state.connections` without file-locking — last-write-wins race on boot.
- 401 does not mark the account in TS; next dispatch picks the same dead account.
- Premium rollback only fires on 429/401 in TS (`copilot.ts:651-657`); on 5xx / transport errors the premium flag sticks.

**Migration plan** (S = ~½ day, M = 1–2 days, L = 3+ days; numbered by report):

1. [S] Trivial correctness — monotonic `mark()`, stale-exhaustion GC in `sort`/`next`, `#edu-` strip, device-flow `slow_down` cap.
2. [S] Centralise HTTP triage (`copilotStatus(res)` → `{auth, rateLimit, network}`).
3. [M] Chain `fetchQuota` → `CopilotModels.get(api ?? base, …)` with bundled fallback + `canonicalize_copilot_model_id`.
4. [S] Plan-gated catalog (`billing.restricted_to` filtering).
5. [M] Discovery barrier (`discoveryComplete` Promise + 10 s bounded wait).
6. [M] Account status + startup spread (port `check_account_statuses`; randomize inside `selectAccount` when several accounts are live).
7. [M] 429 escalator (`headerless429Count`, `last429At`, honor `retry-after`, stepped request-available gate).
8. [M] Model-aware failover (`unsupportedModels: string[]` on `Conn`; tier score `Supported > Unknown > DiscoveryFailed > Unsupported`).
9. [L] Full `AccountPool` semantics (primary+backup, bounded acquire, `acquirePreferSecondary`, `reassign`).
10. [L] SQLite persistence of cooldowns via bun:sqlite with boot-snapshot restore.
11. [M] Cascade breaker (`availableAccountCount` / `shouldThrottleSpawns`) once the pool lands.
12. [M] Fetch-envelope proxy protocol.
13. [S] `bestPerVendor` UI display.
14. [M] Adaptive rate limiter (optional).
15. [M] Transfer export/import (low priority).
16. [L] Blackbird client (optional).

---

### 3.2 Autobest (post-turn continuation engine)

Source: `/tmp/compare-autobest.md`.

**TL;DR:** TS autobest is a **pure ranking utility with durable history logging** (Candidate → Pick → State/Decision + regex bullet extractor). Rust autobest is a **multi-step LLM-driven continuation engine** (A → B → C → D) with parallel multi-MCP grounding, compact-window plan integration, session cycle state, 13 config knobs, 13 counters, and TUI auto-continue that re-submits the extracted action as the next user turn.

**What is ported (🟢 on ranking primitives, 🔴 on pipeline):**

- `Candidate`, `Pick`, `State`, `Decision` plus `apply`/`decide`/`setActive`/`extract`/`empty` functional API.
- Durable history (`autobest.state` / `autobest.active` / `autobest.result` / `autobest.enabled`) via JSONL + KB view counts.
- REST endpoints at `server/instance/session.ts:347-636` and thread aliases at `server/instance/thread.ts:97-122`.
- Observer layer on `SessionStatus.Event.Idle` and in-loop hook at `session/prompt.ts:1565`.

**Gaps (critical):**

- **No auto-continuation feedback loop.** Picks are logged but never re-submitted as a new user turn. Rust `maybe_autobest_continue` → `submit_user_message` is the user value; TS is observably inert.
- **No LLM Step A extractor.** TS uses regex `^[-*]\s+(.+)$` or `^\d+[.)]\s+(.+)$` only; latent next-actions in prose are silently missed. Rust calls the configured extractor model (default `gpt-4.1`) with a strict JSON schema.
- **No Step B plan-check** against the current compact window (`next_unfinished_plan_item`).
- **No Step C / D** ("what's next?", "where is the plan?", terminate-with-reason). Cycle flags `what_next_asks_used_this_cycle` / `where_is_plan_asks_used_this_cycle` are missing.
- **No grounding module.** Entire `autobest_grounding.rs` (776 LOC, 23 unit tests) is absent — no MCP tool inventory, no rate-limit (`min_interval_turns`), no `is_search_like_tool_name`, no parallel tool dispatch.
- **`SessionEvent.Autobest` shape is skeletal**: no `step`, `reason`, `elapsedMs`, `modelUsed`, `iteration`, `turnID`, `compactWindowID`, `compactSnippet`, `whatNextAsked`, `resultingAction`, `grounding` fields.
- **Duplicate observer vs prompt-loop hook** — both fire on Idle, risking double-apply.
- `POST /:threadID/autobest/setActive` is misnamed — it flips `enabled`, not active.

**Migration plan (ordered):**

1. Wire auto-continuation feedback at `prompt.ts:1573` — synthesize a user turn from the top candidate's key when picks.length > 0 and `autobest.enabled`.
2. Port Step A LLM extractor (6000-byte UTF-8-safe truncation; JSON output schema; fence-stripping + balanced-brace fallback; regex fallback on LLM failure).
3. Extend `SessionEvent.Autobest` schema with step / reason / compact / grounding / iteration / turnID fields.
4. Add cycle flags + `decide_empty_followup`.
5. Implement Step C ("what's next?") submission.
6. Implement Step D terminate with reason.
7. Step B plan check — gated on compact-state port; otherwise always fall through to C/D.
8. Port `autobest_grounding.rs` as `packages/opencode/src/autobest/grounding.ts`.
9. Add 13 `autobest_*` config fields (compact_model defaulting `gpt-4.1`, grounding `8/8`, etc.).
10. Mirror `bg_stat_counters.autobest.*` + `grounding.*` (13 counters).
11. REST alignment (rename misleading `setActive`, add `GET /:threadID/autobest/log`).
12. Deduplicate observer vs inline hook (Rust has a single `Op::AutobestExtract` entrypoint).
13. Template override dir (`autobest.templateDir`).
14. UTF-8-safe truncation helpers.

Port the following Rust tests: `step_a_json_parsing`, `parse_action_json_variants`, `find_json_object_edge_cases`, `truncate_helpers`, `decide_empty_followup_terminates_after_one_ask`, `build_result_step_{a,b,c,d}_*`, all 23 grounding unit tests, the `autobest_v2.rs` app-server integration, and the Python E2E suite (`test_e2e_autobest_{semantics,cycles,stress}.py`).

---

### 3.3 Adaptive loop / autosteering / sub-agent delegation

Source: `/tmp/compare-adaptive-loop.md`.

**Model:** Rust has no single "current goal" field. Adaptivity is four independent history-mutating mechanisms stapled to the `run_turn` loop (`codex.rs:6747`):

1. Passive `update_plan` tool (pure UI write-through).
2. Collaboration-mode gate (`ModeKind::Plan` vs `Default`).
3. **Autosteering nudge** — on `autosteering_stagnation_count >= 2`, inject a synthetic user-role "stop planning, act" message into history (`codex.rs:4861-4958`).
4. **Autobest empty-followup** — "what's next?" / "where is the plan?" / terminate (covered in §3.2).
5. **Sub-agent delegation** via `codex_delegate*` + `multi_agents` (spawn/wait/send_input/close/list/resume); `auto_wait_for_active_children` (`codex.rs:7145-7160`) holds the parent turn open while async children finish.

**TS today:** `SessionPrompt.runLoop` (`session/prompt.ts:1336`) is a fixed loop. The only mid-run mutations are (a) queued compaction (present), (b) `handleSubtask` on pre-attached `subtask` parts, (c) the synchronous `task` tool. No autosteering, no empty-output follow-up, no async children, no auto-wait.

**Gap table** (from report):

| # | Feature | Status |
|---|---|---|
| G1 | Planning-only / similarity nudge (`check_core_autosteering`) | 🔴 missing |
| G2 | "Where is the plan?" follow-up | 🔴 missing |
| G3 | "What's next?" follow-up | 🔴 missing |
| G4 | Auto-wait for active sub-agents at turn end | 🔴 missing (TS has no parallel children) |
| G5 | Persistent async sub-agent threads | 🔴 different model (synchronous) |
| G6 | Guardian routing of child approvals | 🔴 missing |
| G7 | Depth limit on sub-agent spawn | 🔴 missing (unbounded nesting possible) |
| G8 | Plan-mode rejection of `update_plan` | 🟡 partial (per-tool permissions, no mode machinery) |
| G9 | `send_input` to in-flight child | 🔴 missing |
| G10 | Slot / lease accounting for sub-agents | 🔴 missing |
| G11 | Stop-hook inject-and-continue | 🔴 missing |
| G12 | Pre-sampling compact on token threshold | 🟢 present (`compaction.isOverflow`) |

**Migration plan (phased):**

- **Phase 1 — Stagnation nudge (G1).** Add `SessionPrompt.AdaptiveState` with `previousAssistantText` + `stagnationCount`. After `handle.process` returns, compute Jaccard vs previous assistant text; on count ≥ 2 push a synthetic `<system-reminder>` user part and `continue`. Config: `experimental.autosteering` default false.
- **Phase 2 — Empty-output follow-up (G2, G3).** Detect empty + no-tool-calls + no plan-update, inject `"Where is the plan?"` or `"What's next?"` synthetic user text; counters reset on new user message; `max_asks_per_cycle` config.
- **Phase 3 — Async sub-agent model (G4, G5, G9, G10).** Introduce `SubagentRegistry` keyed by sessionID → `{status, promise, cancel}`. Refactor `tool/task.ts` to support `fireAndForget: true`. Add `task_wait`, `task_send_input`, `task_close`, `task_list`. Before `break` in `runLoop`, insert `autoWaitForActiveChildren` equivalent (250 ms cancel-polling). Cancel cascades via child scopes.
- **Phase 4 — Guardian + depth limits (G6, G7).** Depth limit is cheap (`parentID` count on session creation + rejection in `TaskTool.execute`). Guardian requires a reviewer model path — defer.
- **Phase 5 — Stop-hook injection (G11).** Once the injection primitive exists, tap registered stop hooks.

**Hook-site suggestion** (from the report, direct quote):

```
// packages/opencode/src/session/prompt.ts:1344 area
const adaptive = yield* SessionPrompt.AdaptiveState.for(sessionID)
while (true) {
  yield* adaptive.preIteration({ lastUser, lastAssistant, step })
  ... existing code through handle.process ...
  const injection = yield* adaptive.postIteration({ handle, outcome })
  if (injection) { yield* injectSyntheticUserText(injection); continue }
  if (outcome === "break") {
    const childrenSummary = yield* SubagentRegistry.autoWait(sessionID)
    if (childrenSummary) { yield* injectSyntheticUserText(childrenSummary); continue }
    break
  }
  continue
}
```

This is the load-bearing shape change: concentrate adaptive behavior in one place, preserve the processor contract.

---

### 3.4 Codemem / memories

Source: `/tmp/compare-codemem.md`.

**TL;DR:** The TS `history/` subsystem is **not a memory system**. It is a per-session JSONL telemetry log (~16 KB total across `history/{index,analytics,kb,search,timeline}.ts`). No cross-session retention, no embedding, no retrieval, no prompt injection, no structured knowledge record. All ~17k LOC of Rust memories is absent.

**Rust memories architecture** (under `codex-rs/core/src/memories/`):

- `start.rs` (102) — startup orchestrator: gated on not-ephemeral, `MemoryTool` enabled, not-sub-agent, `state_db` available.
- **Phase 1** (`phase1.rs` 1037) — per-rollout LLM extraction; `gpt-5.4` default, xhigh reasoning; strict JSON schema `{rollout_summary, rollout_slug, raw_memory, sextuples[]}`. Concurrency 8, lease 3600 s, secret redaction, control-char sanitization, tail-biased 30/70 truncation. Sextuples embedded into `raw_memory` via `<!-- memcoder:sextuples:{begin,end} -->` sentinels.
- **Phase 2** (`phase2.rs` 527) — global-lease consolidation sub-agent (sandboxed to `{codex_home}/memories`, no network, `Collab`+`SpawnCsv` disabled, approvals off). Rebuilds `raw_memories.md` + `rollout_summaries/{stem}.md`. Heartbeat every 90 s.
- **`DefectSextuple`** (`sextuple.rs` 671): `{original_message, code_changes_summary, keywords, problem, root_cause, solution, source, embedding}`. `hash_id = sha256(problem ‖ 0x1f ‖ root_cause)`; `embedding_key = keywords.join(" ") + " [PROBLEM] " + problem`.
- **Query synthesis** (`query_synth.rs` 446) — LLM distills a keyword-rich retrieval query; 30 s timeout; robust JSON parsing (direct → fenced → balanced-block); on failure `fallback_query(user_prompt)`.
- **Two-stage retrieval** (`retrieval.rs` 1872) — ANN over `DefectSextuple.embedding` (cosine top-N, `N = top_k * STAGE1_POOL_MULTIPLIER(4)`) → LLM cross-encoder rerank (`gpt-4.1`, batches ≤ 20, 0–10 score); merged `0.3 × stage1 + 0.7 × stage2/10`; drop `< memories_retrieval_min_score` (0.4). Project scoping; dedup-by-identity.
- **Turn-loop hooks** (`turn_hooks.rs` 1126): `enrich_user_prompt_with_memories` (before each user turn; `memories_retrieval_enabled` default false) and `extract_and_refine_turn_sextuples` (after; `memories_extraction_enabled` default true).
- **Commit crawler** (`commit_crawler.rs` 887) — `git rev-list` walk, per-commit LLM polisher, batched JSONL writes. *Still gated `#[allow(dead_code)]` upstream — not wired into `start.rs`.*
- **Foreign ingest** (`foreign_ingest/*`, ~6k LOC) — adapters for Claude Code / Claude Extension / Cursor Agent / Codex / OpenCode / Kiro; content-hash dedup; writer-lock per git root; worker-pool; pure 4-signal scorer (`refining.rs`); skills extractor.
- `migration.rs` (432) — one-shot `project_root` backfill.
- `control::reset_all_memories` → `/memory/reset` RPC.

**Cross-cutting prerequisites** (not memories but blocking):

- **Embedding client** — provider-neutral OpenAI-compat `/v1/embeddings`. Rust has `skills::embedding::EmbeddingClient`; TS has nothing general-purpose (Copilot file-search is tool-specific).
- **State DB tables**: `stage1_outputs`, `foreign_stage1_outputs`, `foreign_ingest_done`, `foreign_skills_extracted`, phase-1 jobs, phase-2 global job, all with lease/ownership tokens.
- **Sub-agent sandbox** for consolidation (write-only under `{memoriesRoot}`, network off, no nested spawn, approvals off) — new variant in OpenCode's permission model.
- **Advisory file-locking** (`proper-lockfile` or equivalent).
- **Secret redactor** (`util/redact.ts`).

**Storage recommendation:** start with Rust's approach (brute-force cosine over in-memory sextuples, bounded by `THREAD_SCAN_LIMIT=5000`). Migrate to `sqlite-vec` only if retrieval latency becomes a problem at foreign-ingest scale.

**Migration plan (staged):**

- **Stage A — Core data + storage.** `sextuple.ts`, SQLite migrations, on-disk artifact layout, sentinel-embedding helpers, embedding client, `/memory/reset` RPC.
- **Stage B — Query synthesis.** Port `query_synth.rs`. Verbatim-copy the Askama template from `core/templates/memories/query_synth.md`.
- **Stage C — Prompt injection hooks.** `turn-hooks.ts`, two-stage retrieval, refining scorer (pure first, LLM polish later). Wire into `session/prompt.ts` so retrieval prepends to user turn text; post-turn hook fires after `step.finish`.
- **Stage D — Phase 1 + Phase 2.** Adapt `claim_stage1_jobs_for_startup` to scan `history/*.jsonl`. Phase 2 consolidation sub-agent needs the new sandbox variant.
- **Stage E — Commit crawler.**
- **Stage F — Foreign ingest.** Port adapters (skip `opencode.rs` — we are the source, not consumer), `discovery.ts`, `checkpoint.ts`, `writer-lock.ts`, `worker-pool.ts`, `pipeline.ts`. `runtime.ts` is heaviest (2463 LOC); ship Stage F initially without auto-scheduling.

**Suggested ship order:**

1. **MVP retrieval-only** (A + B + C with scorer stubbed). BYO sextuples, no extraction. ~3k TS LOC.
2. **Passive extraction** (add D2 Phase 1). ~5k TS LOC.
3. **Consolidation** (D3–D5). ~2k TS LOC.
4. **Commit crawler** (E). ~1.3k TS LOC.
5. **Foreign ingest** (F1–F6, then F7). ~6–9k TS LOC.

Feature-flag defaults should preserve Rust parity: `memories.enabled=false`, `memories.retrievalEnabled=false`, `memories.extractionEnabled=true` (once opted in), `memories.rerankEnabled=true`, `memories.retrievalTopK=8`, `memories.retrievalMinScore=0.4`, `memories.foreignIngest.enabled=false`.

---

### 3.5 Autoskill (self-improving skills)

Source: `/tmp/compare-autoskill.md`.

**TL;DR:** The `autoskill` config flag (`config/config.ts:126`) is a single boolean that toggles a 50-line keyword recommender (`session/system.ts:37-56`) which scores skills by token hits (name=4, description=2, content=1) and appends the top-3 as "Auto-skill hints:" to the system prompt. Everything else the name implies — extractor, hot-insert, evolution, embedding retrieval, env-var dependencies, implicit-invocation telemetry — is absent.

**Rust subsystem** (`codex-rs/core/src/skills/`, ~15.9k LOC):

- `auto_extract.rs` (372) — orchestrator, called once per root-turn at `codex.rs:7369`. Runs the heuristic extractor, filters `confidence >= 0.5`, persists via `SkillLibrary::insert_skill_hot`, calls `session.notify_skill_hot_inserted()` so the current turn's `TurnSkillsContext` (`ArcSwap<SkillLoadOutcome>`) sees the new skill immediately.
- `extractor.rs` (1066) — LLM-free heuristic: pairs `FunctionCall` ↔ `FunctionCallOutput` by `call_id`; gates `min_tool_calls=3`, `min_success_rate=0.8`; kebab-case name ≤ 50 chars; tags from tool names + file extensions + path components; infers `SkillExecutionMode`; emits YAML-frontmatter `SKILL.md` with `yaml_safe_scalar` escaping.
- `evolution.rs` (345) — `SkillEvolutionEngine` tracks per-skill `SkillUtilityRecord` + flat `tips: Vec<Tip>`. Actions: `RecordSuccess`, `RecordTip`, `OptimizeSkill`, `DiscoverNewSkill`. Thresholds: `min_samples=3`, `utility_rate >= 0.3`.
- `hook.rs` (117) — `on_tool_complete(evolution, tool_name, success, error)` fired fire-and-forget from `registry.rs`.
- `embedding.rs` (1291) — `EmbeddingProvider::{Api, LocalTfIdf}` (defaults `qwen3-embedding-0.6b` 1024 dim; TF-IDF fallback 384 dim); SQLite vector store (no sqlite-vec extension; brute-force cosine up to 10k skills).
- `env_var_dependencies.rs` (162) — scans `SkillMetadata.dependencies.tools[]` for `type == "env_var"`; checks session cache → `std::env::var` → interactive `RequestUserInputArgs` prompt (marked `is_secret`); caches answers on session.
- `injection.rs` (493) — parses `$skill-name` sigils and `[$name](path)` markdown-link mentions in user input; builds `ResponseItem`s wrapping `SkillInstructions`; emits `codex.skill.injected` counter.
- `invocation_utils.rs` (236) — implicit-invocation detection (shell commands running scripts under a skill's `scripts/` dir or `cat`-ing its `SKILL.md`).
- `handler.rs` (420) — two model-facing tools: `skill_search` (BM25 via `SkillLibrary::search`, fallback substring) and `skill_execute` (returns `SKILL.md` contents).
- `builtin.rs` (36) — 8 compiled-in skills via `include_str!`.

**TS today** (`packages/opencode/src/skill/`, 380 LOC):

- `skill/index.ts` (264) — static Effect `Skill.Service` (`get/all/dirs/available`). Walks `~/.claude/skills/`, `~/.agents/skills/`, worktree ancestors, `config.directories()`, `skills.paths[]`/`skills.urls[]`. No mutation API.
- `tool/skill.ts` (99) — `SkillTool` (name parameter, returns content + sampled file listing). Analogue of Rust `skill_execute` only.
- `session/system.ts:37-56` — `recommend({ text, list })`: token scorer (min 4 chars). Top-3 appended when `conf.autoskill !== false`.
- No `skill_search`, no extractor, no hot-insert API, no evolution, no embedding, no dependencies schema, no sigil parsing.

**Gap priority:**

- **P0** — Heuristic extractor, hot-insert, auto-extract orchestration.
- **P1** — BM25 / embedding-based search; keyword `recommend()` is too shallow.
- **P2** — Evolution engine + tool-outcome feedback; env-var dependency resolution.
- **P3** — Implicit-invocation telemetry; `$skill` mention parsing; compiled-in builtin skills; router (1591-line `router.rs` — defer unless product need).

**Migration plan (phased):**

- **Phase 1 — Hook + injection scaffolding.** Extend `Skill.Info` schema with `dependencies`, `policy`, `scope`. Add `Skill.Service.insert(name, content)` (mid-turn safe via atomic replace or `Ref<State>`). Add `Skill.Event.HotInserted` bus event. Tighten `SystemPrompt.skills()` to re-read the list every turn.
- **Phase 2 — Extractor.** Port `extractor.rs` to `skill/extractor.ts` (pure, no network). `collectToolCallsFromMessages` walks `MessageV2` pairing by `toolCallId`. Heuristics verbatim. `generate_skill_md` with YAML-safe escaping.
- **Phase 3 — Auto-extract orchestration.** `skill/auto-extract.ts::maybeAutoExtractSkill(session, config, turnMessages, userPrompt, modelResponse)`. Gated on `config.autoskill !== false` (repurpose the flag so it actually turns on the feature named after it). Skip sub-agent sessions. 3 s timeout. Call from `session/processor.ts` after post-tool phase but before finalizing the assistant message.
- **Phase 4 — Evolution engine.** Port `evolution.rs` + `hook.rs`. Tap tool completion in `tool/registry.ts`. Surface `OptimizeSkill` / `DiscoverNewSkill` via `Bus` events for TUI.
- **Phase 5 — Embedding retrieval.** Port `embedding.rs`. Reuse bun:sqlite. Replace `recommend` internals with BM25 first, then embedding-based `skill_search` tool matching Rust's `handler.rs` shape.
- **Phase 6 — Env-var dependencies.** Teach frontmatter parser `dependencies.tools`. Port `env_var_dependencies.rs`. Reuse existing question/permission flow; cache on session.
- **Phase 7 — Polish.** Implicit invocation telemetry; builtin skills via Bun embed; router (defer).

---

### 3.6 Architecture (crate / module shape)

Source: `/tmp/compare-architecture.md`.

**Structurally ported** (same idea, different idioms):

| Area | Fidelity |
|---|---|
| Session CRUD + fork | 🟢 High |
| MCP client | 🟢 High |
| Skills (static side) | 🟢 High |
| Plugins (no marketplace) | 🟡 Partial |
| Auth / login (no keyring) | 🟡 Partial |
| Custom prompts | 🟢 High |
| TUI (Ink vs ratatui) | 🟢 Parallel |
| Config | 🟡 Partial |
| Provider clients | 🟡 Partial (AI-SDK abstracts most) |
| Rollout / history | 🟡 Divergent implementations, similar goal |
| Exec policy + sandboxing | 🟡 Partial — no OS-level sandbox |
| Observability | 🟡 Partial |

**Structurally absent in TS:**

1. `app-server-client` / in-process JSON-RPC embedding.
2. `codex_delegate_guardian` sub-agent approval auto-review.
3. `cloud-tasks*` + `backend-client` — ChatGPT task backend (6.3k Rust LOC).
4. `apps` / `connectors` — ChatGPT app directory + `[$app](app://…)` mention parsing + umbrella MCP.
5. `hooks` crate (`SessionStart`/`Stop`/`AfterAgent`/`PreCompact`).
6. `network-proxy` + `responses-api-proxy` audited transport.
7. `codex-api` as a distinct provider-API abstraction layer.
8. OS-level sandboxing (seatbelt / landlock / windows-sandbox).
9. `account_pool` / `account_lease` typed pooling (Copilot plugin's `Runtime` is a parallel reinvention).
10. `exec-policy` DSL.
11. `session-recorder` with typed `SessionEventKind`.
12. `keyring-store`.

**TS-only gains (not in Rust):**

1. `sync/` event-sourced projector layer (`sync/index.ts`, 278 LOC).
2. `autobest/` subsystem (ranking primitives only, but the substrate exists).
3. `history/` JSONL + analytics/KB/search/timeline views.
4. `timer/` managed timer service with REST + tool.
5. `ShareNext` / `share/*`.
6. `control-plane/` + `server/control/` multi-workspace routing.
7. `session/llm.ts` AI-SDK completion streaming.
8. `effect/app-runtime.ts` `ManagedRuntime` composition pattern.

**Concurrency model drift:**

| Concern | Rust | TS |
|---|---|---|
| Backpressure | Bounded `async_channel` | Unbounded `PubSub` (pressure via fiber supervision) |
| Cancellation | `CancellationToken` (cooperative) | `Fiber.interrupt` / `Scope.close` |
| Fan-out | MPMC channel | `PubSub.subscribe` → per-subscriber `Queue` |
| Hierarchical cancel | `token.child_token()` | Parent-fiber interrupt propagation |
| One-shot wait | `oneshot::channel()` | `Deferred.make()` |

The `sync/` + `Bus.Service` pair is arguably richer than Rust's per-Codex receiver; no migration needed.

**Priority (from architecture report):**

- **Phase A (~2–4 weeks):** hooks port; minimal TS `exec-policy` DSL (semantic intent carried through bus even without OS enforcement).
- **Phase B (~4–6 weeks):** sub-agent guardian (bus-level interceptor on approval events + `GuardianService`); generic `account/pool.ts`.
- **Phase C (~2–3 months):** backend SDK (generate from `codex-backend-openapi-models`); cloud-tasks UI in Ink TUI + web UI; apps + connectors.
- **Phase D (~4–8 weeks):** in-process JSON-RPC transport (`server/adapter.in-process.ts`); protocol schema export (mirror `app-server-protocol/src/bin`).
- **Phase E (long tail):** network-proxy port; keyring wrap (`node-keytar`); rollout alignment.

---

## 4. Consolidated migration roadmap

Ordered by dependency + leverage. Each phase groups work that can ship together. **Effort:** S = ~½ day, M = 1–2 days, L = 3+ days, XL = week+.

### Phase 0 — Quick-win correctness (1–3 days)

Land trivial copilot patches plus pre-sampling hook primitive. Done first because every subsequent phase benefits.

| Item | Source feature | Effort | Dependencies |
|---|---|---|---|
| Monotonic `mark()`; stale-exhaustion auto-clear; `#edu-` strip; device-flow `slow_down` cap | Copilot | S | — |
| Centralise HTTP triage (`copilotStatus(res)`) | Copilot | S | — |
| 401 marks account deactivated (propagate from `is_auth_error`) | Copilot | S | triage helper |
| Premium rollback on all non-success statuses | Copilot | S | — |
| Introduce `SessionPrompt.AdaptiveState` scaffold (no behavior yet) | Adaptive loop | S | — |
| Introduce `Skill.Service.insert` + `Skill.Event.HotInserted` bus event | Autoskill | S | — |
| Introduce embedding client (`packages/opencode/src/embedding/client.ts`) | Codemem prereq | M | — |
| File-lock + atomic write for `copilot-connections.json` | Copilot | S | — |

**Risk:** low. All changes are additive or bounded fixes.

### Phase 1 — Copilot pool hardening (1–2 weeks)

Address the correctness gaps identified in §3.1. Defers the full RAII pool (Phase 5) but ships stepped recovery + escalator + plan-gated catalog.

| Item | Effort | Dependencies |
|---|---|---|
| Chain `fetchQuota → CopilotModels.get(api ?? base, …)` with bundled fallback + canonicalize | M | — |
| Plan-gated catalog filtering (`billing.restricted_to`) | S | previous |
| Discovery barrier (`discoveryComplete` 10 s bounded wait) | M | — |
| Startup randomized quota-aware pick | M | HTTP triage |
| 429 escalator (`headerless429Count`, `last429At`, `retry-after`) + stepped recovery | M | — |
| Model-aware failover (`unsupportedModels: string[]`, tier score) | M | — |
| `bestPerVendor` UI display | S | — |

**Risk:** moderate — state-schema changes in `connections.ts` need migration for existing deployments.

### Phase 2 — Adaptive loop injection primitive (1 week)

Land the pre/post-iteration hooks in `SessionPrompt.runLoop`. Unlocks autosteering, empty-output follow-up, autobest auto-continue, stop-hook injection, and (later) `auto_wait_for_active_children`.

| Item | Source feature | Effort | Dependencies |
|---|---|---|---|
| `AdaptiveState.preIteration` / `postIteration` scaffold + `injectSyntheticUserText` | Adaptive loop | M | Phase 0 scaffold |
| Autosteering nudge (G1) behind `experimental.autosteering` (default false) | Adaptive loop | M | scaffold |
| Empty-output follow-up (G2/G3) with cycle counters + `max_asks_per_cycle` | Adaptive loop | M | scaffold |
| Deduplicate autobest observer vs inline hook | Autobest | S | scaffold |

**Risk:** moderate — synthetic user parts interact with compaction heuristics; tag with `synthetic: true` so compaction can optionally exclude.

### Phase 3 — Autobest auto-continue + Step A LLM (1–2 weeks)

With Phase 2's primitive in place, make autobest deliver user-visible value.

| Item | Effort | Dependencies |
|---|---|---|
| Auto-continuation feedback at `prompt.ts:1573` (top-candidate → synthetic user turn) | M | Phase 2 |
| Step A LLM extractor with JSON-parse fallbacks + UTF-8-safe truncation | M | — |
| Extend `SessionEvent.Autobest` schema (step/reason/iteration/turnID/compact/grounding fields) | S | — |
| Cycle flags + Step C ("what's next?") + Step D (terminate) | M | Phase 2 |
| REST endpoint naming alignment | S | — |
| Port Step A JSON-parse unit tests | S | — |

**Risk:** moderate — auto-continue amplifies model spend; gate on `autobest.enabled` and per-cycle caps.

### Phase 4 — Autoskill extractor + hot-insert + evolution (2–3 weeks)

| Item | Effort | Dependencies |
|---|---|---|
| Port `extractor.rs` → `skill/extractor.ts` (pure heuristics) | M | Phase 0 insert API |
| `skill/auto-extract.ts` orchestrator gated on `autoskill !== false` | M | extractor |
| Port `evolution.rs` + `hook.rs`; wire `tool/registry.ts` feedback | M | — |
| Replace `recommend` with BM25; add `skill_search` tool | M | embedding client (Phase 0) |
| Extend `Skill.Info` frontmatter schema; port `env_var_dependencies.rs` | M | — |

**Risk:** low — extractor is pure; evolution state is opt-in JSON.

### Phase 5 — Memories MVP retrieval-only (2 weeks)

| Item | Effort | Dependencies |
|---|---|---|
| `sextuple.ts` + SQLite migrations (`stage1_outputs`, `foreign_stage1_outputs`, `foreign_ingest_done`, jobs) | M | — |
| Embedded-sextuple sentinel helpers + `storage.ts` (on-disk artifact layout) | M | sextuple |
| `/memory/reset` RPC | S | storage |
| `query_synth.ts` (port template verbatim) | M | — |
| `retrieval.ts` two-stage (cosine + rerank) | L | embedding client, sextuple, query_synth |
| `turn-hooks.ts` prompt injection + post-turn extraction (gated default off) | M | retrieval |
| Wire into `session/prompt.ts` | S | turn-hooks |

**Risk:** moderate — retrieval block prepended to user turn changes token budget; gate on `memories.retrievalEnabled` (default false).

### Phase 6 — Full Copilot AccountPool + SQLite persistence (2–3 weeks)

| Item | Effort | Dependencies |
|---|---|---|
| Primary + backup pool, RAII leases, bounded acquire | L | Phase 1 |
| `acquirePreferSecondary`, `reassign` | M | pool |
| SQLite-backed cooldown/request event log with boot snapshot restore | L | — |
| Cascade breaker (`availableAccountCount` / `shouldThrottleSpawns`) | M | pool |
| Generic `account/pool.ts` namespace lifted from Copilot runtime | L | Copilot pool |

**Risk:** high — changes the concurrency semantics of every Copilot dispatch. Ship with a feature flag and extensive integration tests.

### Phase 7 — Async sub-agents + guardian + hooks (3–4 weeks)

| Item | Source feature | Effort | Dependencies |
|---|---|---|---|
| `SubagentRegistry` + `task_wait` / `task_send_input` / `task_close` / `task_list` | Adaptive loop | L | Phase 2 |
| `auto_wait_for_active_children` inside `runLoop` before `break` | Adaptive loop | M | registry |
| Depth-limit check in `TaskTool.execute` | Adaptive loop | S | registry |
| Guardian service (bus-level interceptor on approval events) | Architecture | L | registry |
| Hooks crate port (`SessionStart`/`Stop`/`AfterAgent`/`PreCompact`) | Architecture | M | — |
| Sub-agent lease integration with Phase 6 account pool | Copilot | M | pool |

**Risk:** high — cancel semantics change; `Fiber.interrupt` on parent must cascade to registered children via scoped resources.

### Phase 8 — Memories passive extraction + consolidation (2–3 weeks)

| Item | Effort | Dependencies |
|---|---|---|
| Phase 1 extraction job scanning `history/*.jsonl` | L | Phase 5 |
| History-events → stage-one rollout adapter (`historyEventsToStageOneInput`) | M | phase 1 |
| Secret redactor (`util/redact.ts`) | S | — |
| Phase 2 consolidation sub-agent — *requires the new sandbox variant* | L | Phase 7 sub-agents, sandbox variant |
| Memory-tool developer-instruction injection (`buildMemoryToolDeveloperInstructions`) | S | phase 2 |
| Refining scorer (pure 4-signal, no LLM) | M | — |

**Risk:** moderate — Phase 2 sandbox variant is a new primitive; sub-agent approvals must be disabled safely.

### Phase 9 — Foreign ingest + commit crawler (3–4 weeks, optional)

| Item | Effort | Dependencies |
|---|---|---|
| Commit crawler (git rev-list + LLM polish) | M | Phase 5 |
| Foreign-ingest adapters (Claude / Cursor / Codex / Kiro) | L | Phase 5 |
| `discovery.ts` / `checkpoint.ts` / `writer-lock.ts` / `worker-pool.ts` / `pipeline.ts` | L | adapters |
| `runtime.ts` auto-scheduling (defer; ship with manual CLI trigger first) | XL | pipeline |

**Risk:** low — opt-in; feature-flagged `memories.foreignIngest.enabled` default false.

### Phase 10 — Polish (long tail, as needed)

| Item | Effort |
|---|---|
| Autobest grounding module | L |
| Autobest background-stat counters | M |
| Compiled-in builtin skills | S |
| Keyring (`node-keytar`) for auth | M |
| Network-proxy port | L |
| In-process JSON-RPC transport | L |
| Apps + connectors + `[$app](app://…)` mention parser | L |
| Cloud-tasks + backend-client (only if product goal) | XL |
| OS-level sandboxing (seatbelt / landlock / windows-sandbox) | XL |

---

## 5. Risk register

Cross-cutting concerns that span multiple phases.

### R1 — Drift between the 153-commit-old base and current codex_git

**Concern:** Every comparison report pinpoints Rust locations by file:line. codex_git HEAD is ~153 commits ahead of the branch opencode was last synced from. Line numbers in the reports (e.g. `codex.rs:7141`, `account_pool.rs:1151-1199`) will decay. Specific features flagged as dead-code upstream (commit crawler, `#[allow(dead_code)]`) may ship any day.

**Mitigation:** Pin a reference SHA for each migration phase; rebase `/tmp/compare-*.md` against HEAD before starting that phase. For phases 5–9 (memories, sub-agents, hooks) consider running a follow-up comparison pass to catch upstream churn.

### R2 — Effect R-channel discipline

**Concern:** Almost every new subsystem in this plan (AdaptiveState, SubagentRegistry, GuardianService, memories turn-hooks, skill auto-extract) will be Effect services. TS-wide convention is that services live in the `R` channel and must be satisfied by layers in `effect/app-runtime.ts`. Autobest's observer duplicates itself via `Effect.runPromise` in a bus callback (`autobest-observer.ts:25-53`) — a smell indicating R-channel confusion. Adding more services without review will amplify this.

**Mitigation:** Each phase that adds a service must also add (a) its layer to `effect/app-runtime.ts`, (b) a `ManagedRuntime` test harness that instantiates only the minimum surface. Banish `Effect.runPromise` inside bus callbacks in favor of `Effect.fork` under a parent scope.

### R3 — Test harness capacity

**Concern:** Recent commits (`b13c60285`, `c518d8736`, `0399eb9fa`) are flake-elimination and timeout-floor work on the Nx live test suite. Adding LLM-calling subsystems (autobest Step A, memories extraction, skill extractor, evolution) creates new `it.live` paths that are fundamentally slow and flaky. The current run floor is 60 s for heavy-contention live tests. Phase 3+ phases will push more live tests in.

**Mitigation:** Every new LLM call site needs a deterministic mock path activated by env flag (`OPENCODE_TEST_MOCK_LLM=true`). Live tests should be the exception, not the rule. For memories specifically, ship a pure-fixture test suite before the LLM-integrated one.

### R4 — Binary / embedding / SQLite dependencies

**Concern:** The memories MVP requires an embedding API (provider-neutral `/v1/embeddings`) and new SQLite migrations. Autoskill embedding needs the same client. The foreign-ingest pipeline needs `proper-lockfile`. The cloud-tasks port (if pursued) would need a new OpenAPI-generated client. `bun:sqlite` migrations must be idempotent via `PRAGMA user_version`.

**Mitigation:** Land the embedding client in Phase 0 as a dependency of both Phases 4 and 5. Version each SQLite migration under `packages/opencode/src/storage/migrations/`. `proper-lockfile` or Bun-equivalent must be audited before Phase 9.

### R5 — Sub-agent cancel cascade

**Concern:** Phase 7's async sub-agents change the interrupt model. Today `Fiber.interrupt` on a parent unwinds a single synchronous child. With N registered children, a straggler leaves an orphan fiber. The `Effect.uninterruptible` region in `shellImpl` (`prompt.ts:722-911`) already shows the care needed to avoid tool-part orphaning.

**Mitigation:** Store child scopes under the parent scope (`Scope.close(parentScope)` must close children). Explicit finalizer in `SubagentRegistry.register` that calls `runner.cancel`. Integration test: cancel parent with ≥ 2 active children, assert all closed within 1 s. Before Phase 7 lands, draft the test and stand it up as a canary.

### R6 — History-mutation feedback loops

**Concern:** Autosteering, empty-output follow-up, autobest auto-continue, stop-hook injection, and `auto_wait_for_active_children` all write synthetic user parts into history. Compaction reads that history. Runaway injection can trigger unexpected compaction or amplify cost.

**Mitigation:** Tag all synthetic parts with `synthetic: true`. Compaction heuristics can optionally exclude synthetic parts. Enforce per-cycle caps matching Rust: `stagnation_count <= 2`, `where_is_plan_asks_used_this_cycle <= 1`, `what_next_asks_used_this_cycle <= 1`. Reset counters on real user message.

### R7 — Proxy protocol mismatch at migration boundary

**Concern:** Copilot's Rust proxy expects `POST {proxy}/fetch { url, method, headers, body, timeout }`. TS currently rewrites the URL and sets `x-copilot-proxy-token`. A mixed deployment (some Rust, some TS clients) breaks silently. Phase 1 ships Copilot fixes without changing the proxy protocol; Phase 6 changes it.

**Mitigation:** Coordinate Phase 6 proxy work with the proxy operator. During cutover the proxy must support both shapes: URL-rewrite (current TS) and envelope POST (Rust). Add a probe endpoint that returns the supported protocol list; TS client chooses the richer one.

### R8 — State migration for existing users

**Concern:** Any change to `copilot-connections.json` schema, `history/*.jsonl` event shape, or SQLite tables requires migration. Users on `unify/copilot-plan` already have persisted state.

**Mitigation:** Version every persisted JSON with a `_schema` field. SQLite via `PRAGMA user_version`. Write-path emits new shape; read-path accepts both. Remove the compatibility code two releases after the migration.

### R9 — Duplicate observer race

**Concern:** Autobest has two observers firing on `Idle` (in-loop hook + standalone observer). Phase 3's dedupe is marked small but the equivalent pattern will reappear when adding memories turn-hooks, skill auto-extract, etc. Multiple observers writing the same state field race.

**Mitigation:** Adopt the Rust pattern of a single `Op::*` entrypoint per adaptive mechanism. In TS terms: one `AdaptiveState.postIteration` funnel that fans to all observers; no direct `bus.subscribeCallback` → mutate-state paths in new code.

### R10 — Embedding store scale

**Concern:** Rust memories uses brute-force cosine up to `THREAD_SCAN_LIMIT=5000` sextuples. With foreign ingest pulling Claude/Cursor/Kiro histories, this can grow to tens of thousands. Retrieval latency degrades linearly.

**Mitigation:** Ship memories MVP with full scan (matches Rust). Add `sqlite-vec` only if retrieval P95 > 500 ms at real user scale. Keep the `EmbeddingProvider` abstraction so switching is a config change.

### R11 — OAuth scope divergence

**Concern:** TS device-flow requests `read:user` only; Rust CLI uses `read:user,read:org,repo,gist`. Org-scoped discovery (`/orgs/:org/copilot`) 403s on TS-minted tokens.

**Mitigation:** Phase 1 should widen scopes, but re-auth is required for existing tokens. Communicate the change; offer a "refresh scopes" CLI command.

### R12 — Test coverage gap for ported heuristics

**Concern:** Autobest Step A, autoskill extractor, memories refining scorer, autosteering similarity — each is a pure heuristic with Rust unit tests. If we don't port the tests alongside the code, regressions are invisible.

**Mitigation:** Each heuristic port in this plan ships with the corresponding Rust unit-test block ported (verbatim where possible). Maintain a `docs/rust-test-parity.md` checklist per phase.

---

## 6. Suggested next milestones

### Milestone M0 — "Correctness sprint" (worktree: `unify/copilot-fixes`, 3–5 days)

**Scope:** Phase 0 items only.

**Why first:** Every bullet in Phase 0 is a bounded patch that eliminates a specific user-visible bug (permanently-exhausted accounts, dead-account retry loops, infinite device-flow loops, 403/5xx silently ignored). No architectural risk. Ships visible value in one PR.

**Deliverables:**
- Monotonic `mark()`, stale GC, `#edu-` strip, `slow_down` cap, `copilotStatus` triage helper, 401 mark + premium rollback in `copilot.ts`.
- Centralised file-locked atomic write for `copilot-connections.json`.
- Empty `SessionPrompt.AdaptiveState` module (no behavior yet, just wiring).
- `Skill.Service.insert` API + `Skill.Event.HotInserted` bus event (no extractor yet).
- Standalone `embedding/client.ts` with OpenAI-compat + TF-IDF fallback + `embedding.model` + `embedding.apiBaseUrl` config.

**Exit criteria:** all Phase 0 tests green; new `copilot-fixes.test.ts` covering 429 escalation math, 401 mark path, `#edu-` filter; `embedding/client.test.ts` covering API + TF-IDF paths.

### Milestone M1 — "Autobest comes alive" (worktree: `unify/autobest-llm`, 1–2 weeks)

**Scope:** Phase 2 + Phase 3.

**Why next:** Phase 2's injection primitive is the single highest-leverage scaffolding change in the whole plan — it unblocks autosteering, empty-output follow-up, stop-hook injection, and (eventually) `auto_wait_for_active_children`. Phase 3 then rides on that primitive to deliver autobest's headline feature (auto-continue) and its intelligence layer (Step A LLM). After M1, "autobest" actually does what its name claims.

**Deliverables:**
- `AdaptiveState.preIteration` / `postIteration` with one behavior (autobest auto-continue) wired through.
- Step A LLM extractor + JSON-parse fallbacks + UTF-8-safe truncation.
- Extended `SessionEvent.Autobest` schema with step / reason / iteration / turnID / compact fields.
- Cycle flags + Step C + Step D.
- Dedupe observer vs inline hook.
- Autosteering nudge behind `experimental.autosteering` (off by default) as a validation of the injection primitive.
- Ported Step A JSON-parse unit tests.

**Exit criteria:** an end-to-end test that opts into autobest + autosteering on a fresh session, asks a prompt whose response is a bulleted plan, and asserts the next turn auto-submits the first bullet. Cycle termination test: three empty-output turns in a row end in Step D terminate.

### Milestone M2 — "Autoskill delivers its name" (worktree: `unify/autoskill-extract`, 2 weeks)

**Scope:** Phase 4 (extractor + hot-insert + evolution + BM25).

**Why:** The `autoskill` flag has shipped in config since Copilot-plan landed but does essentially nothing visible. M2 makes the flag mean what it looks like: automatic skill growth from successful turns + tool-outcome-driven evolution. Depends only on M0's insert API + embedding client.

**Deliverables:**
- `skill/extractor.ts` with verbatim Rust heuristics + ported unit tests.
- `skill/auto-extract.ts` orchestrator gated on `autoskill !== false`; 3 s timeout; sub-agent skip.
- `skill/evolution.ts` + `skill/hook.ts`; wire into `tool/registry.ts`.
- BM25 replacement for `SystemPrompt.recommend`; new `skill_search` tool.
- Frontmatter `dependencies` schema + `env_var_dependencies.ts` with session-cached answers.
- `Skill.Service` re-reads on every turn; hot-inserted skills visible same-turn.

**Exit criteria:** a test that runs a turn with ≥ 3 successful tool calls, observes a new `SKILL.md` on disk with `confidence >= 0.5`, and the *same* turn's `skill_search` returns the freshly-extracted skill.

### Why this ordering

M0 → M1 → M2 is a deliberate gradient from pure correctness to pure feature development:

1. **M0** lands in the first week, immediately visible as fewer 429-related complaints, unblocks both M1 (via AdaptiveState scaffold) and M2 (via insert API + embedding client).
2. **M1** is the highest-leverage architectural unlock; the injection primitive it lands is reused by autosteering, autobest, stop-hooks, memories turn-hooks (eventually), and auto-wait.
3. **M2** closes the loop on a config flag that has been promising users something the system didn't do.

After M2, the next branch point is one of:

- **M3a (memories MVP):** ship BYO-sextuples retrieval-only (Phase 5). Low effort, immediately useful for power users with curated memory dumps.
- **M3b (Copilot full pool):** finish Phase 1 → Phase 6. Unblocks multi-account heavy users.
- **M3c (async sub-agents):** start Phase 7. Highest architectural risk; requires Phase 2 primitive already validated. Probably needs its own RFC before a worktree opens.

Recommendation: pick M3a first (low risk, high novelty value), run M3b in parallel (different code paths, different reviewers), defer M3c until M1 + M3a have bedded in.

---

## Appendix A — report index

| Report | Scope | Length |
|---|---|---:|
| `/tmp/compare-copilot.md` | Copilot multi-account routing, device flow, proxy, catalog, rate limiting | ~245 lines |
| `/tmp/compare-autobest.md` | Autobest pipeline, grounding, protocol events | ~293 lines |
| `/tmp/compare-adaptive-loop.md` | run_turn adaptivity, autosteering, sub-agent delegation, plan handling | ~269 lines |
| `/tmp/compare-codemem.md` | memories subsystem, foreign ingest, embeddings, retrieval | ~430 lines |
| `/tmp/compare-autoskill.md` | skills static + extractor + evolution + embedding search + env-var deps | ~240 lines |
| `/tmp/compare-architecture.md` | crate shape, concurrency, app-server, cloud-tasks, apps, hooks, sandboxing | ~476 lines |

*Note:* `/tmp/compare-autosteer.md` was expected but not produced. Autosteering coverage has been folded into §3.3 (Adaptive loop). If a dedicated autosteer pass is desired, it would re-analyze `check_core_autosteering` (`codex.rs:4861-4958`) + the `autosteering_stagnation_count: AtomicU32` Session field against TS.
