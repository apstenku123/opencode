# Commit Plan: Opencode + codex_git Cross-Fix Wave

## Repo 1: `/Volumes/external/sources/opencode`

### Commit A: shared synthetic-turn owner and timer inject alignment
- Scope:
  - `packages/opencode/src/session/adaptive.ts`
  - `packages/opencode/src/session/prompt.ts`
  - `packages/opencode/src/server/instance/session.ts`
  - `packages/opencode/test/session/adaptive.test.ts`
  - `packages/opencode/test/server/session-timer.test.ts`
  - `packages/opencode/test/session/prompt-effect.test.ts`
- Why:
  - establish one append/accounting owner for synthetic user turns
  - stop timer inject from bypassing the adaptive path
  - add explicit queue/trace instrumentation for arbitration/materialization
  - lock competing-injector behavior with deterministic and bounded trace-driven proofs
- Verification:
  - `cd packages/opencode && bun test test/session/adaptive.test.ts test/server/session-timer.test.ts test/session/prompt-effect.test.ts --timeout 30000`

### Commit B: memory foreign-ingest runtime detail seam
- Scope:
  - `packages/opencode/src/server/instance/memory.ts`
  - `packages/opencode/src/cli/cmd/memory.ts`
  - `packages/opencode/test/server/memory-routes.test.ts`
- Why:
  - land the correct parity seam: exact `tool + sourceID + gitRoot` session detail
  - avoid treating project-level `memory list` as the main parity target
- Verification:
  - `cd packages/opencode && bun test test/server/memory-routes.test.ts --timeout 30000`

### Commit B2: memory list introspection follow-up
- Scope:
  - `packages/opencode/src/server/instance/memory.ts`
  - `packages/opencode/src/cli/cmd/memory.ts`
  - `packages/opencode/test/server/memory-routes.test.ts`
- Why:
  - keep `memory list` as a deliberate local introspection surface
  - separate it from the narrower foreign-ingest parity seam so commit scope stays explicit
- Verification:
  - `cd packages/opencode && bun test test/server/memory-routes.test.ts --timeout 30000`

### Commit C: autobest durable source of truth and grounding proof
- Scope:
  - `packages/opencode/src/session/autobest.ts`
  - `packages/opencode/src/session/session.ts`
  - `packages/opencode/src/server/instance/session.ts`
  - `packages/opencode/test/session/autobest-history.test.ts`
  - `packages/opencode/test/session/history.test.ts`
  - `packages/opencode/test/server/session-actions.test.ts`
  - `packages/opencode/test/session/prompt-effect.test.ts`
- Why:
  - remove duplicate `autobest.result` persistence
  - keep one durable builder / source of truth
  - prove MCP/autobest grounding and cooldown semantics through the real session loop
  - prove bounded multi-producer trace materialization through the real session loop
- Verification:
  - `cd packages/opencode && bun test test/session/autobest-history.test.ts test/session/history.test.ts test/server/session-actions.test.ts test/session/prompt-effect.test.ts --timeout 30000`
  - `cd packages/opencode && bun typecheck`

## Repo 2: `/Volumes/external/sources/codex_git/codex-rs`

### Commit D: timer ownership cleanup in native thread model
- Scope:
  - `app-server-protocol/src/protocol/v2.rs`
  - `app-server/src/codex_message_processor.rs`
- Why:
  - make timer ownership explicit via `thread_id`
  - clear only owned timers on thread teardown
  - report owner in timer list and target owned thread on fire when available
- Verification:
  - `cd /Volumes/external/sources/codex_git/codex-rs && CARGO_TARGET_DIR=/tmp/codex-git-timer-check cargo check -p codex-app-server -p codex-app-server-protocol`
  - `cd /Volumes/external/sources/codex_git/codex-rs && CARGO_TARGET_DIR=/tmp/codex-git-timer-target cargo test -p codex-app-server --lib timer_tests -- --nocapture`

### Commit E: foreign-ingest exact-root session matching hardening
- Scope:
  - `app-server/src/codex_message_processor.rs`
- Why:
  - remove substring-based false positives in `getSessionDetail` / `listDone`-adjacent matching
  - preserve strong exact-root semantics
- Verification:
  - `cd /Volumes/external/sources/codex_git/codex-rs && cargo test -p codex-app-server resolve_foreign_done_ -- --nocapture`
  - `cd /Volumes/external/sources/codex_git/codex-rs && cargo test -p codex-app-server foreign_source_id_matches_path -- --nocapture`

### Commit F: native autobest history/readback strengthening
- Scope:
  - `app-server/tests/autobest_v2.rs`
- Why:
  - prove `session.getAutobestLog` matches emitted `autobest/decision`
  - strengthen existing native readback contract without adding new APIs
- Verification:
  - `cd /Volumes/external/sources/codex_git/codex-rs && cargo test -p codex-app-server --test autobest_v2 e2e_autobest_decision_notification_shape -- --ignored`

## Integration Notes
- Do not include `session instruction` / `skills.paths` overlay surfaces in cross-repo backport commits.
- Do not include `experimental resource/read` in backport commits.
- Keep commits narrow even if the worktree is dirty; stage only the files listed above.
