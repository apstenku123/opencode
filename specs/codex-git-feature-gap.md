# codex_git -> opencode feature gap and port backlog

## Goal

Track the highest-value features present in `../codex_git` that are not yet fully ported into `opencode`, with concrete source surfaces, likely target surfaces, priority, risk, and recommended port order.

This document is intentionally practical: it is not a generic architecture essay. It is a port backlog.

---

## Status legend

- **ported**: feature is present in `opencode` at roughly sufficient depth
- **partial**: some substrate exists, but `codex_git` is materially richer
- **missing**: no comparable productized feature found in `opencode`
- **reject/late**: intentionally defer or skip unless a stronger need appears

---

## Current summary

### Already in decent shape in `opencode`

- GitHub Copilot providers/auth/routing/tests
- migration-aware providers CLI output
- basic session fork/summary/compaction substrate
- basic skill loading/usage substrate
- basic subagent/permission flow

### Biggest missing areas relative to `../codex_git`

1. richer persisted history/session replay substrate
2. learn-from-history / memcoder-style memory pipeline
3. KB / retrieval / embeddings / hybrid search
4. richer skill platform (search, metadata, deps, inject/eject, remote ops)
5. hook-visible subagent/session policy + execpolicy
6. autobest / next-best-step extraction

---

## Feature gap table

