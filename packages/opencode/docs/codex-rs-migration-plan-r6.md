# codex-rs → opencode Migration Plan — R6 Addendum

> Round-6 residual audit against `codex_git` HEAD at `/Volumes/external/sources/codex_git/codex-rs/`, supplementing the R1-R5 plan at `codex-rs-migration-plan.md` (737 lines) and the fork additions reference at `opencode-fork-additions.md` (969 lines).
>
> R1-R5 focused on Copilot routing, autobest, adaptive loop / autosteering, codemem, autoskill, and the core architecture shape. Those areas now have partial-to-full TS ports (memory ~4.9 k LOC, autobest ~1.5 k LOC, skill ~2.5 k LOC, subagent guardian ~570 LOC, adaptive/autosteer ~770 LOC, embedding ~630 LOC). This R6 pass re-audits **the crates outside that scope** — cloud-tasks, backend-client, codex-client/api, connectors, acp/app-server, hooks, network-proxy, keyring, rollout, exec-policy, sandboxing, session-recorder, multi_agents — plus the residual Rust-only functions inside already-ported areas.
>
> The audit also records the **R1-R5 deltas** now closed in the fork branch, so the new work list reflects reality rather than the original roadmap.

---

## Table of Contents

1. [Executive summary](#1-executive-summary)
2. [What R1-R5 already delivered (delta from original plan)](#2-what-r1-r5-already-delivered-delta-from-original-plan)
3. [Per-feature residual gaps](#3-per-feature-residual-gaps)
   - 3.1 [Hooks crate (user-defined lifecycle hooks)](#31-hooks-crate-user-defined-lifecycle-hooks)
   - 3.2 [Cloud tasks + backend-client (ChatGPT task backend)](#32-cloud-tasks--backend-client-chatgpt-task-backend)
   - 3.3 [codex-client / codex-api (low-level HTTP client)](#33-codex-client--codex-api-low-level-http-client)
   - 3.4 [Connectors + apps (ChatGPT app directory)](#34-connectors--apps-chatgpt-app-directory)
   - 3.5 [ACP server bridge](#35-acp-server-bridge)
   - 3.6 [app-server JSON-RPC + in-process transport](#36-app-server-json-rpc--in-process-transport)
   - 3.7 [Network-proxy + MITM transport](#37-network-proxy--mitm-transport)
   - 3.8 [Keyring credential store](#38-keyring-credential-store)
   - 3.9 [Rollout / replay](#39-rollout--replay)
   - 3.10 [Exec-policy DSL](#310-exec-policy-dsl)
   - 3.11 [OS-level sandboxing](#311-os-level-sandboxing)
   - 3.12 [Session-recorder + knowledge-base embeddings](#312-session-recorder--knowledge-base-embeddings)
   - 3.13 [multi_agents tool family (async sub-agent surface)](#313-multi_agents-tool-family-async-sub-agent-surface)
   - 3.14 [Rust-only Copilot functions not represented in TS](#314-rust-only-copilot-functions-not-represented-in-ts)
   - 3.15 [Skill features not covered in R2](#315-skill-features-not-covered-in-r2)
   - 3.16 [Memory polish / refining step we skipped](#316-memory-polish--refining-step-we-skipped)
   - 3.17 [Autobest Step E and missing LLM steps](#317-autobest-step-e-and-missing-llm-steps)
   - 3.18 [Session model drift (codex_thread.rs vs Session.Info)](#318-session-model-drift-codex_threadrs-vs-sessioninfo)
4. [Proposed R6 stream assignments (8 parallel streams)](#4-proposed-r6-stream-assignments-8-parallel-streams)
5. [Risk & dependency graph](#5-risk--dependency-graph)
6. [Open questions / deferrals](#6-open-questions--deferrals)

---

## 1. Executive summary

R1-R5 delivered more than the original plan predicted. Of the 10 "red / entirely absent" items listed in R1 §1, **seven have been partially or fully implemented** on `unify/copilot-plan`: codemem, autoskill, sub-agent registry, guardian scaffold, embedding client, autosteering nudge, and autobest auto-continue stub. The three that remain untouched from R1 are **hooks**, **cloud-tasks / backend-client**, and **OS-level sandboxing**.

This R6 pass identifies **18 residual feature gaps** not yet ported, organised by decreasing user-visible impact. Headline findings:

| Rank | Residual gap | Rust LOC | Priority | Effort |
|---:|---|---:|:---:|:---:|
| 1 | **Hooks system** (17 event types, 10 payload variants, command-hook dispatcher) | ~5,400 | 🔴 | L |
| 2 | **multi_agents async tool family** (spawn/wait/send_input/close/list/resume) | ~1,870 | 🔴 | L |
| 3 | **Exec-policy DSL** (Lisp-style policy parser + 900 LOC core checker) | ~2,500 | 🟡 | L |
| 4 | **Rollout / replay** (session replay, truncation, session-index) | ~4,100 | 🟡 | XL |
| 5 | **Session-recorder KB** (hybrid BM25 + embedding store, 5 big files) | ~8,600 | 🟡 | XL |
| 6 | **Network-proxy + MITM** (cert gen, upstream router, HTTPS intercept, SOCKS5) | ~8,100 | 🟢 | XL |
| 7 | **Keyring credential store** (OS secret backend) | ~225 | 🟡 | S |
| 8 | **app-server in-process JSON-RPC** (13.9 k LOC codex_message_processor) | ~34,700 | 🟢 | XL |
| 9 | **Connectors directory + apps** (ChatGPT app registry + `[$app](app://…)` mentions) | ~540 | 🟢 | M |
| 10 | **ACP server bridge feature parity** (our acp/agent.ts ~1.8 k vs Rust ~4.2 k) | ~4,200 | 🟡 | L |
| 11 | **Cloud-tasks + backend-client** (ChatGPT task TUI, list/diff/apply flow) | ~6,550 | 🟢 | XL |
| 12 | **codex-client HTTP stack** (custom CA, retry policy, telemetry, SSE) | ~2,540 | 🟢 | L |
| 13 | **codex-api provider abstraction** (rate-limits, telemetry, endpoint routing) | ~1,040 | 🟢 | M |
| 14 | **Skill router** (Memento RRF + Boltzmann policy) | ~1,590 | 🟢 | L |
| 15 | **Skill builtin packs** (compiled-in skills via include_str!) | ~40 | 🟡 | S |
| 16 | **Skill e2e tests** (864-line behavioral harness) | ~864 | 🟡 | M |
| 17 | **Memory refining polish** (4-signal pure scorer + LLM polish) | ~543 | 🟡 | M |
| 18 | **Autobest compact-window Step B** (our `compact-stub.ts` doesn't read compact state) | ~400 | 🟡 | M |

Legend: 🔴 critical user-visible gap · 🟡 capability parity · 🟢 polish / product-scope.

### Top-3 recommendation

If only three streams ship in R6:

1. **Hooks** (Stream A). Unblocks every external integrator, mirrors Claude Code's hooks-in-settings model, closes a `stopHooks`-shaped hole that exists in config but misses 16 of 17 event types.
2. **multi_agents async tool family** (Stream B). Registry + guardian already exist; the missing piece is the model-facing tool surface (`task_wait`, `task_send_input`, `task_close`, `task_list`, `task_resume`) plus `auto_wait_for_active_children` inside `SessionPrompt.runLoop`. High-leverage once registry is wired end-to-end.
3. **Exec-policy DSL + keyring** (Stream C). Policy enforcement is a growing requirement and keyring is a half-day drop-in. Pair them because both touch credential / security surfaces.

The remaining 15 gaps split into three product-scope buckets: **protocol parity** (app-server, ACP, codex-client/api), **provider parity** (cloud-tasks, backend-client, connectors), and **polish** (rollout, session-recorder KB, skill router, memory refining). These are Streams D-H below.

---

## 2. What R1-R5 already delivered (delta from original plan)

The R1 plan projected these as "🔴 entirely absent". The current `unify/copilot-plan` branch has them at the noted LOC:

| R1 item | Status | TS LOC | Location |
|---|:---:|---:|---|
| codemem subsystem | 🟢 substantial | ~4,920 | `packages/opencode/src/memory/` (phase1, turn-hooks, retrieval, refining, rerank, query-synth, storage, embedding, commit-crawler, foreign-ingest) |
| Autoskill extractor + hot-insert + evolution | 🟢 substantial | ~2,580 | `packages/opencode/src/skill/` (extractor, evolution, hook, injection, env-deps, bm25, retrieval, discovery) |
| Embedding client | 🟢 done | ~630 | `packages/opencode/src/embedding/` (openai + tfidf + index) |
| Autobest Step A LLM + auto-continue | 🟡 partial | ~1,515 | `packages/opencode/src/autobest/` (index, steps, grounding, llm-extract, compact-stub) |
| Adaptive loop injection primitive | 🟢 done | ~770 | `packages/opencode/src/session/{adaptive.ts,autosteer.ts,autosteer-observer.ts}` |
| Sub-agent registry + guardian | 🟡 partial | ~570 | `packages/opencode/src/subagent/{registry.ts,guardian.ts,guardian-test-utils.ts}` |
| Copilot account-pool (generic pool abstraction) | 🟢 done | ~430 | `packages/opencode/src/plugin/github-copilot/{account-pool.ts,account-pool-sqlite.ts,runtime.ts,health.ts}` |
| Autobest grounding module | 🟢 done | ~508 | `packages/opencode/src/autobest/grounding.ts` |
| Blackbird / Copilot code-search client | 🟢 done | ~370 | `packages/opencode/src/plugin/github-copilot/{blackbird.ts,blackbird-schema.ts}` |
| Memory commit-crawler + foreign-ingest | 🟡 partial | ~1,290 | `packages/opencode/src/memory/{commit-crawler.ts,foreign-ingest/*}` |

The original R1 roadmap's Phases 0-5 are therefore **largely complete** for the Copilot + adaptive + memory + skill axes. Phases 6 (full AccountPool + SQLite), 7 (async sub-agents + guardian + hooks), 8 (memory passive extraction + consolidation), 9 (foreign ingest), and 10 (polish) are the residuals.

Concretely: of the original R1 Phase-7 triplet *{async sub-agents, guardian, hooks}*, the registry+guardian exist in stub form. **Hooks do not exist at all beyond `stopHooks`.** The `multi_agents` model-facing tool family exposing the registry also does not exist. These are the two biggest open items from R1-scope work.

---

## 3. Per-feature residual gaps

### 3.1 Hooks crate (user-defined lifecycle hooks)

**Rust source:** `codex-rs/hooks/` — 5,414 LOC (`command_hook.rs` 1041, `registry.rs` 1908, `types.rs` 1615, `user_notification.rs` 443, `schema.rs` 354, `events/{session_start,stop}.rs`, `engine/{command_runner,config,discovery,dispatcher,output_parser,prompt_evaluator,schema_loader}.rs`).

**Event taxonomy** (from `hooks/src/types.rs:495`): 17 hook events, each with its own typed payload:

| Event | Fires when | Key payload fields |
|---|---|---|
| `AfterAgent` | Parent-loop break after root-turn completes | `thread_id`, `turn_id`, `input_messages`, `last_assistant_message` |
| `AfterToolUse` | After any tool call (success or failure) | `tool_name`, `tool_input`, `duration_ms`, `sandbox_policy`, `output_preview` |
| `Stop` | Pre-break stop chain | `stop_hook_active`, `last_assistant_message` |
| `PreToolUse` | Before tool dispatch | `tool_name`, `tool_input`, `tool_use_id` |
| `PostToolUse` | After successful tool dispatch | `tool_name`, `tool_input`, `tool_response`, `tool_use_id` |
| `PostToolUseFailure` | After failed tool dispatch | `tool_name`, `tool_input`, `error`, `is_interrupt` |
| `SubagentStart` | Sub-agent session begin | `agent_id`, `agent_type` |
| `SubagentStop` | Sub-agent session end | `stop_hook_active`, `agent_id`, `agent_type`, `last_assistant_message` |
| `UserPromptSubmit` | After user prompt is enqueued | user input, context |
| `SessionStart` | Session created | `source` |
| `SessionEnd` | Session closed | `reason` |
| `Notification` | Toast/alert surfaces | `notification_type` |
| `PermissionRequest` | Before approval prompt | `tool_name`, context |
| `PreCompact` | Before compaction pass | `trigger` |
| `ConfigChange` | Config reloaded | `source` |
| `InstructionsLoaded` | Agent/system instructions loaded | text body |
| `TeammateIdle` / `TaskCompleted` / `WorktreeCreate` / `WorktreeRemove` | Various parent events |

**HookResult surface** (ibid.:18):

- `Success` carries 9 effects: `additional_context` (prepend to next prompt), `updated_input` (rewrite tool args), `updated_output` (rewrite tool response), `updated_permissions` (mutate grants), `decision_behavior`+`decision_message` (approve/deny with reason), `decision_interrupt` (halt permission flow), `system_message` (inject system note), `suppress_output` (hide user-facing emit).
- `FailedContinue` / `FailedAbort` control whether subsequent hooks run and whether the operation proceeds.

**Matching**: each `Hook` carries an optional `matcher: Regex` and `group: Option<String>` for set-based filtering (e.g. all stop hooks in a group). `matches_event()` at `types.rs:178` decides whether the hook fires.

**Config shape** (from `hooks/src/registry.rs`): `HooksConfig { hooks: Vec<CommandHookDef> }` where each def has `event`, `command: Vec<String>`, `matcher: Option<String>`, `timeout_ms`, `group: Option<String>`. Parsing is JSON-schema-validated via `schema.rs`.

**Dispatch engine** (`hooks/src/engine/dispatcher.rs`): loads registered hooks, spawns a subprocess per matching hook with `HookPayload` JSON on stdin, parses stdout as `HookResponse` JSON, enforces timeout, aggregates effects.

**TS today** (`packages/opencode/src/config/config.ts:443-466`): a single `experimental.hooks.stopHooks` config field carrying `{command: string[], timeoutMs?: number}[]`, consumed by `packages/opencode/src/session/prompt.ts:223-250` and executed via `runStopHook()`. That's 1 of 17 events, no matcher, no group, no effects beyond "inject stdout as synthetic user text".

**Gap** 🔴: 16 missing event kinds, no payload schema, no `updated_input`/`updated_output`/`updated_permissions`/`decision_*` effects, no matcher, no group, no dispatcher for non-stop events, no schema file export, no `HookSubagentContext` for nested agents, no `HookEventAfterToolUse` with `sandbox_policy` string.

**Proposed TS layout** (Stream A):

- `packages/opencode/src/hook/types.ts` — zod schemas mirroring `HookEvent`, `HookResult`, `HookPayload`, `HookSessionContext`, `HookSubagentContext`.
- `packages/opencode/src/hook/registry.ts` — `Hook.Service` Effect service with `register`/`list`/`execute`, regex matcher, group filtering.
- `packages/opencode/src/hook/command.ts` — subprocess dispatcher with stdin/stdout JSON protocol, timeout enforcement, stdout-as-HookResponse parser.
- `packages/opencode/src/hook/dispatch.ts` — event router plugged into `SessionPrompt.runLoop`, `Bus.subscribe(MessageV2.Event.PartUpdated)`, `Session.Event.Created`, tool registry pre/post hooks, compaction hook, permission request bus.
- `packages/opencode/src/hook/schema.ts` — JSON-schema export for CLI `opencode hooks schema` command.
- Extend `packages/opencode/src/config/config.ts` `experimental.hooks` to accept the full `CommandHookDef[]` shape; retain `stopHooks` as legacy alias that auto-migrates.

**Effort:** L (~2–3 weeks). No architectural risk — all 17 events already exist as bus events or are emitable at known call-sites. The bulk of work is the dispatcher subprocess protocol and the 17 payload schemas.

---

### 3.2 Cloud tasks + backend-client (ChatGPT task backend)

**Rust source:**
- `codex-rs/cloud-tasks/src/` — 4,775 LOC (`lib.rs` 2382, `ui.rs` 1043, `app.rs` 512, `env_detect.rs` 362, `scrollable_diff.rs` 176, `util.rs` 145, `cli.rs` 120, `new_task.rs` 35).
- `codex-rs/cloud-tasks-client/src/` — 1,298 LOC (`http.rs` 901, `mock.rs` 197, `api.rs` 170, `lib.rs` 30).
- `codex-rs/backend-client/src/` — 1,021 LOC (`client.rs` 634, `types.rs` 376, `lib.rs` 11).

**User value:** ChatGPT long-running task backend — users submit a task via CLI or TUI, it runs server-side on OpenAI infrastructure, and the TUI polls `list_tasks` / `get_task_details` / `list_sibling_turns`, renders a scrollable diff, and offers apply/reject.

**Key API surface** (`backend-client/src/client.rs`):

- `Client::new(base_url)` / `from_auth(base_url, auth)` — supports `PathStyle::{ChatgptApi, OpenAiApi}` path routing.
- `get_rate_limits()` / `get_rate_limits_many()` — rate-limit snapshots for multi-account dispatchers.
- `list_tasks(page)` / `get_task_details(task_id)` / `list_sibling_turns(task_id)` / `get_config_requirements_file(...)` / `create_task(request_body)`.
- `CodeTaskDetailsResponse` with `turns: Vec<Turn>`, each carrying `TurnItem[]`, `DiffPayload`, `Worklog`, `TurnError`.

**Gap** 🟢: Not ported. Depends on ChatGPT-backend access that opencode users generally don't have (opencode is provider-neutral via AI-SDK). Ship only if ChatGPT parity becomes a product goal.

**Impact:** skip for now. Document as "intentional non-goal" in `opencode-fork-additions.md`. If pursued, generate TS client from `codex-rs/codex-backend-openapi-models/` OpenAPI spec (already Rust-sourced from the same schema).

**Effort:** XL (~3–4 weeks) if pursued. Skippable.

---

### 3.3 codex-client / codex-api (low-level HTTP client)

**Rust source:**
- `codex-rs/codex-client/src/` — 2,518 LOC (`custom_ca.rs` 788, `rate_limit_stats.rs` 656, `transport.rs` 456, `default_client.rs` 218, `retry.rs` 215, `request.rs` 53, `sse.rs` 48, `error.rs` 30, `lib.rs` 40, `telemetry.rs` 14).
- `codex-rs/codex-api/src/` — 1,037 LOC (`rate_limits.rs` 366, `common.rs` 262, `provider.rs` 174, `telemetry.rs` 98, `lib.rs` 50, `auth.rs` 45, `error.rs` 42) plus `endpoint/` + `requests/` + `sse/` submodules.

**User value:** a provider-neutral HTTP transport layer with custom-CA support, rate-limit accounting, SSE parsing, retry policy, and per-provider endpoint routing. It sits between `backend-client` / `github-copilot` and the `core` session loop.

**What's in Rust, not TS:**

- `custom_ca.rs` (788 LOC) — corporate CA bundle loading, system trust-store override.
- `rate_limit_stats.rs` (656) — sliding-window quota tracking, shared across providers.
- `transport.rs` (456) — generic `Transport` trait with hooks for `custom_ca`, `proxy`, `retry`.
- `retry.rs` (215) — adaptive retry with jitter (the copilot retry is a local reinvention).
- `rate_limits.rs` (366) — `RateLimitSnapshot`, `RateLimitBudget`, per-window accounting.
- `provider.rs` (174) — `ApiProvider` enum, endpoint derivation, model-id canonicalization.

**TS today:** AI-SDK handles most of this generically. Fork has `packages/opencode/src/plugin/github-copilot/copilot.ts::dispatch` (~1 k LOC) which partly duplicates `transport.rs` + `retry.rs` for the Copilot case only.

**Gap** 🟢: generic provider-neutral abstraction absent. AI-SDK is good enough for most cases. Corporate CA injection is the most tangible missing piece for enterprise users.

**Proposed TS layout** (Stream F, low-priority):

- `packages/opencode/src/transport/custom-ca.ts` — load CA bundle from env/config, inject into `undici.Agent`.
- `packages/opencode/src/transport/rate-limit-stats.ts` — sliding-window store shareable across plugins.
- `packages/opencode/src/transport/retry.ts` — lift the Copilot retry into a reusable utility.

**Effort:** L (~2 weeks) for a lean port covering custom CA + generic retry + shared rate-limit stats. Skip `codex-api` entirely; AI-SDK replaces it.

---

### 3.4 Connectors + apps (ChatGPT app directory)

**Rust source:**
- `codex-rs/connectors/src/lib.rs` — 534 LOC. `list_all_connectors_with_options()` paginates `GET /connectors/directory/list?tier=categorized&external_logos=true`, merges directory + workspace connectors, caches for 1 h, exposes `AllConnectorsCacheKey { chatgpt_base_url, account_id, chatgpt_user_id, is_workspace_account }`.
- `codex-rs/core/src/apps/` — 10 LOC (`mod.rs` 3, `render.rs` 7). Tiny; only exposes `render_apps_section()` which prints the string `## Apps\nApps are mentioned in user messages in the format [$app-name](app://{connector_id})…` into the system prompt.
- Mention parser lives in `codex-rs/core/src/`. Search: `rg '\[\\\$' codex-rs/core/src` finds the `[$app](app://…)` URL regex in `app_mention.rs` or similar.

**User value:** a user can type `[$notion](app://notion)` in a message. The system prompt tells the model that the set of tools in the `codex-apps` MCP server corresponds to the installed apps. This lets the user "mention" a connector and have the model treat its tools as first-class.

**TS today:** not ported. `packages/opencode/src/mcp/` is a generic MCP client; there is no ChatGPT-app directory fetch, no `[$app](app://…)` parser, no system-prompt injection.

**Gap** 🟢: low priority. The mechanism only works with ChatGPT-hosted MCP apps. Opencode users run their own MCP servers via `mcp.servers[]` config, which already works.

**Proposed TS layout** (Stream D if pursued):

- `packages/opencode/src/connectors/index.ts` — port the directory-list pagination + cache.
- `packages/opencode/src/session/apps.ts` — system-prompt renderer.
- Extend `packages/opencode/src/session/prompt.ts` input parser to strip `[$app](app://id)` mentions and inject into system prompt.

**Effort:** M (~1 week). Low impact for non-ChatGPT users.

---

### 3.5 ACP server bridge

**Rust source:** `codex-rs/acp-server/` — 4,178 LOC (`lib.rs` 3621, `protocol.rs` 546, `main.rs` 11). The bulk is in `lib.rs`: protocol handlers for every ACP (Agent Communication Protocol) method — prompts, authentication, fs_read, fs_write, session management, history, notifications.

**TS today:** `packages/opencode/src/acp/agent.ts` — 1841 LOC, plus `session.ts` (116), `types.ts` (24). Total ~1,980 LOC.

**Delta:** the Rust implementation carries ~2,200 LOC more surface than the TS bridge. Likely missing:

- Full elicitation protocol (out-of-band user-input requests mid-turn).
- Rich attachment handling (image/file part routing).
- Session-history replay over ACP (depends on Rust rollout, §3.9).
- Plan-mode transitions exposed over ACP.
- Permission-request auto-resolution when session ACP auth is enabled.

**Gap** 🟡: cannot fully assess without a per-method audit. The size delta is suspicious enough to warrant a dedicated stream.

**Proposed TS work** (Stream E):

1. Diff the ACP method surface: `grep 'acp_' codex-rs/acp-server/src/lib.rs` vs `grep '"initialize"\|"prompt"\|"fs_read"' packages/opencode/src/acp/agent.ts`.
2. For each Rust-only method, port with zod schemas + handler.
3. Exercise via `@zed-industries/agent-client-protocol` integration tests.

**Effort:** L (~2 weeks). Prerequisite: a method-level audit (½ day) to size the delta precisely.

---

### 3.6 app-server JSON-RPC + in-process transport

**Rust source:** `codex-rs/app-server/` — 34,686 LOC across 20 files. Highlights:

- `codex_message_processor.rs` — 13,963 LOC. Central JSON-RPC dispatcher for every Codex operation. Implements >100 RPC methods.
- `bespoke_event_handling.rs` — 5,206 LOC. Custom event dispatch logic.
- `in_process.rs` — 1,647 LOC. The headline feature: run app-server inside the same process as the TUI or editor, avoiding JSON-RPC serialisation over a pipe.
- `transport.rs` — 1,488 LOC. Pluggable transport (stdio, Unix socket, in-process).
- `fs_api.rs` (988) / `fs_watch.rs` (434) / `fuzzy_file_search.rs` (247) — file ops exposed over RPC.
- `config_api.rs` (898) / `external_agent_config_api.rs` (201) — config read/write over RPC.
- `copilot_bootstrap.rs` (551) — Copilot-specific bootstrap handshake.
- `skill_api.rs` (380) — skill ops exposed over RPC.
- `tui_bridge.rs` (929) — bridge between app-server and a remote TUI.

**TS today:** `packages/opencode/src/server/` is a Hono-based HTTP+WebSocket server. Different idiom, different protocol. No JSON-RPC, no in-process transport, no stdio/UDS transport, no bespoke event handling layer.

**Gap** 🟢: protocol-compatibility only. Opencode's Hono server is functionally complete for the web / desktop / TUI clients. The only user value of porting is interoperability with existing Rust-clients (ACP, app-server-client, app-server-test-client) that speak JSON-RPC.

**Proposed TS layout** (defer unless interop is a product goal):

- `packages/opencode/src/server/adapter.jsonrpc.ts` — JSON-RPC 2.0 transport adapter (stdio + UDS).
- Reuse existing Hono handlers; wrap each as a JSON-RPC method with schema validation.
- `packages/opencode/src/server/adapter.inprocess.ts` — in-process transport for embedding opencode in a host binary.

**Effort:** XL (~4 weeks). Defer.

---

### 3.7 Network-proxy + MITM transport

**Rust source:** `codex-rs/network-proxy/` — 8,057 LOC (`runtime.rs` 1671, `http_proxy.rs` 1292, `network_policy.rs` 890, `proxy.rs` 819, `socks5.rs` 609, `config.rs` 605, `mitm.rs` 482, `policy.rs` 435, `state.rs` 406, `certs.rs` 344, `upstream.rs` 190, `responses.rs` 125, `mitm_tests.rs` 110, `lib.rs` 51, `reasons.rs` 8).

**Function:** audit/enforce every outbound HTTP/HTTPS request made by the agent. Generates a per-session CA cert, intercepts TLS, records each request against a configurable allow/deny policy, supports SOCKS5 upstream, emits structured "reason" codes for each block. Paired with `codex-rs/responses-api-proxy/` as a forwarding gateway.

**TS today:** not ported. `packages/opencode/src/plugin/github-copilot/copilot.ts::proxy` is a URL-rewrite on a single Copilot envelope endpoint — vastly less capability.

**Gap** 🟢: advanced feature, security-sensitive. Most opencode users run without proxy enforcement. Port only if a product requirement for audit/allow-list emerges.

**Effort:** XL (~4–6 weeks). Defer.

---

### 3.8 Keyring credential store

**Rust source:** `codex-rs/keyring-store/src/lib.rs` — 225 LOC. Thin wrap around the `keyring` crate with a `DefaultKeyringStore` impl, a `MockKeyringStore` for tests, and a `CredentialStoreError` wrapping `KeyringError`. Used for OAuth tokens, API keys.

**TS today:** secrets live in plaintext at `~/.local/share/opencode/auth.json` and `~/.local/share/opencode/copilot-connections.json`.

**Gap** 🟡: a genuine security gap. Simple drop-in: `node-keytar` (macOS Keychain / Windows Cred Vault / libsecret) covers all three platforms with ~40 LOC.

**Proposed TS layout** (Stream C):

- `packages/opencode/src/auth/keyring.ts` — wraps `keytar` (runtime-dep), exposes `get/set/delete` keyed by provider + account key.
- Extend `packages/opencode/src/auth/` to optionally fall back to file when keytar is unavailable (CI, Linux without libsecret).
- Opt-in via `config.auth.useKeyring = true`.

**Effort:** S (½-1 day).

---

### 3.9 Rollout / replay

**Rust source:** `codex-rs/core/src/rollout/` — 4,094 LOC (`list.rs` 1273, `tests.rs` 1471, `recorder.rs` 1109, `recorder_tests.rs` 512, `metadata_tests.rs` 377, `session_index.rs` 233, `metadata.rs` 441, `policy.rs` 190, `session_index_tests.rs` 167, `truncation_tests.rs` 149, `truncation.rs` 73, `error.rs` 49, `mod.rs` 32).

**Function:** a rollout is a durable event log that lets you **replay** a session deterministically from the recorded model/tool outputs. Different from opencode's `history/*.jsonl` (which is an observation log). The rollout enables `fork from message N with replay`, `truncate rollout before point X`, and cross-session index (`session_index.rs`).

**TS today:** `packages/opencode/src/session/session.ts::fork` exists but does not replay — it copies the session row tree at a point. No deterministic replay, no rollout-level truncation, no session-index over rollouts.

**Gap** 🟡: useful for advanced debugging, `git bisect`-on-turns, and for ACP session replay. Not a user-visible feature today.

**Proposed TS layout** (Stream G):

- `packages/opencode/src/rollout/recorder.ts` — append-only rollout writer (JSONL + checkpoint markers).
- `packages/opencode/src/rollout/metadata.ts` — per-rollout metadata record.
- `packages/opencode/src/rollout/list.ts` / `session_index.ts` — index across rollouts.
- `packages/opencode/src/rollout/truncation.ts` — rollout-level truncation for forked sessions.

**Effort:** XL. Defer unless ACP replay or deterministic fork becomes a requirement.

---

### 3.10 Exec-policy DSL

**Rust source:**
- `codex-rs/execpolicy/src/` — 1,789 LOC (`parser.rs` 473, `policy.rs` 375, `amend.rs` 338, `rule.rs` 306, `error.rs` 101, `execpolicycheck.rs` 95, `executable_name.rs` 29, `decision.rs` 27, `lib.rs` 27, `main.rs` 18).
- `codex-rs/execpolicy-legacy/` — legacy surface retained for migration.
- `codex-rs/core/src/exec_policy.rs` — 857 LOC. The runtime checker that consumes `execpolicy` decisions during tool dispatch.

**Function:** a Lisp-style DSL (`parser.rs`) describing which executables + arg patterns are allowed in sandbox / denied / require approval. Compiled to `Rule`s, evaluated per-tool-call at `exec_policy.rs`. User-configurable via per-project `.codex/exec_policy.lisp` style files.

**TS today:** `packages/opencode/src/permission/` has an approval flow; there is no DSL, no parsed policy file, no cross-project rule reuse.

**Gap** 🟡: users who want to define per-project allow-lists currently have to code per-case in the permission handler. A lean DSL is a genuine capability addition.

**Proposed TS layout** (Stream C, paired with keyring):

- `packages/opencode/src/permission/dsl/parser.ts` — a JSON5/YAML schema (not Lisp — idiom mismatch) with `allow`, `deny`, `ask` rules matching `executable` + `args.pattern` + `cwd.under`.
- `packages/opencode/src/permission/dsl/policy.ts` — policy representation.
- `packages/opencode/src/permission/dsl/check.ts` — runtime check, called from `permission` before prompting the user.
- `packages/opencode/src/permission/dsl/rule.ts` — rule model.

**Effort:** L (~2 weeks for parser + policy + check + amend; reuse existing permission handler).

---

### 3.11 OS-level sandboxing

**Rust source:**
- `codex-rs/linux-sandbox/` — Landlock-based Linux sandbox.
- `codex-rs/windows-sandbox-rs/` — Windows AppContainer / WDAC.
- `codex-rs/core/src/sandboxing/` — 1,789 LOC. `mod.rs` (746) + `macos_permissions.rs` (154) + tests. Hosts seatbelt integration.
- `codex-rs/core/seatbelt_base_policy.sbpl` / `seatbelt_network_policy.sbpl` — macOS seatbelt policy files.
- `codex-rs/core/src/windows_sandbox*.rs` (1,200+ LOC) — Windows-side driver.
- `codex-rs/process-hardening/` — pre-exec hardening (close FDs, drop caps).

**Function:** OS-level sandboxing wraps every tool-executed process. macOS uses `sandbox-exec` with the bundled `.sbpl`. Linux uses Landlock via the `linux-sandbox` helper binary. Windows uses WDAC/AppContainer.

**TS today:** nothing. `packages/opencode/src/tool/bash.ts` uses `execa` without any sandbox wrap.

**Gap** 🟢: security-critical for aggressive-tool-use modes but opencode hasn't had sandbox-escape incidents in scope. Requires native helpers per platform — essentially impossible to ship from pure TS.

**Effort:** XL. Defer indefinitely; document as "use external sandbox (firejail, bwrap) via shell invocation if required".

---

### 3.12 Session-recorder + knowledge-base embeddings

**Rust source:** `codex-rs/session-recorder/src/` — 8,565 LOC.

- `recorder.rs` (691) — `SessionRecorder` with typed `SessionEvent { session_id, agent_id, timestamp, kind: EventKind, payload, model, duration_ms }`, background `record()` that drains into disk.
- `history.rs` (503), `compaction.rs` (423), `summarize.rs` (734), `stats.rs` (469).
- `knowledge_base.rs` (3,507) — on-disk KB shape, reads from session events.
- `kb_embedding_store.rs` (2,053), `kb_hybrid_search.rs` (1,009), `kb_utility_tracker.rs` (342) — embedding store + BM25 hybrid search + per-entry utility tracking.
- `kb_integration_tests.rs` (739).

**TS today:** `packages/opencode/src/history/` is the observation log. `packages/opencode/src/memory/` is codemem (different concern — defect sextuples, not session events). There is **no typed session-recorder**, **no KB embedding store**, **no hybrid BM25+embedding search**, **no per-entry utility tracker**.

**Gap** 🟡: if a user wants "find me the session where I fixed X", `history/search.ts` does substring only. KB-level semantic search is absent.

**Proposed TS layout** (Stream H — low priority):

- `packages/opencode/src/recorder/` — typed session event store mirroring `SessionEvent`.
- `packages/opencode/src/recorder/kb.ts` — KB storage model.
- `packages/opencode/src/recorder/kb-hybrid.ts` — hybrid search reusing the embedding client.
- `packages/opencode/src/recorder/utility.ts` — per-entry success rate tracker.

**Effort:** XL (~4 weeks). Defer until history/search becomes a stated bottleneck.

---

### 3.13 multi_agents tool family (async sub-agent surface)

**Rust source:** `codex-rs/core/src/tools/handlers/multi_agents/` + `multi_agents.rs`:

| File | LOC | Tool name | Function |
|---|---:|---|---|
| `multi_agents.rs` | 576 | dispatcher | Registers the 6 tools, dispatches to sub-files |
| `spawn.rs` | 265 | `task_spawn` / `task` (async variant) | Spawns a child; returns `agent_id` immediately without waiting |
| `wait.rs` | 366 | `task_wait` | Blocks current turn until one or more children complete; supports timeouts |
| `send_input.rs` | 163 | `task_send_input` | Enqueues a user message into a running child session |
| `close_agent.rs` | 172 | `task_close` | Cancels a child and releases its lease |
| `list_agents.rs` | 138 | `task_list` | Returns the live set of child sessions with status |
| `resume_agent.rs` | 163 | `task_resume` | Restarts a closed child from rollout |

**Core integration** (`core/src/codex.rs:7145-7160`): `auto_wait_for_active_children` is called inside the parent turn loop before the final `break`. If any child is still running, the parent turn is held open while the child's `Stop`/`SubagentStop` hooks fire; the parent then rejoins and receives the child's final assistant message as synthetic context.

**TS today:**
- `packages/opencode/src/subagent/registry.ts` (283) — has the data structures (`Registry.register`, `list`, `cancel`, `wait`) but nothing exposes them as tools.
- `packages/opencode/src/tool/task.ts` (363) — synchronous task tool (blocks parent turn during child execution).
- `packages/opencode/src/subagent/guardian.ts` (216) — reviewer model for child approvals, already scaffolded.

**Gap** 🔴: the registry exists without model-facing tools. Five of the six Rust tools are missing. `auto_wait_for_active_children` is not in `SessionPrompt.runLoop`. Parents cannot spawn async children today.

**Proposed TS layout** (Stream B):

- `packages/opencode/src/tool/task.ts` — extend with `mode: "sync" | "async"` parameter; when `async`, register with `subagent/registry.ts` and return `{agent_id, status: "running"}` immediately.
- `packages/opencode/src/tool/task-wait.ts` — new tool binding to `registry.wait(ids, timeoutMs)`.
- `packages/opencode/src/tool/task-send-input.ts` — bind to `Session.appendUserText(childID, text)` for the registered child.
- `packages/opencode/src/tool/task-close.ts` — bind to `registry.cancel(id)`.
- `packages/opencode/src/tool/task-list.ts` — bind to `registry.list()`.
- `packages/opencode/src/tool/task-resume.ts` — (optional, depends on rollout port).
- `packages/opencode/src/session/prompt.ts` — before the final `break`, call `registry.autoWaitForActiveChildren(sessionID, {pollMs: 250})`.
- Tool registry: add the 5 new tools to the exposed list when `agent.async_children === true` config flag is set.

**Effort:** L (~2 weeks). Registry + guardian scaffolding already exists; this is surface-and-glue work.

---

### 3.14 Rust-only Copilot functions not represented in TS

From `codex-rs/github-copilot/src/` (4,966 LOC total), functions that have **no TS counterpart**:

| Rust function | Location | TS status |
|---|---|:---:|
| `check_account_statuses()` | `lib.rs:212` | 🔴 missing. Does auth/rate/network triage per account, returns a status map. Fork's `accountStatus` (in `providers.ts`) is a narrower CLI helper. |
| `select_best_token()` | `lib.rs:269` | 🔴 missing. Startup-time quota-aware randomized pick across live accounts. |
| `migrate_opencode_to_copilot_cli()` | `lib.rs:157` | 🟡 partial. TS has the reverse migration (CLI → opencode); this is opencode → CLI. |
| `is_copilot_configured()` | `lib.rs:372` | 🟡 implicit via `CopilotAuth.list()`. |
| `remove_connection(key)` | `lib.rs:347` | 🟡 partial. TS has `state.delete` but no canonical CLI entry. |
| `CopilotError::is_auth_error` / `is_rate_limited` / `is_network_error` | `error.rs:30,38,48` | 🔴 missing. TS does ad-hoc status checks; no typed triage. |
| `fetch_account_model_catalog_with_discovery_via_proxy()` | `models.rs:455` | 🟡 partial. TS has catalog fetch but no proxy-aware variant. |
| `best_per_vendor()` | `models.rs:92` | 🔴 missing. Ranked-by-vendor catalog view for UI. |
| `retain_for_plan()` | `models.rs:174` | 🔴 missing. Plan-gated catalog filtering. |
| `CopilotConnections::get_next_available_connection()` | `connections.rs:290` | 🟡 partial. TS has `state.next` but no "next available" alternate lookup. |
| `get_available_alternate_connection()` / `select_available_alternate_connection()` | `connections.rs:300,309` | 🔴 missing. Fallback-alt-account for primary failure. |
| `fetch_user_quota()` | `quota.rs:99` | 🟡 partial. TS `fetchQuota` fetches premium quota only; Rust `fetch_user_quota` also returns `UserQuotaInfo` with full plan details. |
| `aggregate_quota()` | `quota.rs:215` | 🔴 missing. Cross-account aggregate used by TUI. |
| `export_accounts()` / `import_accounts()` / `export_to_json()` / `import_from_json()` | `transfer.rs:120,170,156,250` | 🔴 missing. Account bundle export/import. 484 LOC. |
| `BlackbirdClient::is_repo_indexed()` / `format_search_results()` | `blackbird.rs:318,342` | 🟡 partial. TS blackbird.ts exists but may not have these two helpers. |
| `normalize_embedding()` | `blackbird.rs:360` | 🟡 partial if blackbird port is complete. |

**Priority** 🟡: these are polish items on the Copilot surface. Most useful: `is_auth_error/is_rate_limited/is_network_error` triage, `retain_for_plan` + `best_per_vendor` for correct catalog display, `export_accounts/import_accounts` for multi-machine setup.

**Effort** (roll into Stream F): ~½ week total if done in one sweep.

---

### 3.15 Skill features not covered in R2

R2 (autoskill) ported extractor, evolution, injection, hook, bm25, env-deps, retrieval (~2,580 LOC). Remaining Rust skills code:

| File | LOC | Status | Rationale |
|---|---:|:---:|---|
| `skills/router.rs` | 1,591 | 🔴 missing | Memento-style RRF + Boltzmann routing policy over BM25 + dense embedding + utility signals. Implements Eq. 4 of the Memento paper (`π(d|q) = exp(Q(q,d)/τ) / Σ exp(Q(q,d')/τ)`). |
| `skills/builtin.rs` | 36 | 🔴 missing | 8 compiled-in skills via `include_str!`. Ship-with-the-binary starter set. |
| `skills/e2e_tests.rs` | 864 | 🔴 missing | Behavioral test harness for end-to-end skill flows — extraction → evolution → retrieval → execution. |
| `skills/router.rs` (specifically `sample_skill`) | — | 🔴 missing | Boltzmann sampler for exploration/exploitation trade-off. |
| `skills/remote.rs` | 252 | 🟡 unclear | Remote skill pack fetcher. May be partially covered by `skill/discovery.ts`'s URL paths. |
| `skills/manager.rs` | 579 | 🟡 partial | Cross-concern orchestrator — wired in TS via `skill/index.ts::Skill.Service`, likely not fully equivalent. |
| `skills/handler.rs` | 420 | 🟢 done | Model-facing `skill_search` + `skill_execute` tools — TS has `tool/skill-search.ts` + `tool/skill.ts`. |
| `skills/loader.rs` | 921 | 🟢 done | Filesystem walk — TS `skill/discovery.ts` + `skill/index.ts`. |
| `skills/invocation_utils.rs` | 236 | 🔴 missing | Implicit-invocation detection (shell commands running scripts under a skill's `scripts/` dir or `cat`-ing its `SKILL.md`). Used for usage-telemetry. |

**Priority**:
- **P0** — skill router (Memento RRF). Meaningfully better retrieval than BM25-only or embedding-only alone. Replace `SystemPrompt.recommend` internals.
- **P1** — skill builtin packs. 8 starter skills compiled in. Low-hanging fruit. Use `Bun.file` with build-time manifest.
- **P2** — e2e tests. Port alongside any meaningful skill change.
- **P3** — invocation_utils. Only useful once an "observability" story for skill telemetry exists.

**Effort** (Stream H — skills polish): L (~2 weeks for router + builtin + e2e tests).

---

### 3.16 Memory polish / refining step we skipped

**Rust file:** `codex-rs/core/src/memories/refining.rs` — 4-signal pure scorer + LLM polish step. (TS has `memory/refining.ts` 543 LOC, but it's unclear whether it implements the LLM-polish path or stops at the pure scorer.)

**Check needed:** diff `memory/refining.ts` against the Rust. If the LLM polish is not wired, the refining score is weaker than Rust.

**Memory ingestion orchestration:** `codex-rs/core/src/memories/start.rs` (102 LOC) — the boot orchestrator that decides whether to run Phase 1 / Phase 2 based on `MemoryTool.enabled`, ephemeral flag, and whether we're a sub-agent. TS equivalent: `memory/auto-trigger.ts` (156 LOC). Likely covers the decision tree but may miss the lease-3600 s + concurrency=8 semantics.

**Query synth:** `memory/query-synth.ts` (367) vs Rust `query_synth.rs` (446). Delta is ~80 LOC — likely missing fallback-query path, truncation helpers, or the robust JSON parser (direct → fenced → balanced).

**Gap** 🟡: polish, not correctness. Audit + small patches.

**Effort:** M (~1 week audit + patches).

---

### 3.17 Autobest Step E and missing LLM steps

**R1 §3.2** called out Rust's A → B → C → D pipeline. The TS `autobest/steps.ts` (318 LOC) and `autobest/llm-extract.ts` (262 LOC) together cover Step A. Gaps remaining:

- **Step B (compact plan-check)**: `autobest/compact-stub.ts` (199 LOC) exists but is named *stub* — it does not actually read the compact-state to find `next_unfinished_plan_item`. Needs wiring to `packages/opencode/src/session/compaction.ts`.
- **Step C (what's next?)** and **Step D (where is the plan? / terminate)**: per `autobest/steps.ts`, may be partially present. Audit required.
- **No Step E in Rust.** The R1 plan's "A-D" was complete; the user's question 15 asked whether we called A-D but Rust has more steps. Verification: `rg 'AutobestStep' codex-rs/core/src/autobest_extract.rs` shows `StepA, StepB, StepC, StepD` and no `StepE`. The audit confirms **no additional step** was missed.
- **Cycle flags** (`what_next_asks_used_this_cycle`, `where_is_plan_asks_used_this_cycle`): need verification in `autobest/index.ts` state model.
- **13 config knobs + 13 counters**: need verification per `config/config.ts` + `analytics`.

**Gap** 🟡: Step B is the biggest hole. Step B requires the compact state to be a real primitive, which the fork has under `session/compaction.ts` — so the wiring is the only missing piece.

**Effort:** M (~1 week for Step B wiring + cycle-flag audit + 13-counter addition).

---

### 3.18 Session model drift (codex_thread.rs vs Session.Info)

**Rust** `codex-rs/core/src/codex_thread.rs` (334 LOC) + `codex.rs` (9,057 LOC) carry a large `Session` struct with these fields not obviously mirrored in TS `Session.Info`:

- `rollout_path: Option<PathBuf>` — path to the session's rollout file. (TS has `history/<sessionID>.jsonl` but it's an observation log, not a rollout.)
- `out_of_band_elicitation_count: Mutex<u64>` — counter for async user-input requests.
- `autosteering_stagnation_count: AtomicU32` — per-session stagnation counter.
- `what_next_asks_used_this_cycle` / `where_is_plan_asks_used_this_cycle` — autobest cycle state.
- `parent_thread_id: Option<ThreadId>` — for nested sub-agents.
- `sub_agent_depth: Option<u32>` — for depth-limit enforcement.
- `active_children: Vec<ChildHandle>` — registry of running async children (TS has this in `subagent/registry.ts` but keyed globally, not per-session).
- `thread_runtime_snapshot: ThreadRuntimeSnapshot` — frozen config at session creation.
- `state_db: StateDbHandle` — reference to the shared SQLite state DB (used for jobs, leases).
- `watch_registration: WatchRegistration` — file-watcher lease.

**Check needed:** `packages/opencode/src/session/session.ts::Session.Info` schema. If these fields aren't present, the TS session cannot fully represent the Rust semantics.

**Gap** 🟡: each field maps to a feature that may or may not be ported. `rollout_path` → §3.9 rollout. `out_of_band_elicitation_count` → ACP (§3.5). `autosteering_stagnation_count` → already in `session/adaptive.ts`. `parent_thread_id` / `sub_agent_depth` → subagent (missing depth limit in TS registry).

**Effort:** S (1-2 days audit + schema extension).

---

## 4. Proposed R6 stream assignments (8 parallel streams)

Each stream's files are disjoint so they can run concurrently without merge conflicts. Each stream lands a separate worktree and a separate PR.

### Stream A — Hooks system (🔴 critical)

**Owner files:**
- `packages/opencode/src/hook/types.ts` (new)
- `packages/opencode/src/hook/registry.ts` (new)
- `packages/opencode/src/hook/command.ts` (new)
- `packages/opencode/src/hook/dispatch.ts` (new)
- `packages/opencode/src/hook/schema.ts` (new)
- `packages/opencode/src/config/config.ts` (extend `experimental.hooks`, keep `stopHooks` alias)
- `packages/opencode/src/session/prompt.ts` (replace inline `stopHooks` path with `Hook.Service.dispatch("Stop", payload)`)
- `packages/opencode/src/tool/registry.ts` (add `PreToolUse` / `PostToolUse` / `PostToolUseFailure` dispatch)
- `packages/opencode/src/session/session.ts` (add `SessionStart` / `SessionEnd` dispatch)
- `packages/opencode/src/session/compaction.ts` (add `PreCompact` dispatch)
- `packages/opencode/src/subagent/registry.ts` (add `SubagentStart` / `SubagentStop` dispatch)
- `packages/opencode/test/hook/**/*.test.ts` (new)

**Priority:** 🔴. **Effort:** L (2-3 weeks).

---

### Stream B — multi_agents async tool family (🔴 critical)

**Owner files:**
- `packages/opencode/src/tool/task.ts` (extend with `mode` param)
- `packages/opencode/src/tool/task-wait.ts` (new)
- `packages/opencode/src/tool/task-send-input.ts` (new)
- `packages/opencode/src/tool/task-close.ts` (new)
- `packages/opencode/src/tool/task-list.ts` (new)
- `packages/opencode/src/subagent/registry.ts` (add `autoWaitForActiveChildren`, `wait(ids, timeoutMs)`, depth-limit enforcement)
- `packages/opencode/src/session/prompt.ts` (call `registry.autoWaitForActiveChildren` before `break`)
- `packages/opencode/src/session/session.ts` (add `parent_thread_id`, `sub_agent_depth` to `Session.Info`)
- `packages/opencode/src/config/config.ts` (add `agent.async_children` flag, `agent.max_subagent_depth`)
- `packages/opencode/test/tool/task-async.test.ts` (new)
- `packages/opencode/test/subagent/registry-autowait.test.ts` (new)

**Priority:** 🔴. **Effort:** L (2 weeks).

---

### Stream C — Exec-policy DSL + Keyring credential store (🟡 capability)

**Owner files:**
- `packages/opencode/src/permission/dsl/parser.ts` (new)
- `packages/opencode/src/permission/dsl/policy.ts` (new)
- `packages/opencode/src/permission/dsl/check.ts` (new)
- `packages/opencode/src/permission/dsl/rule.ts` (new)
- `packages/opencode/src/permission/index.ts` (integrate DSL check before prompt)
- `packages/opencode/src/auth/keyring.ts` (new)
- `packages/opencode/src/auth/index.ts` (optional keyring backend)
- `packages/opencode/src/config/config.ts` (`permission.policyFile`, `auth.useKeyring`)
- `packages/opencode/test/permission/dsl.test.ts` (new)
- `packages/opencode/test/auth/keyring.test.ts` (new)

**Priority:** 🟡. **Effort:** L + S (~2 weeks + ½ day).

---

### Stream D — Connectors + apps directory (🟢 product-scope)

**Owner files:**
- `packages/opencode/src/connectors/index.ts` (new)
- `packages/opencode/src/connectors/directory.ts` (new)
- `packages/opencode/src/connectors/cache.ts` (new)
- `packages/opencode/src/session/apps.ts` (new — system prompt renderer)
- `packages/opencode/src/session/prompt.ts` (parse `[$app](app://id)` mentions)
- `packages/opencode/test/connectors/directory.test.ts` (new)

**Priority:** 🟢. **Effort:** M (~1 week). Skippable for non-ChatGPT users.

---

### Stream E — ACP server feature parity (🟡 capability)

**Owner files:**
- `packages/opencode/src/acp/agent.ts` (audit + extend)
- `packages/opencode/src/acp/elicitation.ts` (new — out-of-band user-input protocol)
- `packages/opencode/src/acp/replay.ts` (new — depends on Stream G rollout)
- `packages/opencode/src/acp/plan-mode.ts` (new)
- `packages/opencode/test/acp/elicitation.test.ts` (new)

**Priority:** 🟡. **Effort:** L (~2 weeks). Prerequisite: ½-day audit of Rust ACP methods vs TS.

---

### Stream F — Low-level HTTP stack + Copilot residuals (🟡)

**Owner files:**
- `packages/opencode/src/transport/custom-ca.ts` (new)
- `packages/opencode/src/transport/rate-limit-stats.ts` (new)
- `packages/opencode/src/transport/retry.ts` (new)
- `packages/opencode/src/plugin/github-copilot/copilot.ts` (replace local retry with shared util; add typed `CopilotError::is_auth_error` / `is_rate_limited` / `is_network_error`)
- `packages/opencode/src/plugin/github-copilot/models.ts` (add `retain_for_plan`, `best_per_vendor`)
- `packages/opencode/src/plugin/github-copilot/transfer.ts` (new — export/import accounts)
- `packages/opencode/src/cli/cmd/providers.ts` (add `transfer-export` / `transfer-import` subcommands)
- `packages/opencode/test/plugin/github-copilot/transfer.test.ts` (new)
- `packages/opencode/test/transport/retry.test.ts` (new)

**Priority:** 🟡. **Effort:** L (~2 weeks).

---

### Stream G — Rollout / replay (🟡 foundation)

**Owner files:**
- `packages/opencode/src/rollout/recorder.ts` (new)
- `packages/opencode/src/rollout/metadata.ts` (new)
- `packages/opencode/src/rollout/list.ts` (new)
- `packages/opencode/src/rollout/session-index.ts` (new)
- `packages/opencode/src/rollout/truncation.ts` (new)
- `packages/opencode/src/rollout/policy.ts` (new)
- `packages/opencode/src/rollout/error.ts` (new)
- `packages/opencode/src/session/session.ts` (add `rollout_path` to `Session.Info`)
- `packages/opencode/src/session/prompt.ts` (write to rollout on each model/tool event)
- `packages/opencode/test/rollout/**/*.test.ts` (new)

**Priority:** 🟡. **Effort:** XL (~3 weeks). Enables Stream E's `replay.ts`.

---

### Stream H — Skill router + builtin + e2e + memory/autobest polish (🟡)

**Owner files:**
- `packages/opencode/src/skill/router.ts` (new — Memento RRF + Boltzmann)
- `packages/opencode/src/skill/builtin/` (new dir — 8 starter skills)
- `packages/opencode/src/skill/builtin.ts` (new — embed via Bun manifest)
- `packages/opencode/src/skill/invocation-utils.ts` (new — implicit-invocation telemetry)
- `packages/opencode/src/memory/refining.ts` (audit + add LLM polish step if missing)
- `packages/opencode/src/memory/query-synth.ts` (audit + add robust JSON parser fallback)
- `packages/opencode/src/autobest/compact-stub.ts` → rename `compact.ts`; wire to `session/compaction.ts`
- `packages/opencode/src/autobest/steps.ts` (add Step C / Step D cycle-flag audit)
- `packages/opencode/src/autobest/index.ts` (add cycle flags to state)
- `packages/opencode/test/skill/router.test.ts` (new)
- `packages/opencode/test/skill/e2e.test.ts` (new — port from Rust `e2e_tests.rs`)
- `packages/opencode/test/autobest/compact.test.ts` (new)

**Priority:** 🟡. **Effort:** L (~2 weeks).

---

### Deferred (not assigned to R6 streams)

- **Cloud-tasks + backend-client** — XL; defer until ChatGPT-backend parity becomes a product goal.
- **app-server JSON-RPC + in-process transport** — XL; defer until Rust-client interop is a requirement.
- **Network-proxy + MITM** — XL; defer until audit/allow-list enforcement becomes a product requirement.
- **OS-level sandboxing** — XL; defer indefinitely (requires per-platform native helpers).
- **Session-recorder KB** — XL; defer until `history/search.ts` is a stated bottleneck.
- **codex-api provider abstraction** — AI-SDK replaces it; skip.

---

## 5. Risk & dependency graph

```
Stream A (Hooks) ──┐
                   ├─► enables tool + session + subagent observability
Stream B (multi_agents) ─► depends on existing subagent/registry.ts, guardian.ts
                         ─► enables Stream A's SubagentStart/Stop dispatch
Stream C (DSL+Keyring) ── standalone
Stream D (Connectors) ── standalone (low-priority)
Stream E (ACP parity) ── depends on Stream G (for replay.ts)
                      ── depends on Stream A (for elicitation hooks)
Stream F (HTTP+Copilot residuals) ── standalone
Stream G (Rollout) ───► enables Stream E (replay)
                    ───► enables Stream H (Step B compact wiring reads rollout)
Stream H (Skill/memory polish) ── depends on existing skill/ + memory/
                               ── Step B wiring depends on Stream G
```

### Parallelism matrix

| Stream | Can run alongside | Blocked by |
|---|---|---|
| A | B, C, D, F, G, H | — |
| B | A, C, D, E, F, G, H | — |
| C | A, B, D, E, F, G, H | — |
| D | A, B, C, E, F, G, H | — |
| E | A, B, C, D, F, H | G (for replay) |
| F | A, B, C, D, E, G, H | — |
| G | A, B, C, D, F, H | — |
| H | A, B, C, D, E, F, G | Step B wiring: G |

**All 8 streams can start in parallel** except Stream E's `replay.ts` task and Stream H's autobest-Step-B compact wiring, which both depend on Stream G's rollout landing first. Start-side: 8 parallel worktrees. Land-side: G lands before E/H finish.

### Risk register additions (supplementing R1 §5)

- **R13 — Hooks process-per-event cost.** Stream A's subprocess-per-hook model is expensive at 17 events × every tool call. Mitigation: batch hooks of the same event kind, maintain a persistent-hook-runner pool, or permit an in-process TS-function hook as an optimisation tier.
- **R14 — Async sub-agent orphans.** Stream B's `auto_wait_for_active_children` must cascade parent-fiber interrupt → registry.cancel → child scope close. Integration test before land.
- **R15 — DSL parser security.** Stream C's policy parser must refuse unbounded-regex rules; use Timed regex evaluator to prevent ReDoS.
- **R16 — Keyring not-available fallback.** Stream C must not *require* keytar; a CI / Linux-headless environment should transparently fall through to file storage with a log warning.
- **R17 — Rollout disk cost.** Stream G's rollout doubles disk usage for every session. Ship with gzip + a `rollout.retention_days` config knob (default 30 days).
- **R18 — Stream H skill router changes retrieval outcomes.** Users may observe different skills being auto-suggested. Gate behind `skills.router.kind: "bm25"|"rrf"|"boltzmann"` config (default `bm25` for parity with current behavior; flip to `rrf` in a follow-up after validation).

---

## 6. Open questions / deferrals

1. **Cloud-tasks:** product decision needed — is ChatGPT-backend task parity a goal? If yes, open a dedicated project (Stream I) and generate the TS client from the already-existing `codex-rs/codex-backend-openapi-models/` OpenAPI spec.
2. **app-server JSON-RPC:** is there a downstream consumer (Zed, Cursor extension, VS Code) that needs JSON-RPC specifically? If no, skip indefinitely.
3. **Rust commit drift:** the R1 plan acknowledged ~153 commits of drift. This R6 pass was done against the current HEAD; feature line numbers may decay again. Suggest re-audit after the 8 R6 streams land (est. 2026-06).
4. **OS sandboxing:** document the recommended "outer sandbox" pattern (firejail on Linux, sandbox-exec on macOS, JobObject on Windows) so users don't expect OS-level enforcement from opencode itself.
5. **Skill router rollout:** validate Memento RRF retrieval quality on real skill corpora before defaulting; the LLM-free BM25 path may outperform RRF on small skill sets (< 50 skills).
6. **Session model drift:** run a field-by-field diff of `Session.Info` (TS) vs the Rust `Session` struct after Stream B + Stream G land. Some fields (e.g. `state_db`, `watch_registration`) are transport/runtime concerns and may never need TS parity; others (e.g. `sub_agent_depth`) are semantic and must be added.

---

*End of R6 addendum. Source reports: R1 = `codex-rs-migration-plan.md`; R1-R5 delta = `opencode-fork-additions.md`; per-feature comparisons at `/tmp/compare-*.md`. Rust audit target: `codex-rs/` at `/Volumes/external/sources/codex_git/codex-rs/` on 2026-04-17.*
