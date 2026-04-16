# codex_git feature gap status

## Done in this worktree

- Thread/turn compat router exists in `src/server/instance/thread.ts`.
- Covered thread aliases:
  - `GET /thread`
  - `GET /thread/:threadID`
  - `POST /thread/start`
  - `POST /thread/:threadID/fork`
  - `POST /thread/:threadID/setName`
- Covered turn aliases:
  - `POST /turn/start`
  - `POST /turn/interrupt`
  - `POST /turn/steer`
- Covered request aliases:
  - `GET /thread/:threadID/request_permissions`
  - `GET /thread/:threadID/request_user_input`
  - `POST /thread/:threadID/request_user_input/:requestID/reply`
- Covered autobest aliases:
  - `POST /thread/:threadID/autobest/setActive`
  - `POST /thread/:threadID/autobest/extract`
- Autobest runtime/history wiring is already implemented:
  - durable history events `autobest.enabled` and `autobest.result`
  - completion-boundary autofire at `runLoop()`
- `src/v2/session-entry.ts` already supports `plan` entries/events.

## Remaining parity work

### 1. output_schema compat on turn start

Missing compat translation for upstream per-turn `outputSchema` / `output_schema` on `POST /turn/start`.

Local runtime already supports structured output through:

- `src/session/message-v2.ts`
- `src/session/prompt.ts`

What is missing is the compat boundary mapping into local:

- `format: { type: "json_schema", schema }`

Files:

- `src/server/instance/thread.ts`
- `test/server/thread-turn-compat.test.ts`

### 2. request_permissions reply compat

Missing thin compat alias for:

- `POST /thread/:threadID/request_permissions/:requestID/reply`

Preferred implementation:

- keep `src/permission/index.ts` unchanged
- add route-level ownership check by `threadID`
- map compat payload at the HTTP boundary only

Files:

- `src/server/instance/thread.ts`
- `test/server/thread-request-compat.test.ts`

### 3. richer thread lifecycle parity

Smallest grounded next handlers:

- `POST /thread/:threadID/archive`
- `POST /thread/:threadID/unarchive`

Follow-up coverage:

- archive/unarchive roundtrip test
- archived list/filter parity test
- add a smoke test for existing `POST /turn/steer`

Files:

- `src/server/instance/thread.ts`
- `test/server/thread-turn-compat.test.ts`

## Not planned for this wave

### Full SessionV2 integration

`src/v2/*` should stay experimental for now instead of becoming the main runtime surface.

Reason:

- it still drifts from live `MessageV2` and session runtime shapes
- tool state shape differs
- timing fields differ
- assistant content union is narrower than the live runtime

So the next safe direction is either:

- explicit experimental positioning
- or a separate deliberate migration wave

but not more half-port integration.

## Right-panel and monitoring follow-up

Next status/monitoring fields worth adding after parity work:

- thread/session status
- autobest enabled/result
- pending permission count
- pending user-input count
- provider/account route
- quota and rate-limit snapshot
- archived state / turn activity markers

Likely TUI files:

- `src/cli/cmd/tui/context/sync.tsx`
- `src/cli/cmd/tui/plugin/api.tsx`
- `src/cli/cmd/tui/routes/session/sidebar.tsx`
- `src/cli/cmd/tui/feature-plugins/sidebar/*.tsx`