| Feature | codex_git source | opencode target | Status | Priority | Risk | Why it matters |
|---|---|---|---|---|---|---|
| Persisted thread/session replay | `codex-rs/acp-server/src/lib.rs`, `codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts`, `codex-rs/core/tests/suite/resume.rs` | `packages/opencode/src/session/*`, `packages/opencode/src/storage/*`, possibly new protocol surfaces under `packages/opencode/src/server/*` or app/session API | partial | P1 | high | foundation for resume, richer history, later memory/KB work |
| Fork lineage + rollback | `codex-rs/protocol/src/protocol.rs` | `packages/opencode/src/session/index.ts`, session protocol/schema surfaces | partial | P1 | medium | enables safer session editing and history-aware workflows |
| Session recording / rollout JSONL | `README-FORK.md`, `CHANGELOG-FORK.md`, resume/sqlite tests | `.omx/logs`, `packages/opencode/src/session/*`, possibly new recorder module | partial | P1 | medium | needed for durable audit trail and learn-from-history ingestion |
| Learn-from-history memory pipeline | `codex-rs/core/templates/memories/stage_one_input.md`, `consolidation.md` | new `packages/opencode/src/memory/*` or `packages/opencode/src/history/*` plus `.omx` integration | missing | P1 | medium | converts prior successful work into reusable guidance |
| Memory retrieval / memcoder substrate | `codex-rs/core/src/memories/retrieval.rs`, `query_synth.rs`, `refining.rs`, `storage.rs`, `commit_crawler.rs`, `foreign_ingest/*` | new `packages/opencode/src/memory/*` | missing | P1 | high | lets the agent retrieve relevant prior fixes instead of relying on prompt stuffing |
| KB builder | `codex-rs/session-recorder/src/knowledge_base.rs` | new `packages/opencode/src/kb/*` | missing | P1 | medium | creates a searchable local knowledge layer from sessions/docs |
| BM25/hybrid KB search | `codex-rs/session-recorder/src/kb_hybrid_search.rs`, `kb_embedding_store.rs`, `kb_utility_tracker.rs`, `codex-rs/core/src/tools/handlers/search_tool_bm25.rs` | new `packages/opencode/src/kb/*`, tool integration in `packages/opencode/src/tool/*` | missing | P1 | high | unlocks doc/history retrieval without external infra |
| TUI/CLI KB browsing | `codex-rs/tui/src/kb_browse.rs`, `history_browse.rs` | `packages/opencode/src/cli/cmd/tui/*`, new CLI commands | missing | P2 | medium | gives user-facing access to the KB |
| Skill discovery/list/search | `codex-rs/app-server/src/skill_api.rs`, `SkillsList*.ts`, `SkillsSearch*.ts`, `docs/skills.md` | `packages/opencode/src/skill/*`, `packages/opencode/src/session/system.ts`, TUI/CLI skill commands | partial | P1 | medium | current opencode skill surface is much thinner |
| Skill metadata/interface/scope | `SkillMetadata.ts`, `SkillInterface.ts`, `SkillScope.ts` | `packages/opencode/src/skill/*` | missing | P1 | medium | needed for proper discovery, ranking, enable/disable UX |
| Skill dependencies / MCP requirements | `codex-rs/core/src/mcp/skill_dependencies.rs`, `SkillDependencies.ts`, `SkillToolDependency.ts` | `packages/opencode/src/skill/*`, `packages/opencode/src/mcp/*` | missing | P1 | medium | allows dependable skill execution and install/login prompts |
| Session inject/eject skills | `SessionInjectSkill*.ts`, `SessionListInjectedSkillsResponse.ts`, `SessionEjectSkillResponse.ts` | session/runtime skill registry under `packages/opencode/src/session/*` and `packages/opencode/src/skill/*` | missing | P2 | medium | useful for ephemeral task-local workflows |
| Skill remote read/write/config ops | `SkillsRemoteRead*.ts`, `SkillsRemoteWrite*.ts`, `SkillsConfigWrite*.ts` | `packages/opencode/src/skill/*`, app/server surfaces if needed | missing | P2 | medium | enables richer skill library management |
| Skill creator scaffold | `codex-rs/skills/src/assets/samples/skill-creator/SKILL.md`, `scripts/init_skill.py` | `.opencode` / skill command surfaces / `packages/opencode/src/skill/*` | missing | P2 | low | easiest path to practical “automated skill builder” |
| Auto-extracted skills | `docs/skills.md`, `codex-rs/core/src/skills/*` | `packages/opencode/src/skill/*`, future memory integration | missing | P3 | high | powerful, but only after history/memory foundation is real |
| Hook-visible `agent_level` + session context | `codex-rs/hooks/src/types.rs`, `codex-rs/protocol/src/protocol.rs`, `SubAgentSource.ts` | `packages/opencode/src/tool/*`, `packages/opencode/src/agent/*`, hook/plugin APIs | missing | P2 | high | needed for deterministic subagent-aware policy |
| Hook-driven pre/post tool rewrite/blocking | `codex-rs/core/src/tools/registry_fork.rs`, `codex-rs/hooks/src/types.rs` | tool registry / plugin/hook layer in `packages/opencode/src/tool/*` | missing | P2 | high | enables policy, safety, and workflow shaping without hardcoding |
| PermissionRequest hook decisions | `codex-rs/core/src/tools/handlers/request_permissions.rs` | permission flow in `packages/opencode/src/permission/*` and TUI prompts | missing | P2 | medium | makes approval flow programmable |
| Exec policy engine | `codex-rs/core/src/exec_policy.rs`, `process_manager.rs` | exec/bash tool surfaces in `packages/opencode/src/tool/*` or `packages/opencode/src/command/*` | partial | P2 | high | more deterministic command policy than coarse approvals |
| Inherited exec policy for subagents | `codex-rs/core/src/agent/control.rs` | `packages/opencode/src/agent/*`, subagent spawn flow | missing | P2 | medium | keeps child agents under parent command policy |
| Subagent lifecycle hooks | `codex-rs/hooks/src/types.rs`, multi-agent spawn/close handlers | `packages/opencode/src/agent/*` and hooks/plugin layer | missing | P2 | medium | observability and policy hooks for agent lifecycle |
| Autobest / next-best-step extraction | `ThreadAutobestExtractParams.ts` and related runtime support | future session/history module, maybe `packages/opencode/src/session/*` | missing | P3 | medium | high-level UX feature built on rich history |

---

## Recommended port order

### Wave 1: history foundation

1. persisted session/thread replay substrate
2. richer session recording / rollout artifacts
3. fork lineage + rollback semantics

### Wave 2: memory / learn-from-history

4. memory storage schema
5. retrieval pipeline
6. query synth / refine / rerank flow
7. history-to-memory consolidation workflow

### Wave 3: KB

8. KB builder from local session/docs artifacts
9. BM25 search
10. embedding/hybrid search
11. tool + TUI/CLI KB access

### Wave 4: skills

