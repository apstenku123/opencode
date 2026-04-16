# opencode fork additions (unify/copilot-plan)

> Capability reference for everything the `apstenku123/opencode` fork adds on top of the
> upstream `anomalyco/opencode` release. This document covers the `unify/copilot-plan`
> branch (which merges `port/copilot-plan` and `wip/dev-copilot-nested`) against the
> `v1.4.7` baseline.

All paths below are relative to the repository root unless an absolute path is given.

## Table of contents

1. [Scope and branch topology](#scope-and-branch-topology)
2. [Copilot multi-account routing](#copilot-multi-account-routing)
3. [Autobest subsystem](#autobest-subsystem)
4. [History subsystem](#history-subsystem)
5. [Timer subsystem](#timer-subsystem)
6. [Thread and Turn HTTP routes](#thread-and-turn-http-routes)
7. [Server instance modifications](#server-instance-modifications)
8. [Server protocol additions](#server-protocol-additions)
9. [Sidebar Copilot TUI widget](#sidebar-copilot-tui-widget)
10. [Providers CLI changes](#providers-cli-changes)
11. [Configuration and environment variables](#configuration-and-environment-variables)
12. [Testing surface](#testing-surface)
13. [Known technical debt (`TODO(unify)`)](#known-technical-debt-todounify)
14. [Migration notes](#migration-notes)

---

## Scope and branch topology

The `unify/copilot-plan` branch was created to merge two earlier branches — a nested
Copilot dispatch rewrite (`wip/dev-copilot-nested`) and a feature port bringing autobest,
history, and timer work forward from `port/copilot-plan`. It diverges from the
`release: v1.4.7` commit (`9f201d637`).

Commits unique to this fork branch (`git log --oneline 9f201d637..unify/copilot-plan`):

| SHA (short) | Message |
| --- | --- |
| `56bc93a0d` | `fix(unify): patch scattered Effect R-channel drift in tests + app-runtime` |
| `9858c5469` | `fix(unify): github-copilot/copilot.ts Auth API + quota.ts typing` |
| `556d23544` | `fix(unify): stub history/index.ts type issues; skip history test pending Session.Interface autobest port` |
| `48f288bf9` | `fix(unify): drop duplicate ThreadRoutes wiring; point providers.ts to nested quota; skip providers-quota test` |
| `6c0c9b7c9` | `chore(unify): drop flat plugin/copilot-*.ts; skip providers-quota.test.ts pending API realignment` |
| `c31ad4ca3` | `fix(unify): align providers.ts with current auth/config/process API` |
| `56c0ea259` | `fix(unify): align server/instance/{session,index}.ts with current namespaces; stub autobest endpoints` |
| `167cdf4fd` | `fix(unify): align server/instance/{timer,thread}.ts with current runtime API` |
| `5ea2ef46c` | `fix(unify): easy typecheck fixes — imports aligned with current dev` |
| `be6bc2db1` | `merge: port/copilot-plan into unify — autobest, history, timer, copilot nested layout` |
| `ad483e648` | `merge: wip/dev-copilot-nested — copilot dispatch rewrite + thread/turn routes` |
| `3f170b032` | `wip: port copilot-plan — autobest, history, timer, copilot routing` |
| `4a96db395` | `wip: copilot nested-layout migration + thread/turn routes` |
| `b804debb3` | `Record current codex_git parity frontier` |
| `16538ae80` | `feat: implement Copilot model discovery, adaptive rate limiting, and persistent state tracking for hooks and metrics.` |

Aggregate changeset: ~10k LOC added across ~90 files, primarily under
`packages/opencode/src/plugin/github-copilot`, `packages/opencode/src/{autobest,history,timer}`,
`packages/opencode/src/server/instance`, and matching test directories.

### High-level additions

| Area | Directory | What is new |
| --- | --- | --- |
| Copilot routing | `packages/opencode/src/plugin/github-copilot/` | 7 new files, plus a rewritten `copilot.ts` (~1k lines) and a touched `models.ts`. |
| Autobest | `packages/opencode/src/autobest/`, `packages/opencode/src/session/autobest*.ts` | New domain namespace + session integration/observer. |
| History | `packages/opencode/src/history/`, `packages/opencode/src/session/history-observer.ts` | JSONL event store + analytics, KB, search, timeline overlays. |
| Timer | `packages/opencode/src/timer/`, `packages/opencode/src/tool/timer.ts`, `packages/opencode/src/server/{instance,protocol}/timer.ts` | Managed timer service + agent tool + REST surface. |
| Threads | `packages/opencode/src/server/instance/thread.ts` | `/thread` and `/turn` aliases on top of existing `/session`. |
| Copilot sidebar | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/copilot.tsx` | TUI widget showing per-account runtime/lane state. |

---

## Copilot multi-account routing

The `packages/opencode/src/plugin/github-copilot/` package implements per-account
routing, discovery, quota classification, rate-limit cooldowns, OAuth migration, and
in-process concurrency limits for the GitHub Copilot provider.

### File inventory

| File | Lines | Responsibility |
| --- | --- | --- |
| `auth.ts` | 194 | `CopilotAuth` type, legacy `~/.copilot/auth/credential.json` migration, `list`/`legacy`/`migrate` helpers, `MigrationState` bookkeeping. |
| `connections.ts` | 183 | Persistent connection state: `State`, `Conn`, `Discovery`, upsert/mark/clear, proxy config, plan lookup, `Store` (Effect-based JSON store), `staleDiscovery`. |
| `copilot.ts` | 1025 | Plugin entrypoint `CopilotAuthPlugin`, routing policy (`preferPlan`, `preferPolicy`, `preferDiscovery`, `batchOrder`, `autobestBatch`, `routeAccount`), `dispatch`, proxy fetch, OAuth device flow, `CopilotRuntimeState`. |
| `machine.ts` | 6 | Thin re-export of `connections.machine` for call sites needing per-account machine IDs. |
| `models.ts` | 148 | Zod schema for Copilot model discovery API + model fetching. |
| `paths.ts` | 7 | `connectionFile`, `legacyCredentialFile`, `migrationFile` path constants. |
| `quota.ts` | 99 | `Quota`/`Premium` parse, `fetchQuota`, `classifyPlan` → `edu`/`enterprise`/`business`/`team`/`individual`/`free`/`unknown`, `formatQuotaBar`. |
| `runtime.ts` | 141 | In-memory runtime: `Runtime`, `Pool`, `reserve`, `reserveBatch`, `touch`, `cooldown`, `eligible`, `Event` feed (24-entry ring). |

### Key types

```ts
// connections.ts
export type State = {
  version: number
  preferred?: string
  connections: Record<string, Conn>
}
// Conn carries: exhaustedUntil, lastTestedAt, lastRoutedAt, lastDiscoveryErrorAt,
// label, login, plan, preferred, machineId, proxyUrl, proxyToken, discovery.
```

```ts
// runtime.ts
export type Runtime = {
  pool: Pool                       // concurrent slot count per account key
  limit: number                    // per-account parallel cap
  minIntervalMs: number            // soft cooldown between requests per account
  last: Record<string, number>     // last-touch timestamps
  feed: Event[]                    // ring buffer of reserve/release/touch events
}
```

```ts
// auth.ts
export type CopilotAuth = {
  key: string                      // e.g. "github-copilot", "github-copilot#edu"
  label: string
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
}
```

### Persistent state storage

- `~/.local/share/opencode/copilot-connections.json` — connection state (plan, proxy, discovery, machine IDs, cooldown flags).
- `~/.local/share/opencode/copilot-migration.json` — marker recording legacy-credential migration outcome.
- `~/.copilot/auth/credential.json` — legacy file read during `migrate()` if present (`paths.ts:6`).

### Dispatch flow

`dispatch()` (`copilot.ts:563`) is the hot-path fetch wrapper registered by the plugin's
`auth.loader.fetch` hook. Order of operations per outbound request:

1. Read and sync connection state for all known Copilot auths via `syncAccount`.
2. Choose a routing target with `routeAccount`, which composes:
   - `routeAlias` – honour model aliases like `github-copilot#edu` (`copilot.ts:318`).
   - `preferPlan` – narrow to accounts whose stored plan matches the model id keyword.
   - `preferPolicy` – apply `policyPlan(modelId)` (enterprise > business > team > edu > free) and rotate by `lastRoutedAt`.
   - `preferDiscovery` – rank by discovery freshness + penalty score.
   - `batchOrder` – final tiebreak on runtime cooldown, discovery rank, penalty, and in-flight load.
3. When no provider alias is set and more than one account is available, pre-reserve an
   `autobestBatch` of slots sized to `runtime.limit`, then keep only the slot that
   matches the selected account.
4. Refresh per-account metadata (`refreshAccount` → `fetchQuota` → `classifyPlan`), assign or reuse a per-account machine ID, persist state.
5. Build the Copilot protocol headers with `protocol()` — including `X-Client-Machine-Id`,
   `X-Client-Session-Id`, `X-Initiator`, `X-Interaction-Type` (`copilot.ts:515`).
6. Route the fetch through `routedFetch`, optionally rewriting the URL via the configured per-account `proxyUrl`/`proxyToken`.
7. On response:
   - `429` → mark the account exhausted for 11 minutes and release the slot.
   - `401` → release slot without marking exhaustion; caller decides whether to re-auth.
   - `2xx` → clear any prior exhaustion flag, touch the runtime, release the slot.

```ts
// packages/opencode/src/plugin/github-copilot/copilot.ts:646
if (res.status === 429) {
  pick.release()
  await input.write(mark(nextState, live.key, Date.now() + 11 * 60 * 1000))
  if (input.modelId && isPremium) premiumRollback(input.premium, live.key, input.modelId)
  return res
}
```

### Plan-based routing

`policyPlan(modelId)` (`copilot.ts:204`) derives a lane hint from the model id. Keywords
map to the following lanes (checked in this order):

| Keyword in model id | Lane |
| --- | --- |
| `edu` | `edu` |
| `enterprise` | `enterprise` |
| `business` | `business` |
| `team` | `team` |
| `personal` / `free` | `free` |

`classifyPlan()` (`quota.ts:89`) performs the reverse on the authenticated user's
`copilot_plan` + `access_type_sku` fields returned from `/copilot_internal/user` and
persists the result into the connection record. The lane is then used by `preferPlan`
and `preferPolicy` to narrow the routing pool.

### Route debug and batch selection

`routeDebug()` (`copilot.ts:388`) returns an annotated list of candidates with
`routeReason` / `selectedReason` / `rejectedReason` strings — consumed by the TUI
sidebar widget and any instrumentation overlays. Typical reason strings:

- `alias:<providerID>` — alias hit for an explicit `github-copilot#…` suffix.
- `lane:<plan>` — account is on the wanted lane.
- `discovery:<rank>` — discovery rank 1 (failed), 2 (stale), 3 (fresh+ok).
- `penalty:recent429` — cooled down by a recent 429.
- `penalty:recentDiscoveryError` — discovery failed in the last 30 minutes.
- `lowerDiscoveryRank` / `higherPenalty` / `aliasMismatch` / `laneMismatch` — rejection reasons.

`autobestBatch()` (`copilot.ts:362`) generates a round-robin batch plan of `count` keys
by repeatedly applying `preferPlan → preferPolicy → preferDiscovery → batchOrder` on a
copy of the runtime. Used when dispatching without an explicit provider alias so the
runtime pre-reserves slots for the most likely sequence of picks.

### Rate limiting and runtime state

Per-account concurrency and pacing live in the in-process `Runtime` (`runtime.ts`):

- `reserve(state, key)` — bumps the per-account counter, emits a `reserve` feed entry,
  returns a disposable handle.
- `available(state, key)` — false once the pool hits `state.limit`.
- `cooldown(state, key)` — enforces `minIntervalMs` between successive requests.
- `eligible(state, pool)` — returns idle accounts, falling back to the full pool.
- `feed(state)` — ring buffer of the 24 most recent `reserve`/`release`/`touch` events,
  used by the Copilot sidebar.

### OAuth and enterprise login

The plugin's `auth.methods` entry drives an interactive prompt:

1. `deploymentType` — `github.com` or `enterprise`.
2. `enterpriseUrl` — only shown when deployment type is `enterprise`.
3. Device-code flow against `https://<domain>/login/device/code`.

Enterprise hosts derive the Copilot API base from `base()`:

```ts
// copilot.ts:93
export function base(enterpriseUrl?: string) {
  return enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : "https://api.githubcopilot.com"
}
```

### `CopilotRuntimeState`

`copilot.ts:59` exports a live snapshot consumed by the TUI sidebar:

```ts
export const CopilotRuntimeState = {
  migration() { return migrationOutcome.last },
  migrationSummary() { return summarizeMigration(migrationOutcome.last) },
  current: undefined as Runtime | undefined,
  info: {} as Record<string, { lane?: string; discovery: number; penalty: number; cooldown: boolean; selected?: boolean; selectedReason?: string[]; rejectedReason?: string[] }>,
  usage() { return usage(this.current) },
  feed() { return feed(this.current).map((item) => ({ ...this.info[item.key], ...item })) },
}
```

The `info` map is populated on every `dispatch()` call from `routeDebug()` output, so
the sidebar can display lane, discovery rank, penalty, cooldown, and
selected/rejected reasons in sync with actual routing decisions.

### Plugin hooks

`CopilotAuthPlugin` (`copilot.ts:665`) returns the standard plugin `Hooks` shape with:

- `provider.models` – fetch + alias model list per account, record discovery outcome.
- `auth` – provider `github-copilot`, OAuth loader with custom `fetch` dispatching through the routing pipeline.
- `chat.params` – strip `maxOutputTokens` for `gpt*` models to match Copilot CLI behaviour.
- `chat.headers` – set `anthropic-beta: interleaved-thinking-2025-05-14` for Anthropic-on-Copilot, override `x-initiator: agent` for subagent sessions and compactions.

---

## Autobest subsystem

Autobest ranks candidate next-step phrases extracted from the assistant's last message
and records picks (manual or automatic) as a session-scoped log. The integration is
deliberately lightweight so the core session machinery stays untouched.

### File inventory

| File | Purpose |
| --- | --- |
| `packages/opencode/src/autobest/index.ts` | Pure domain logic: `Candidate`, `Pick`, `State`, `Decision`, `decide`, `apply`, `setActive`. |
| `packages/opencode/src/session/autobest.ts` | Bridges `Autobest` decisions into the History event stream (`autobest.state` events). |
| `packages/opencode/src/session/autobest-observer.ts` | Effect service that listens for `SessionStatus.Event.Idle` and applies autobest extraction. |
| `packages/opencode/src/v2/session-event.ts` | Schema-Class `SessionEvent.Autobest` carrying `active`, `selected`, `changed`, `candidates`. |

### Key types

```ts
// autobest/index.ts
export type Candidate = { key: string; score: number; reason?: string[] }
export type Pick      = { key: string; score?: number; source: "manual" | "auto"; ts: number }
export type State     = { active?: Pick; picks: Pick[] }
export type Decision  = { active?: Pick; candidates: Candidate[]; selected?: Candidate; changed: boolean }
```

### Decision flow

`decide()` sorts candidates by score desc (tie-break by key) and reports a `changed`
flag if the top candidate differs from the current `active.key`. `apply()` promotes
`decide()`'s top pick to `active` if it changed; otherwise it leaves state untouched.

```ts
// autobest/index.ts:55
export function decide(state: State, input: { candidates: Candidate[]; ts?: number }) {
  const view = extract({ candidates: input.candidates, active: state.active?.key })
  const top = view.candidates[0]
  if (!top) return { active: state.active, candidates: [], selected: undefined, changed: false }
  const changed = top.key !== state.active?.key
  return {
    active: changed ? { key: top.key, score: top.score, source: "auto", ts: input.ts ?? Date.now() } : state.active,
    candidates: view.candidates, selected: top, changed,
  }
}
```

### Observer integration

`SessionAutobestObserver.layer` (`session/autobest-observer.ts:25`) subscribes to the
`SessionStatus.Event.Idle` bus event. When a session goes idle:

1. Read `getAutobestEnabled(sessionID)` — if false, bail.
2. Find the latest assistant message.
3. Walk its `text` parts through `extract(text)` — regex-matches bulleted or numbered
   list items; assigns a descending score starting from 100; keeps the first 5.
4. Call `applyAutobest({ sessionID, candidates, ts })` on the Session service.

> The `(session as any)` casts and `@ts-expect-error` in the observer signal pending
> work — the `Session.Interface` does not yet expose the autobest-aware methods, which
> is why several server endpoints return `501` (see *Known technical debt*).

### History bridge

`session/autobest.ts` converts either a raw `SessionEvent.Autobest` (`fromEvent`) or a
state/candidates pair (`append`) into a `History.Event` of type `autobest.state` and
appends it to the session history JSONL. The event carries both the current `active`
pick, the `selected` candidate with reasons, `candidates` count, the top entry, and a
full `log` with all candidates for downstream analytics.

---

## History subsystem

A persistent, append-only event log per session — backing analytics, timeline rendering,
a knowledge-base view, and a free-text search endpoint.

### File inventory

| File | Purpose |
| --- | --- |
| `packages/opencode/src/history/index.ts` | Event union (20+ variants), JSONL file IO, `append`/`read`/`readByType`/`last`. |
| `packages/opencode/src/history/analytics.ts` | Aggregated view: tool counts by state/name, step totals, cost/tokens, latest-of-each-kind. |
| `packages/opencode/src/history/kb.ts` | Knowledge-base shape: counts + latest snapshot of key event kinds. |
| `packages/opencode/src/history/search.ts` | Tokenise+query across all event types; row projection with text blob per event. |
| `packages/opencode/src/history/timeline.ts` | Chronological view with per-event kind ("session"/"message"/"prompt"/"tool"/"autobest") and title derivation; `changes()` surface for summary deltas. |
| `packages/opencode/src/session/history-observer.ts` | Effect service subscribing to `MessageV2.Event.PartUpdated` to emit `prompt.reminder.inserted`, `prompt.subtask.state_changed`, `prompt.shell.state_changed`. |

### Storage model

Events are persisted as JSONL at `~/.local/share/opencode/history/<sessionID>.jsonl`
(`history/index.ts:215`). `append()` reads the file, concatenates the new entry, and
rewrites the whole file — a simple, crash-visible model. `read()` returns an array,
parsing each line and silently dropping malformed rows.

### Event taxonomy

The `Event` union (discriminated by `type`) covers:

- Session lifecycle: `session.created`, `session.forked`, `session.summary.updated`.
- Message lifecycle: `message.{created,updated,removed}`.
- Message part lifecycle: `message.part.{created,updated,removed}`.
- Tool observations: `tool.state` with `pending`/`running`/`completed`/`error`, plus `output`, `attachments`, `error`, `interrupted`.
- Step book-keeping: `step.finish` with `cost` and full token breakdown (`input`, `output`, `reasoning`, `cache.{read,write}`, `total`).
- Prompt synth/observer events: `prompt.reminder.inserted`, `prompt.subtask.state_changed`, `prompt.shell.state_changed`.
- Autobest events: `autobest.active`, `autobest.state` (with optional `log`), `autobest.result`, `autobest.enabled`.

### Retrieval APIs

```ts
// history/index.ts:245
export async function readByType<T extends Event["type"]>(sessionID: string, type: T)
export async function last<T extends Event["type"]>(sessionID: string, type: T)
```

### Analytics view

`analytics.view(items)` returns:

```ts
{
  total: number
  sessions: { created, forked, summarized }
  tools: {
    total, by_state, by_name, interrupted,
    task: { total, by_state },
    bash: { total, by_state },
  }
  prompts: { reminders, subtasks, shells }
  steps: { total, cost, tokens, by_reason }
  latest: { tool, step, subtask, shell }
}
```

`analytics.session(sessionID)` composes `read` + `view` for a single-call summary.

### KB and search

`kb.view(items)` layers a counts snapshot over a `latest` projection that picks the
last `tool.state`, `autobest.state` (and its embedded `log`), `subtask`, and `shell`
events — useful for a sidebar or status line that shows "what's the session up to
right now".

`search.query(items, input)` performs a case-insensitive substring match across a
pre-computed text blob for each event. Fielded specialisations exist per event
variant via the private `text(item)` helper — for tool events, the blob includes tool
name, callID, state, title, error, output, and attachments.

`search.session(sessionID, input)` is the session-scoped entry point.

### Timeline view

`timeline.view(items)` returns `{ts, type, kind, text}` rows where `kind` is one of
`session`/`message`/`prompt`/`tool`/`autobest`. `timeline.changes(items)` reduces
consecutive `session.summary.updated` events into deltas and a `trend` (`start`/
`up`/`down`/`flat`) — suitable for a "diff over time" widget.

### Observer integration

`SessionHistoryObserver.layer` (`session/history-observer.ts:57`) subscribes to
`MessageV2.Event.PartUpdated`. For each updated part it classifies three kinds of
events:

1. **Reminders** — synthetic text parts matching known plan/build prompts. Four
   discriminations:

   ```ts
   // history-observer.ts:11
   if (part.text.includes("Plan mode is active")) return { kind: "plan_mode", source: "plan_file_exists" }
   if (part.text.includes("A plan file exists at ")) return { kind: "build_switch", source: "plan_file_exists" }
   if (part.text.includes("make a plan") || part.text.includes("You should execute on the plan defined within it"))
     return { kind: "build_switch", source: "prior_plan_assistant" }
   return { kind: "plan_prompt", source: "agent_match" }
   ```

2. **Subtask state** — for `tool.task` parts with `subagent_type`, writes a
   `prompt.subtask.state_changed` event.
3. **Shell state** — for `tool.bash` parts, writes a `prompt.shell.state_changed`
   event with `status` in `completed`/`running`/`aborted`.

---

## Timer subsystem

A small in-process managed timer facility exposed in three layers: a pure clock-driven
core (`Timer.create`), an Effect-based service used by the server
(`TimerSvc.Service`), and an agent-facing tool (`TimerTool`).

### File inventory

| File | Purpose |
| --- | --- |
| `packages/opencode/src/timer/index.ts` | Pure `Timer.create(clock?)` factory; supports arm/disarm, repeat, drain, clear. |
| `packages/opencode/src/tool/timer.ts` | `TimerTool` (ai-sdk tool) with action verbs `create`/`pause`/`resume`/`delete`/`get`/`list`/`drain`/`clear`. |
| `packages/opencode/src/server/instance/timer.ts` | `TimerSvc` Effect service + zod schemas (`Info`, `Fired`, `CreateInput`, `ItemInput`) with an `InstanceState`-scoped shared map. |
| `packages/opencode/src/server/protocol/timer.ts` | Protocol-only types: `ListResponse`, `CreateResponse`, `PauseResponse`, `ResumeResponse`, `DeleteResponse`, `FiredNotification`. |

### Pure core

```ts
// timer/index.ts:36
export function create(clock: Clock = makeClock()) {
  // items: Map<ID, State>; fired: Fired[]
  // arm() schedules a setTimeout, pushes to fired[], rearms if repeat
  // disarm() clears the handle and nulls next
  return { create, pause, resume, delete, get, list, drain, clear }
}
```

The default `Clock` wraps `Date.now` and `setTimeout`, but tests inject a fake clock
that records `(id, at, fn, live)` tuples and advances manually.

### Tool interface for agents

```ts
// tool/timer.ts
const Parameters = z.object({
  action: z.enum(["create", "pause", "resume", "delete", "get", "list", "drain", "clear"]),
  id: z.string().optional(),
  delay: z.number().int().positive().optional(),
  repeat: z.boolean().optional(),
})
```

`TimerToolState` stores a singleton `Timer.create()` instance shared across tool calls
within a process. `reset()` is exposed for tests.

### Server service

`TimerSvc` (`server/instance/timer.ts:7`) binds the pure core to an
`InstanceState`-scoped `Map<directory, Timer>` so each OpenCode project directory gets
its own timer runtime. The service exposes `list`/`get`/`create`/`pause`/`resume`/
`delete`/`drain`/`clear` all wrapped in `Effect.fn`.

### REST endpoints

Server routes are split across `/timer` (instance-wide) and `/session/:sessionID/timer`
(session-scoped). Duplicate routes exist because the thread alias layer reuses the
underlying service.

| Method | Path | Operation ID |
| --- | --- | --- |
| GET | `/timer` | `timer.list` |
| GET | `/session/:sessionID/timer` | `session.timer.list` |
| POST | `/session/:sessionID/timer` | `session.timer.create` |
| POST | `/session/:sessionID/timer/drain` | `session.timer.drain` (optional `?inject=true` query marker) |
| POST | `/session/:sessionID/timer/:id/pause` | `session.timer.pause` |
| POST | `/session/:sessionID/timer/:id/resume` | `session.timer.resume` |
| DELETE | `/session/:sessionID/timer/:id` | `session.timer.delete` |
| POST | `/tui/timer-fired` | `tui.timerFired` (publishes `TuiEvent.TimerFired` into the bus) |

The `?inject=true` drain flag is present but currently a no-op while autobest
injection is pending (`session.ts:269` — see *Known technical debt*).

### TUI bus event

`TuiEvent.TimerFired` (`src/cli/cmd/tui/event.ts:48`) carries:

```ts
{ sessionID: SessionID, id: string, repeat: boolean, fired_at: number }
```

Tests `tui-timer-fired.test.ts` and `tui-timer-fired-runtime.test.ts` cover the
publish→subscribe path and runtime integration.

---

## Thread and Turn HTTP routes

`packages/opencode/src/server/instance/thread.ts` adds a parallel HTTP surface mapped
onto the existing `Session` / `SessionPrompt` services. It is aliased in
`InstanceRoutes` as:

```ts
// server/instance/index.ts:59
.route("/thread", ThreadRoutes())
.route("/turn", TurnRoutes())
```

### Thread routes

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/thread` | List sessions (mirrors `/session`). Accepts `directory`, `roots`, `start`, `search`, `limit`. |
| GET | `/thread/:threadID` | Fetch a single session. |
| POST | `/thread/start` | Create a session. Takes `Session.CreateInput`. |
| POST | `/thread/:threadID/fork` | Fork from an optional `messageID`. |
| POST | `/thread/:threadID/setName` | Rename. Takes `{ title }`. |
| POST | `/thread/:threadID/autobest/setActive` | Toggle session autobest enabled flag. |
| POST | `/thread/:threadID/autobest/extract` | Apply a candidate batch and return the decision. |
| GET | `/thread/:threadID/request_permissions` | Pending permission prompts scoped to this thread. |
| GET | `/thread/:threadID/request_user_input` | Pending question prompts scoped to this thread. |
| POST | `/thread/:threadID/request_user_input/:requestID/reply` | Answer a pending question. |

Notably absent vs. the issue description: `archive`/`unarchive`. Archival is still
done via `PATCH /session/:id` with `{ time: { archived } }` (see `session.ts:693`).

### Turn routes

| Method | Path | Behaviour |
| --- | --- | --- |
| POST | `/turn/start` | `SessionPrompt.prompt(input)` — start a new turn. |
| POST | `/turn/interrupt` | `SessionPrompt.cancel(sessionID)` — cancel the in-flight turn. |
| POST | `/turn/steer` | `SessionPrompt.prompt(input)` — add steering input to the current turn (same signature as start). |

Covered by `packages/opencode/test/server/thread-turn-compat.test.ts` and
`packages/opencode/test/server/thread-request-compat.test.ts`.

### Relationship to legacy `/session`

Thread/turn routes do not replace `/session` — both are mounted on `InstanceRoutes`
simultaneously. Consumers can migrate by operation without a big-bang cutover. The
autobest endpoints under `/session/:sessionID/autobest*` currently return
`501 { skipped: true, reason: "pending autobest port integration" }` (see *Known
technical debt*); the `/thread/:threadID/autobest/*` variants are wired through the
full `Session.applyAutobest` path instead.

---

## Server instance modifications

### `server/instance/index.ts` changes

- Imports and mounts `TimerSvc`, `ThreadRoutes`, and `TurnRoutes`.
- Adds `GET /timer` — instance-wide timer list.

```ts
// server/instance/index.ts:176
.get("/timer",
  describeRoute({ summary: "List timers", operationId: "timer.list", ... }),
  async (c) => {
    const items = await AppRuntime.runPromise(
      TimerSvc.Service.use((svc) => svc.list()).pipe(Effect.provide(TimerSvc.defaultLayer)),
    )
    return c.json(items)
  },
)
```

### `server/instance/session.ts` additions

Session.ts grew by ~400 lines with the following new routes (operation IDs in italics):

- *session.timer.list* — `GET /:sessionID/timer`.
- *session.timer.create* — `POST /:sessionID/timer`.
- *session.timer.drain* — `POST /:sessionID/timer/drain?inject=…`.
- *session.timer.pause* — `POST /:sessionID/timer/:id/pause`.
- *session.timer.resume* — `POST /:sessionID/timer/:id/resume`.
- *session.timer.delete* — `DELETE /:sessionID/timer/:id`.
- *session.autobest.get* — `GET /:sessionID/autobest` (returns 501 pending port).
- *session.autobest.apply* — `POST /:sessionID/autobest` (returns 501 pending port).
- `POST /:sessionID/autobest/enabled` (returns 501 pending port).
- `POST /:sessionID/autobest/extract` (returns 501 pending port).

### `server/instance/tui.ts` additions

- `POST /tui/timer-fired` — publishes `TuiEvent.TimerFired` into the bus.
- `POST /tui/select-session` — existed upstream; no behavioural change on this branch.

---

## Server protocol additions

`packages/opencode/src/server/protocol/timer.ts` defines the shared request/response
envelopes so consumers (SDKs, TUI, desktop) can deserialise without pulling the
instance service layer:

```ts
export namespace TimerProtocol {
  export const Info            // TimerSvc.Info shape
  export const Fired           // { id, at }
  export const CreateInput     // { id, delay, repeat? }
  export const ItemInput       // { id }
  export const ListResponse    // { items: Info[] }
  export const CreateResponse  // { item: Info }
  export const PauseResponse   // { item: Info | null }
  export const ResumeResponse  // { item: Info | null }
  export const DeleteResponse  // { ok: boolean }
  export const FiredNotification // { item: Fired }
}
```

All schemas carry `.meta({ ref: "Timer…" })` so they surface as reusable references in
the generated OpenAPI document.

No other protocol-layer additions exist in this fork — autobest, history, and thread
operations reuse the `Session` and `History` schemas directly rather than defining a
dedicated protocol file.

---

## Sidebar Copilot TUI widget

`packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/copilot.tsx` registers a
TUI slot plugin under id `internal:sidebar-copilot` that surfaces live Copilot routing
telemetry.

### What it shows

- Header line: `Copilot (N accts)` with an optional expand/collapse chevron (activates once the event feed has >3 entries or >2 accounts are tracked).
- Summary line: `selected=<acct> active=<count> hot=<acct>`.
- Migration banner: `summary text`, `source=…`, `migratedAt=…` derived from `CopilotRuntimeState.migrationSummary()`.
- Aggregate rejection counters: `reject lane=N disc=N penalty=N runtime=N` across the last 24 feed events.
- Per-account block with:
  - Label + tags: `selected`/`disc`/`lane`/`runtime`/`penalty` colour-coded against the active theme.
  - Metrics line: `load=N last=<age> lane=<plan> disc=<rank> pen=<n> [cool]`.
  - Collapsed: first 3 event rows. Expanded: up to 8. Each row renders `<icon> <type> <age>` with `+`/`-`/`•` prefixes for reserve/release/touch.

The widget polls `CopilotRuntimeState` every 500 ms via `setInterval(tick)` and only
renders when either `usage().length > 0` or `feed().length > 0`.

Theming is driven by `api.theme.current` — `text`, `textMuted`, `success`, `warning`,
`error`, `info`.

```ts
// sidebar/copilot.tsx:148
const tui: TuiPlugin = async (api) => {
  api.slots.register({ order: 150, slots: { sidebar_content: () => <View api={api} /> } })
}
```

---

## Providers CLI changes

`packages/opencode/src/cli/cmd/providers.ts` is partially aligned with the unified
architecture but intentionally does not yet expose the full fork feature set. The
current state:

- `ProvidersListCommand` — unchanged in shape from upstream.
- `ProvidersLoginCommand` — unchanged flow, but now uses the nested
  `CopilotAuthPlugin` via the plugin loader.
- `ProvidersLogoutCommand` — unchanged.
- `ProvidersQuotaCommand` — wired to the **nested** copilot quota module
  (`plugin/github-copilot/quota`), prints a `formatQuotaBar` for each configured
  Copilot account with plan, login, optional enterprise host.

> Commits `48f288bf9` and `c31ad4ca3` re-point `providers.ts` at the nested Copilot
> modules and align with the current `Auth`/`Config`/`Process` APIs.

The broader `port/copilot-plan` providers surface (`accountStatus`,
`ProvidersAccountsCommand`, `ProvidersRouteDebugCommand`, `copilotAlias*`, `applyProxy`,
`jsonMigration`) is not yet exposed — tests for it are skipped. See
`test/cli/cmd/providers-quota.test.ts:2`:

```ts
// SKIPPED: depends on port/copilot-plan providers.ts exports not yet ported.
// Revisit after unify branch aligns providers CLI (accountStatus, jsonMigration,
// ProvidersAccountsCommand, ProvidersRouteDebugCommand, copilotAlias*, proxy*, etc.).
```

---

## Configuration and environment variables

| Name | Source | Default | Effect |
| --- | --- | --- | --- |
| `OPENCODE_COPILOT_RUNTIME_LIMIT` | `process.env`, overridden by `config.provider.github-copilot.options.runtimeLimit` | `1` | Per-account concurrent-request cap used as `Runtime.limit` at plugin boot. |
| `OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS` | `process.env`, overridden by `config.provider.github-copilot.options.runtimeMinIntervalMs` | `0` | Minimum interval between successive requests to the same account. Used by `cooldown(state, key)`. |

Resolution logic lives in `copilotRuntimeConfig()`:

```ts
// plugin/github-copilot/copilot.ts:490
export function copilotRuntimeConfig(config?: { provider?: Record<string, { options?: Record<string, unknown> }> }) {
  const opts = config?.provider?.["github-copilot"]?.options
  const limit = Number(process.env.OPENCODE_COPILOT_RUNTIME_LIMIT ?? opts?.runtimeLimit ?? 1)
  const minIntervalMs = Number(process.env.OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS ?? opts?.runtimeMinIntervalMs ?? 0)
  return {
    limit: Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 1,
    minIntervalMs: Number.isFinite(minIntervalMs) && minIntervalMs >= 0 ? Math.trunc(minIntervalMs) : 0,
  }
}
```

Additional connection-level config is kept in
`~/.local/share/opencode/copilot-connections.json`, which can be hand-edited to set
per-account `proxyUrl`, `proxyToken`, and `preferred` flags.

---

## Testing surface

New tests added by the fork, grouped by target area:

### Copilot plugin

| File | Coverage |
| --- | --- |
| `test/plugin/github-copilot-auth.test.ts` | 1406 lines. Legacy migration from `~/.copilot/auth/credential.json`, plan-suffix key derivation (`#edu`, `#enterprise`, `#free`), idempotent migration marker, `list()` sort order. |
| `test/plugin/github-copilot-connections.test.ts` | State upsert, `rotate`/`routed`/`mark`/`clear`, `discover`/`staleDiscovery`/`hasModel`, `proxy`. |
| `test/plugin/github-copilot-models.test.ts` | 766 lines. Model schema parsing + discovery endpoint. |
| `test/plugin/github-copilot-quota.test.ts` | `parse`/`premium`/`classifyPlan`/`formatQuotaBar`. |
| `test/plugin/github-copilot-runtime.test.ts` | `acquire`/`release`/`available`/`eligible`/`reserve`/`reserveBatch`/`touch`/`cooldown`/`usage`. |

### Autobest

| File | Coverage |
| --- | --- |
| `test/autobest/autobest.test.ts` | `decide`/`apply`/`extract` behaviour, `setActive`. |
| `test/session/autobest-history.test.ts` | History event bridge, `fromEvent` shape parity. |

### History

| File | Coverage |
| --- | --- |
| `test/history/history.test.ts` | 331 lines. File IO, append/read, `readByType`, `last`. |
| `test/history/timeline.test.ts` | Kind classification, title derivation, `changes()` deltas. |
| `test/session/history.test.ts` | **Skipped** (`describe.skip`) pending `Session.Interface` autobest port. |

### Timer

| File | Coverage |
| --- | --- |
| `test/timer/timer.test.ts` | Core clock-driven lifecycle (arm/disarm, repeat, drain, clear). |
| `test/timer/service.test.ts` | Effect service semantics, per-directory sharing. |
| `test/timer/tool.test.ts` | Tool action verbs. |
| `test/server/session-timer.test.ts` | REST lifecycle via `Server.Default()`. |
| `test/server/tui-timer-fired.test.ts` | `/tui/timer-fired` publish path. |
| `test/server/tui-timer-fired-runtime.test.ts` | End-to-end timer→TUI bus integration. |

### Thread/Turn

| File | Coverage |
| --- | --- |
| `test/server/thread-turn-compat.test.ts` | list/get/setName/fork/autobest toggle+extract, `/turn/start`+`/turn/interrupt`. |
| `test/server/thread-request-compat.test.ts` | request_permissions and request_user_input scoping. |
| `test/server/session-actions.test.ts` | 208 lines. Regression coverage for session mutation endpoints. |

### Other session tests

| File | Coverage |
| --- | --- |
| `test/session/llm.test.ts` | LLM-level behaviour with autobest/history wiring. |
| `test/session/prompt-effect.test.ts` | Effect-layer prompt service sanity. |
| `test/session/session-entry.test.ts` | v2 session entry serialisation. |
| `test/session/system.test.ts` | Expanded to 216 lines — system prompt + skills. |

### Skipped tests

The following tests are explicitly skipped on this branch (they import APIs not yet
re-surfaced after the nested-layout migration):

- `test/session/history.test.ts` — waits on `Session.Interface` autobest methods.
- `test/cli/cmd/providers-quota.test.ts` — waits on the extended providers CLI surface.

---

## Known technical debt (`TODO(unify)`)

Seven `TODO(unify)` markers remain on this branch. All cluster around the same root
cause: the `Session.Interface` has not yet been re-opened to expose the autobest
methods the observers and routes expect.

| Location | Description |
| --- | --- |
| `packages/opencode/src/server/instance/session.ts:269` | `POST /session/:sessionID/timer/drain?inject=true` should re-inject fired timers into autobest, but the hook is stubbed with `void param; void items;`. |
| `packages/opencode/src/server/instance/session.ts:420` | `GET /session/:sessionID/autobest` returns `501 { skipped: true, reason: "pending autobest port integration" }`. |
| `packages/opencode/src/server/instance/session.ts:498` | `POST /session/:sessionID/autobest` — same stub. |
| `packages/opencode/src/server/instance/session.ts:520` | `POST /session/:sessionID/autobest/enabled` — same stub. |
| `packages/opencode/src/server/instance/session.ts:548` | `POST /session/:sessionID/autobest/extract` — same stub. |
| `packages/opencode/src/session/autobest-observer.ts:32,35,48` | Session service cast to `any` and `@ts-expect-error` on the Effect generator — expected methods are `getAutobestEnabled`, `applyAutobest`. |
| `packages/opencode/test/session/history.test.ts:3` | Whole file is skipped pending `setAutobest`, `getAutobest`, `setAutobestEnabled`, `getAutobestEnabled`, `applyAutobest`. |

An additional note in `packages/opencode/src/effect/app-runtime.ts:101` flags an
unrelated Effect R-channel drift (one default layer surfaces `any` — this is a known
typecheck accommodation, not a runtime issue).

The `/thread/:threadID/autobest/*` endpoints in `thread.ts` do **not** hit these
stubs; they call `setAutobestEnabled` and `applyAutobest` directly on the Session
service. Once the Session service is re-aligned, the `/session` endpoints can simply
drop the `501` bodies.

---

## Migration notes

### Nested Copilot layout (breaking for internal consumers)

Before this branch, Copilot code lived at `packages/opencode/src/plugin/copilot-*.ts`
(flat layout). Those files were **deleted** in commit `6c0c9b7c9` and replaced by the
nested `packages/opencode/src/plugin/github-copilot/` package. Consumers who imported
from the old flat paths must update to the new nested module:

| Old import | New import |
| --- | --- |
| `@/plugin/copilot-auth` | `@/plugin/github-copilot/auth` |
| `@/plugin/copilot-quota` | `@/plugin/github-copilot/quota` |
| `@/plugin/copilot-models` | `@/plugin/github-copilot/models` |
| `@/plugin/copilot-runtime` | `@/plugin/github-copilot/runtime` |
| `@/plugin/copilot-connections` | `@/plugin/github-copilot/connections` |
| `@/plugin/copilot` | `@/plugin/github-copilot/copilot` (`CopilotAuthPlugin`, `CopilotRuntimeState`) |

`src/cli/cmd/providers.ts` was updated to the new nested path in commit `c31ad4ca3`.

### Legacy credential migration

On plugin boot, `CopilotAuthPlugin` invokes `migrate()` against
`~/.copilot/auth/credential.json`. If no `github-copilot*` auth already exists, legacy
records are imported and the result (keys migrated, source path, timestamp) is stored
at `~/.local/share/opencode/copilot-migration.json`. The marker is respected on
subsequent boots — no duplicate migration will occur.

`CopilotRuntimeState.migrationSummary()` surfaces the outcome to the TUI sidebar.

### Session service surface

Downstream code that mounts the `Session.defaultLayer` should be aware that the
observers added by this branch (`SessionHistoryObserver`, `SessionAutobestObserver`)
attach bus subscribers and therefore require `Bus.Service` to be available. Both
layers wire their own finalizers to clean up on layer disposal.

### Agent layer lazy evaluation

`Agent.defaultLayer` (`src/agent/agent.ts:402`) is now wrapped in `Layer.suspend(() =>
…)` so downstream merges don't force-evaluate Plugin/Provider/Auth/Config/Skill layers
eagerly. This is a compatibility fix introduced while aligning the R-channel (commit
`56bc93a0d`).

### HTTP consumer guidance

- Prefer `/thread/*` and `/turn/*` for new code — they carry session autobest support today.
- `/session/:id/autobest*` returns `501` until the Session service port lands; do not rely on it.
- `GET /timer` returns an instance-wide list; `GET /session/:id/timer` returns the same because timers are scoped to the instance directory rather than the session. This is intentional and will stay that way until sessions grow their own timer scope.
- `/session/:id/timer/drain?inject=true` is accepted but does not re-inject fired timers into autobest yet.

### Operational notes for Copilot

- Setting `OPENCODE_COPILOT_RUNTIME_LIMIT=2+` enables true parallel dispatch across a single account. Most users want to keep the default of `1`.
- Enterprise hosts are detected via `enterpriseUrl` on the OAuth record; the API base becomes `https://copilot-api.<domain>`.
- Setting `connections.<key>.proxyUrl` in `copilot-connections.json` routes that account's traffic through a proxy, with optional `proxyToken` sent as `x-copilot-proxy-token`.
- A 429 response blocks the account for 11 minutes (wall-clock, not monotonic). A discovery error blocks discovery rank promotion for 30 minutes.

---