12. skill metadata/interface/scope model
13. skill discovery/search/ranking
14. skill dependency model
15. session inject/eject skills
16. skill creator scaffold
17. optional auto-extracted skills

### Wave 5: policy/orchestration

18. hook-visible `agent_level` and session context
19. pre/post tool hook rewrite/blocking surfaces
20. execpolicy + inherited child-agent policy
21. optional autobest

---

## Practical backlog

### 1. History substrate parity doc
- **Feature:** persisted thread/session replay
- **Source:** `codex-rs/acp-server/src/lib.rs`, `codex-rs/app-server-protocol/schema/typescript/v2/Thread.ts`, `codex-rs/core/tests/suite/resume.rs`
- **Target:** `packages/opencode/src/session/*`, `packages/opencode/src/storage/*`
- **Why:** all later history/memory work depends on durable session replay
- **Risk:** high
- **Order:** 1

### 2. Rollout/session recording
- **Feature:** durable JSONL-style session recording
- **Source:** `README-FORK.md`, `CHANGELOG-FORK.md`, related resume/sqlite tests in `codex-rs/core/tests/suite/*`
- **Target:** `.omx/logs` integration + `packages/opencode/src/session/*`
- **Why:** provides source material for history learning and debugging
- **Risk:** medium
- **Order:** 2

### 3. Rollback/fork lineage
- **Feature:** explicit conversation rollback + richer fork lineage
- **Source:** `codex-rs/protocol/src/protocol.rs`
- **Target:** `packages/opencode/src/session/index.ts`
- **Why:** safe editable history and lineage-aware workflows
- **Risk:** medium
- **Order:** 3

### 4. Memory storage substrate
- **Feature:** reusable memory records for prior fixes and sessions
- **Source:** `codex-rs/core/src/memories/storage.rs`, `commit_crawler.rs`
- **Target:** new `packages/opencode/src/memory/*`
- **Why:** needed before retrieval becomes meaningful
- **Risk:** medium
- **Order:** 4

### 5. Memory retrieval
- **Feature:** retrieve similar prior fixes / sessions
- **Source:** `codex-rs/core/src/memories/retrieval.rs`
- **Target:** `packages/opencode/src/memory/retrieval.ts` (or equivalent)
- **Why:** this is the core of learn-from-history / memcoder utility
- **Risk:** high
- **Order:** 5

### 6. Query synthesis and refine/rerank
- **Feature:** synthesize and refine retrieval queries
- **Source:** `query_synth.rs`, `refining.rs`, templates under `codex-rs/core/templates/memories/*`
- **Target:** `packages/opencode/src/memory/*`, prompt/templates area
- **Why:** improves retrieval quality and keeps prompts compact
- **Risk:** medium
- **Order:** 6

### 7. Learn-from-history consolidation workflow
- **Feature:** convert rollouts/history into reusable memory docs or summaries
- **Source:** `stage_one_input.md`, `consolidation.md`
- **Target:** `.omx` workflows + new memory commands/helpers
- **Why:** this is the practical “learn from history” layer
- **Risk:** medium
- **Order:** 7

### 8. KB builder
- **Feature:** session/docs knowledge base generation
- **Source:** `codex-rs/session-recorder/src/knowledge_base.rs`
- **Target:** new `packages/opencode/src/kb/*`
- **Why:** creates a searchable local corpus without external infra
- **Risk:** medium
- **Order:** 8

### 9. BM25 KB search
- **Feature:** lexical KB retrieval
- **Source:** `codex-rs/core/src/tools/handlers/search_tool_bm25.rs`
- **Target:** `packages/opencode/src/tool/*` + `packages/opencode/src/kb/*`
- **Why:** simplest productizable KB access path
- **Risk:** medium
- **Order:** 9

### 10. Hybrid/embedding retrieval
- **Feature:** BM25 + embedding + utility rerank
- **Source:** `kb_hybrid_search.rs`, `kb_embedding_store.rs`, `kb_utility_tracker.rs`
- **Target:** `packages/opencode/src/kb/*`
- **Why:** improves recall/precision once KB exists
- **Risk:** high
- **Order:** 10

### 11. TUI/CLI KB surfaces
- **Feature:** browse/search KB and history
- **Source:** `codex-rs/tui/src/kb_browse.rs`, `history_browse.rs`
- **Target:** `packages/opencode/src/cli/cmd/*`, TUI routes/components
- **Why:** makes KB visible to users, not just internal retrieval
- **Risk:** medium
- **Order:** 11

### 12. Skill metadata model
- **Feature:** structured skill metadata/interface/scope
- **Source:** `SkillMetadata.ts`, `SkillInterface.ts`, `SkillScope.ts`
- **Target:** `packages/opencode/src/skill/*`
- **Why:** required for proper search, enable/disable, dependency handling
- **Risk:** medium
- **Order:** 12

### 13. Skill search/ranking
- **Feature:** skill discovery and routing support
- **Source:** `skill_api.rs`, `SkillsSearch*.ts`, `docs/skills.md`
- **Target:** `packages/opencode/src/skill/*`, `packages/opencode/src/session/system.ts`, TUI/CLI
- **Why:** moves opencode from “skills exist” to “skills are usable at scale”
- **Risk:** medium
- **Order:** 13

### 14. Skill dependencies
- **Feature:** MCP/tool requirements and install/login prompts
- **Source:** `skill_dependencies.rs`, `SkillDependencies.ts`, `SkillToolDependency.ts`
- **Target:** `packages/opencode/src/skill/*`, `packages/opencode/src/mcp/*`
- **Why:** avoids brittle skill execution
- **Risk:** medium
- **Order:** 14

### 15. Session inject/eject skills
- **Feature:** ephemeral task-local skills
- **Source:** `SessionInjectSkill*.ts`, `SessionEjectSkillResponse.ts`
- **Target:** session/runtime skill registry in `packages/opencode/src/session/*`
- **Why:** useful for dynamic workflows and temporary skill composition
- **Risk:** medium
- **Order:** 15

### 16. Skill creator scaffold
- **Feature:** practical automated skill builder starting point
- **Source:** `codex-rs/skills/src/assets/samples/skill-creator/SKILL.md`, `scripts/init_skill.py`
- **Target:** skill CLI surface in `packages/opencode/src/skill/*` or `.opencode` commands
- **Why:** lowest-risk route to “automated skill builder” value
- **Risk:** low
- **Order:** 16

### 17. Auto-extracted skills
- **Feature:** mint reusable skills from successful repeated workflows
- **Source:** `docs/skills.md`, `codex-rs/core/src/skills/*`
- **Target:** future skill/memory integration layer
- **Why:** powerful, but premature before history/memory are real
- **Risk:** high
- **Order:** 17

### 18. Hook-visible `agent_level` / session context
- **Feature:** root vs subagent aware hooks and policies
- **Source:** `codex-rs/hooks/src/types.rs`, `SubAgentSource.ts`, `protocol.rs`
- **Target:** `packages/opencode/src/tool/*`, `packages/opencode/src/agent/*`, plugin hooks
- **Why:** prerequisite for deterministic subagent-specific policy
- **Risk:** high
- **Order:** 18

### 19. Pre/post tool hook mutation/blocking
- **Feature:** block or rewrite tool calls/output via hooks
- **Source:** `registry_fork.rs`, hook types/dispatcher
- **Target:** tool registry in `packages/opencode/src/tool/*`
- **Why:** much stronger policy/workflow control than passive hooks
- **Risk:** high
- **Order:** 19

### 20. Execpolicy and inherited child-agent policy
- **Feature:** dedicated command policy engine with parent->child inheritance
- **Source:** `exec_policy.rs`, `process_manager.rs`, `agent/control.rs`
- **Target:** exec/bash tool stack + agent spawn flow
- **Why:** policy consistency and safer subagent execution
- **Risk:** high
- **Order:** 20

---

## Recommended first concrete implementation cut

Start with **history/memory substrate**, not KB and not auto-skill extraction.

Specifically:

1. design persisted session/thread replay model
2. add richer session recording artifacts
3. add rollback/fork lineage semantics
4. then build memory storage + retrieval on top

Only after that should we do KB, and only after KB/memory should we chase auto-generated skills.
