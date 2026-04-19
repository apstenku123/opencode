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
13. [Known technical debt](#known-technical-debt)
14. [Migration notes](#migration-notes)
15. [Round 8 — Copilot auth discovery, pool routing, envelope proxy, providers CLI](#round-8--copilot-auth-discovery-pool-routing-envelope-proxy-providers-cli)

---

## Scope and branch topology

The `unify/copilot-plan` branch was created to merge two earlier branches — a nested
Copilot dispatch rewrite (`wip/dev-copilot-nested`) and a feature port bringing autobest,
history, and timer work forward from `port/copilot-plan`. It diverges from the
`release: v1.4.7` commit (`9f201d637`).

Commits unique to this fork branch (`git log --oneline 9f201d637..unify/copilot-plan`):

| SHA (short) | Message                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `56bc93a0d` | `fix(unify): patch scattered Effect R-channel drift in tests + app-runtime`                                             |
| `9858c5469` | `fix(unify): github-copilot/copilot.ts Auth API + quota.ts typing`                                                      |
| `556d23544` | `fix(unify): stub history/index.ts type issues; skip history test pending Session.Interface autobest port`              |
| `48f288bf9` | `fix(unify): drop duplicate ThreadRoutes wiring; point providers.ts to nested quota; skip providers-quota test`         |
| `6c0c9b7c9` | `chore(unify): drop flat plugin/copilot-*.ts; skip providers-quota.test.ts pending API realignment`                     |
| `c31ad4ca3` | `fix(unify): align providers.ts with current auth/config/process API`                                                   |
| `56c0ea259` | `fix(unify): align server/instance/{session,index}.ts with current namespaces; stub autobest endpoints`                 |
| `167cdf4fd` | `fix(unify): align server/instance/{timer,thread}.ts with current runtime API`                                          |
| `5ea2ef46c` | `fix(unify): easy typecheck fixes — imports aligned with current dev`                                                   |
| `be6bc2db1` | `merge: port/copilot-plan into unify — autobest, history, timer, copilot nested layout`                                 |
| `ad483e648` | `merge: wip/dev-copilot-nested — copilot dispatch rewrite + thread/turn routes`                                         |
| `3f170b032` | `wip: port copilot-plan — autobest, history, timer, copilot routing`                                                    |
| `4a96db395` | `wip: copilot nested-layout migration + thread/turn routes`                                                             |
| `b804debb3` | `Record current codex_git parity frontier`                                                                              |
| `16538ae80` | `feat: implement Copilot model discovery, adaptive rate limiting, and persistent state tracking for hooks and metrics.` |

Aggregate changeset: ~10k LOC added across ~90 files, primarily under
`packages/opencode/src/plugin/github-copilot`, `packages/opencode/src/{autobest,history,timer}`,
`packages/opencode/src/server/instance`, and matching test directories.

### High-level additions

| Area            | Directory                                                                                                                          | What is new                                                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Copilot routing | `packages/opencode/src/plugin/github-copilot/`                                                                                     | 7 new files, plus a rewritten `copilot.ts` (~1k lines) and a touched `models.ts`. |
| Autobest        | `packages/opencode/src/autobest/`, `packages/opencode/src/session/autobest*.ts`                                                    | New domain namespace + session integration/observer.                              |
| History         | `packages/opencode/src/history/`, `packages/opencode/src/session/history-observer.ts`                                              | JSONL event store + analytics, KB, search, timeline overlays.                     |
| Timer           | `packages/opencode/src/timer/`, `packages/opencode/src/tool/timer.ts`, `packages/opencode/src/server/{instance,protocol}/timer.ts` | Managed timer service + agent tool + REST surface.                                |
| Threads         | `packages/opencode/src/server/instance/thread.ts`                                                                                  | `/thread` and `/turn` aliases on top of existing `/session`.                      |
| Copilot sidebar | `packages/opencode/src/cli/cmd/tui/feature-plugins/sidebar/copilot.tsx`                                                            | TUI widget showing per-account runtime/lane state.                                |

---

## Copilot multi-account routing

The `packages/opencode/src/plugin/github-copilot/` package implements per-account
routing, discovery, quota classification, rate-limit cooldowns, OAuth migration, and
in-process concurrency limits for the GitHub Copilot provider.

### File inventory

| File             | Lines | Responsibility                                                                                                                                                                                                             |
| ---------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.ts`        | 194   | `CopilotAuth` type, legacy `~/.copilot/auth/credential.json` migration, `list`/`legacy`/`migrate` helpers, `MigrationState` bookkeeping.                                                                                   |
| `connections.ts` | 183   | Persistent connection state: `State`, `Conn`, `Discovery`, upsert/mark/clear, proxy config, plan lookup, `Store` (Effect-based JSON store), `staleDiscovery`.                                                              |
| `copilot.ts`     | 1025  | Plugin entrypoint `CopilotAuthPlugin`, routing policy (`preferPlan`, `preferPolicy`, `preferDiscovery`, `batchOrder`, `autobestBatch`, `routeAccount`), `dispatch`, proxy fetch, OAuth device flow, `CopilotRuntimeState`. |
| `machine.ts`     | 6     | Thin re-export of `connections.machine` for call sites needing per-account machine IDs.                                                                                                                                    |
| `models.ts`      | 148   | Zod schema for Copilot model discovery API + model fetching.                                                                                                                                                               |
| `paths.ts`       | 7     | `connectionFile`, `legacyCredentialFile`, `migrationFile` path constants.                                                                                                                                                  |
| `quota.ts`       | 99    | `Quota`/`Premium` parse, `fetchQuota`, `classifyPlan` → `edu`/`enterprise`/`business`/`team`/`individual`/`free`/`unknown`, `formatQuotaBar`.                                                                              |
| `runtime.ts`     | 141   | In-memory runtime: `Runtime`, `Pool`, `reserve`, `reserveBatch`, `touch`, `cooldown`, `eligible`, `Event` feed (24-entry ring).                                                                                            |

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

| Keyword in model id | Lane         |
| ------------------- | ------------ |
| `edu`               | `edu`        |
| `enterprise`        | `enterprise` |
| `business`          | `business`   |
| `team`              | `team`       |
| `personal` / `free` | `free`       |

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

| File                                                 | Purpose                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/opencode/src/autobest/index.ts`            | Pure domain logic: `Candidate`, `Pick`, `State`, `Decision`, `decide`, `apply`, `setActive`. |
| `packages/opencode/src/session/autobest.ts`          | Bridges `Autobest` decisions into the History event stream (`autobest.state` events).        |
| `packages/opencode/src/session/autobest-observer.ts` | Effect service that listens for `SessionStatus.Event.Idle` and applies autobest extraction.  |
| `packages/opencode/src/v2/session-event.ts`          | Schema-Class `SessionEvent.Autobest` carrying `active`, `selected`, `changed`, `candidates`. |

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

> The observer uses the typed `Session.Service` directly — `getAutobestEnabled`,
> `findMessage`, and `applyAutobest` are first-class members of `Session.Interface`
> (restored in `df811c5ec`). Prior `as any` casts have been removed (`a9dcda88e`).

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

| File                                                | Purpose                                                                                                                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/history/index.ts`            | Event union (20+ variants), JSONL file IO, `append`/`read`/`readByType`/`last`.                                                                               |
| `packages/opencode/src/history/analytics.ts`        | Aggregated view: tool counts by state/name, step totals, cost/tokens, latest-of-each-kind.                                                                    |
| `packages/opencode/src/history/kb.ts`               | Knowledge-base shape: counts + latest snapshot of key event kinds.                                                                                            |
| `packages/opencode/src/history/search.ts`           | Tokenise+query across all event types; row projection with text blob per event.                                                                               |
| `packages/opencode/src/history/timeline.ts`         | Chronological view with per-event kind ("session"/"message"/"prompt"/"tool"/"autobest") and title derivation; `changes()` surface for summary deltas.         |
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

| File                                             | Purpose                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `packages/opencode/src/timer/index.ts`           | Pure `Timer.create(clock?)` factory; supports arm/disarm, repeat, drain, clear.                                                  |
| `packages/opencode/src/tool/timer.ts`            | `TimerTool` (ai-sdk tool) with action verbs `create`/`pause`/`resume`/`delete`/`get`/`list`/`drain`/`clear`.                     |
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

| Method | Path                                   | Operation ID                                                    |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| GET    | `/timer`                               | `timer.list`                                                    |
| GET    | `/session/:sessionID/timer`            | `session.timer.list`                                            |
| POST   | `/session/:sessionID/timer`            | `session.timer.create`                                          |
| POST   | `/session/:sessionID/timer/drain`      | `session.timer.drain` (optional `?inject=true` query marker)    |
| POST   | `/session/:sessionID/timer/:id/pause`  | `session.timer.pause`                                           |
| POST   | `/session/:sessionID/timer/:id/resume` | `session.timer.resume`                                          |
| DELETE | `/session/:sessionID/timer/:id`        | `session.timer.delete`                                          |
| POST   | `/tui/timer-fired`                     | `tui.timerFired` (publishes `TuiEvent.TimerFired` into the bus) |

The `?inject=true` drain flag appends a synthesised user message (`[timer:<id>]
fired`) per drained timer via `Session.appendUserText` (see
`server/instance/session.ts:268`). This is the closed form of a previously stubbed
hook — it now surfaces fired-timer state into the conversation transcript rather
than being silently dropped.

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

| Method | Path                                                    | Behaviour                                                                                     |
| ------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| GET    | `/thread`                                               | List sessions (mirrors `/session`). Accepts `directory`, `roots`, `start`, `search`, `limit`. |
| GET    | `/thread/:threadID`                                     | Fetch a single session.                                                                       |
| POST   | `/thread/start`                                         | Create a session. Takes `Session.CreateInput`.                                                |
| POST   | `/thread/:threadID/fork`                                | Fork from an optional `messageID`.                                                            |
| POST   | `/thread/:threadID/setName`                             | Rename. Takes `{ title }`.                                                                    |
| POST   | `/thread/:threadID/autobest/setActive`                  | Toggle session autobest enabled flag.                                                         |
| POST   | `/thread/:threadID/autobest/extract`                    | Apply a candidate batch and return the decision.                                              |
| GET    | `/thread/:threadID/request_permissions`                 | Pending permission prompts scoped to this thread.                                             |
| GET    | `/thread/:threadID/request_user_input`                  | Pending question prompts scoped to this thread.                                               |
| POST   | `/thread/:threadID/request_user_input/:requestID/reply` | Answer a pending question.                                                                    |

Notably absent vs. the issue description: `archive`/`unarchive`. Archival is still
done via `PATCH /session/:id` with `{ time: { archived } }` (see `session.ts:693`).

### Turn routes

| Method | Path              | Behaviour                                                                                         |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/turn/start`     | `SessionPrompt.prompt(input)` — start a new turn.                                                 |
| POST   | `/turn/interrupt` | `SessionPrompt.cancel(sessionID)` — cancel the in-flight turn.                                    |
| POST   | `/turn/steer`     | `SessionPrompt.prompt(input)` — add steering input to the current turn (same signature as start). |

Covered by `packages/opencode/test/server/thread-turn-compat.test.ts` and
`packages/opencode/test/server/thread-request-compat.test.ts`.

### Relationship to legacy `/session`

Thread/turn routes do not replace `/session` — both are mounted on `InstanceRoutes`
simultaneously. Consumers can migrate by operation without a big-bang cutover. Both
the `/session/:sessionID/autobest*` and `/thread/:threadID/autobest/*` endpoints are
now wired through the full `Session.applyAutobest` / `setAutobestEnabled` path
(closed by commit `d37c7ea64`); the earlier `501 { skipped: true }` stubs have been
removed.

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
- *session.autobest.get* — `GET /:sessionID/autobest`. Returns `{ state, log, result }` from the history-backed autobest record.
- *session.autobest.apply* — `POST /:sessionID/autobest`. Accepts a candidate batch or manual pick and persists via `Session.applyAutobest`.
- `POST /:sessionID/autobest/enabled` — toggles the per-session autobest enabled flag.
- `POST /:sessionID/autobest/extract` — runs extraction on the last assistant message and applies the top pick.

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

`packages/opencode/src/cli/cmd/providers.ts` now carries the full fork surface —
the initial alignment with nested Copilot modules (`48f288bf9`, `c31ad4ca3`) was
completed by `f408471a9`, which restored the extended commands and helpers from
`port/copilot-plan`:

- `ProvidersListCommand` — unchanged in shape from upstream.
- `ProvidersLoginCommand` — unchanged flow, uses the nested `CopilotAuthPlugin`.
- `ProvidersLogoutCommand` — unchanged.
- `ProvidersQuotaCommand` — wired to the nested Copilot quota module
  (`plugin/github-copilot/quota`), prints a `formatQuotaBar` per configured account.
- `ProvidersAccountsCommand` — lists per-account status with plan, quota, proxy, and
  migration state (JSON output available).
- `ProvidersRouteDebugCommand` — emits `routeDebug()` output for a given model id,
  surfacing lane, discovery rank, penalty, and selected/rejected reasons.
- `applyProxy(state, key, { proxyUrl, proxyToken })` — updates per-account proxy in
  the connections store.
- `copilotAliasLabel` / `copilotAliasName` — label helpers for
  `github-copilot#<lane>` aliases.
- `accountStatus` / `renderAccountStatus` / `jsonStatus` / `jsonMigration` — shared
  status projection used by both interactive and JSON outputs
  (`ACCOUNT_STATUS_SCHEMA_VERSION` is pinned).

The corresponding test `test/cli/cmd/providers-quota.test.ts` was un-skipped in
`9021ae3fc` and realigned with the current implementation in `f8ae678f0`.

### Portable account transfer (`providers export`/`import`)

`packages/opencode/src/plugin/github-copilot/transfer.ts` ports the Rust
`codex-rs/github-copilot/src/transfer.rs` surface. It produces a portable
JSON bundle that captures every Copilot OAuth credential plus the
`copilot-connections.json` metadata we care about (plan label, proxy URL,
`preferred` flag, etc.) so operators can move accounts between hosts.

Bundle shape (`version: 1`):

```jsonc
{
  "version": 1,
  "accounts": [
    {
      "key": "github-copilot",
      "label": "Primary",
      "refresh": "<oauth-refresh-token>",
      "enterpriseUrl": "https://ghe.example.com",
      "plan": "pro",
      "proxyUrl": "https://proxy.example",
      "proxyToken": "<secret>"
    }
  ],
  "connections": {
    "github-copilot": { "plan": "pro", "proxyUrl": "https://proxy.example" }
  },
  "preferred": "github-copilot",
  "exportedAt": 1700000000000,
  "exportedBy": "host-a"
}
```

- `opencode providers export [--out PATH] [--plain | --base64] [--redact-tokens] [--exported-by STR]`
  writes the bundle to stdout or a file. `--redact-tokens` strips
  `refresh`/`proxyToken` values (stable for sharing configs without
  secrets, and flags `redacted: true` in the envelope).
- `opencode providers import <PATH | ->` reads JSON (or base64-wrapped
  JSON) from disk or stdin. `--merge` (default) upserts accounts keyed
  by `account.key`; `--replace` wipes existing `github-copilot*` entries
  and connection state first. `--dry-run` reports what would change
  without touching disk. `--json` emits a machine-readable result.

`parseBundle` rejects any bundle whose `version` differs from
`BUNDLE_VERSION` so downgrades cannot silently lose fields. Bundles
produced with `--redact-tokens` skip account restoration on import (no
refresh token → cannot mint an Oauth entry) but still merge connection
metadata, which is handy for sharing proxy/plan setups.

---

## Configuration and environment variables

| Name                                       | Source                                                                                     | Default | Effect                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `OPENCODE_COPILOT_RUNTIME_LIMIT`           | `process.env`, overridden by `config.provider.github-copilot.options.runtimeLimit`         | `1`     | Per-account concurrent-request cap used as `Runtime.limit` at plugin boot.                        |
| `OPENCODE_COPILOT_RUNTIME_MIN_INTERVAL_MS` | `process.env`, overridden by `config.provider.github-copilot.options.runtimeMinIntervalMs` | `0`     | Minimum interval between successive requests to the same account. Used by `cooldown(state, key)`. |

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

| File                                             | Coverage                                                                                                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/plugin/github-copilot-auth.test.ts`        | 1406 lines. Legacy migration from `~/.copilot/auth/credential.json`, plan-suffix key derivation (`#edu`, `#enterprise`, `#free`), idempotent migration marker, `list()` sort order. |
| `test/plugin/github-copilot-connections.test.ts` | State upsert, `rotate`/`routed`/`mark`/`clear`, `discover`/`staleDiscovery`/`hasModel`, `proxy`.                                                                                    |
| `test/plugin/github-copilot-models.test.ts`      | 766 lines. Model schema parsing + discovery endpoint.                                                                                                                               |
| `test/plugin/github-copilot-quota.test.ts`       | `parse`/`premium`/`classifyPlan`/`formatQuotaBar`.                                                                                                                                  |
| `test/plugin/github-copilot-runtime.test.ts`     | `acquire`/`release`/`available`/`eligible`/`reserve`/`reserveBatch`/`touch`/`cooldown`/`usage`.                                                                                     |

### Autobest

| File                                    | Coverage                                           |
| --------------------------------------- | -------------------------------------------------- |
| `test/autobest/autobest.test.ts`        | `decide`/`apply`/`extract` behaviour, `setActive`. |
| `test/session/autobest-history.test.ts` | History event bridge, `fromEvent` shape parity.    |

### History

| File                            | Coverage                                                                 |
| ------------------------------- | ------------------------------------------------------------------------ |
| `test/history/history.test.ts`  | 331 lines. File IO, append/read, `readByType`, `last`.                   |
| `test/history/timeline.test.ts` | Kind classification, title derivation, `changes()` deltas.               |
| `test/session/history.test.ts`  | Covers the session history observer end-to-end; un-skipped in `9021ae3fc` after `Session.Interface` regained autobest methods. |

### Timer

| File                                          | Coverage                                                        |
| --------------------------------------------- | --------------------------------------------------------------- |
| `test/timer/timer.test.ts`                    | Core clock-driven lifecycle (arm/disarm, repeat, drain, clear). |
| `test/timer/service.test.ts`                  | Effect service semantics, per-directory sharing.                |
| `test/timer/tool.test.ts`                     | Tool action verbs.                                              |
| `test/server/session-timer.test.ts`           | REST lifecycle via `Server.Default()`.                          |
| `test/server/tui-timer-fired.test.ts`         | `/tui/timer-fired` publish path.                                |
| `test/server/tui-timer-fired-runtime.test.ts` | End-to-end timer→TUI bus integration.                           |

### Thread/Turn

| File                                        | Coverage                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `test/server/thread-turn-compat.test.ts`    | list/get/setName/fork/autobest toggle+extract, `/turn/start`+`/turn/interrupt`. |
| `test/server/thread-request-compat.test.ts` | request_permissions and request_user_input scoping.                             |
| `test/server/session-actions.test.ts`       | 208 lines. Regression coverage for session mutation endpoints.                  |

### Other session tests

| File                                 | Coverage                                          |
| ------------------------------------ | ------------------------------------------------- |
| `test/session/llm.test.ts`           | LLM-level behaviour with autobest/history wiring. |
| `test/session/prompt-effect.test.ts` | Effect-layer prompt service sanity.               |
| `test/session/session-entry.test.ts` | v2 session entry serialisation.                   |
| `test/session/system.test.ts`        | Expanded to 216 lines — system prompt + skills.   |

### Skipped tests

See the skip audit table in [Known technical debt](#known-technical-debt) below for
the current classification of every `.skip` site in `packages/opencode/test/`. The
former blockers — `test/session/history.test.ts` and
`test/cli/cmd/providers-quota.test.ts` — were un-skipped in commit `9021ae3fc`
once `Session.Interface` and `providers.ts` regained the missing exports.

---

## Known technical debt

> Status as of the post-parity audit (April 2026). All original `TODO(unify)` markers
> in `packages/opencode/src/**` have been closed by the autobest/providers restore
> batch (`df811c5ec`, `a9dcda88e`, `d37c7ea64`, `f408471a9`, `9021ae3fc`). `rg
> 'TODO\(unify\)' packages/opencode/src packages/opencode/test` now returns empty.

### Closed items (for historical reference)

| Item                                                                                     | Closed by     |
| ---------------------------------------------------------------------------------------- | ------------- |
| `Session.Interface` autobest methods (`setAutobest`, `getAutobestEnabled`, `applyAutobest`, `appendUserText`) | `df811c5ec`   |
| `@ts-expect-error` / `as any` casts in `session/autobest-observer.ts`                    | `a9dcda88e`   |
| `/session/:sessionID/autobest*` endpoints returning `501 { skipped: true }`              | `d37c7ea64`   |
| `/session/:sessionID/timer/drain?inject=true` stubbed with `void param; void items;`     | `d37c7ea64` (now calls `Session.appendUserText`, see `server/instance/session.ts:268`) |
| Restored `providers.ts` CLI surface (`accountStatus`, `ProvidersAccountsCommand`, `ProvidersRouteDebugCommand`, `copilotAlias*`, `applyProxy`, `jsonMigration`) | `f408471a9`   |
| `test/session/history.test.ts` and `test/cli/cmd/providers-quota.test.ts` un-skipped     | `9021ae3fc`   |
| Effect R-channel drift in `app-runtime.ts`                                               | `6c1dcb8a9`   |
| History subsystem behavior alignment with tests                                          | `92e75a8ec`   |
| `thread.ts` `/request_permissions` + `/request_user_input` alias wiring                  | `5e4e08857`   |
| Providers-quota tests alignment                                                          | `f8ae678f0`   |

### Open items

| Severity | Location                                                           | Description                                                                                                           |
| -------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| low      | `packages/opencode/src/cli/cmd/tui/plugin/api.tsx:158-160`         | `state.session.autobest()` casts sync data via `as ReturnType<…>` — the sync-layer shape for `session_autobest` is typed loosely. Fine at runtime; tighten when the sync payload schema is formalised. |
| low      | `packages/opencode/src/session/prompt.ts:1537-1554`                | Inline autobest extraction duplicates the observer logic; both paths run in parallel after an idle session, wasting a scan. Consolidate once the observer is proven redundant (or drop the inline path). |
| low      | `packages/opencode/test/session/session.test.ts:52,83,140`         | `session.created` + step-finish token bus-event assertions fail intermittently — the observer additions may have altered emit ordering. Needs investigation, not a fork-specific regression per se. |
| low      | `packages/opencode/test/session/prompt-effect.test.ts:1304-1421`   | Five shell/cancel/loop tests flake with `Exit.isSuccess === false`. Likely fallout from autobest inline extraction running after `lastAssistant`. Re-evaluate after prompt.ts consolidation above. |
| env      | `packages/opencode/test/project/vcs.test.ts` (`BranchUpdated`)     | Native `@parcel/watcher` binding required; flakes under local bun runner with the current FS events layer. Gated by `FileWatcher.hasNativeBinding() && !process.env.CI`; occasional timeout when native watcher stalls on macOS. |

### Test skip audit

Every `.skip*` site in `packages/opencode/test/`, classified as either
**environment-conditional** (will run on the right host) or **permanent tech debt**
(not gated on environment, requires code action to re-enable).

| File / line                                                                 | Kind         | Classification | Rationale |
| --------------------------------------------------------------------------- | ------------ | -------------- | --------- |
| `test/session/structured-output-integration.test.ts:31,85,154,196`          | `test.skipIf(!hasApiKey)` | env-conditional | Requires a real provider API key; runs when `ANTHROPIC_API_KEY`/equivalent is set. |
| `test/session/llm.test.ts:1275` "github copilot alias provider ids resolve…" | `test.skip`  | **permanent tech debt** | Alias resolver isn't wired through `getModel()` for `github-copilot#edu`/`#enterprise`/`#personal`/`#free`; needs ProviderRegistry.alias work. |
| `test/file/watcher.test.ts:14`                                              | `describe.skip` via `FileWatcher.hasNativeBinding() && !process.env.CI` | env-conditional | Native `@parcel/watcher` binding missing on Linux CI, flaky on Windows. Runs locally on macOS/Linux with binding. |
| `test/project/vcs.test.ts:14`                                               | `describe.skip` via `FileWatcher.hasNativeBinding() && !process.env.CI` | env-conditional | Same native-binding gate as watcher.test. |
| `test/project/worktree.test.ts:13`                                          | `it.live.skip` on `win32` | env-conditional | POSIX-only worktree test. |
| `test/project/worktree-remove.test.ts:12`                                   | `it.live.skip` when **not** `win32` | env-conditional | Windows-only worktree-remove test. |
| `test/file/fsmonitor.test.ts:15`                                            | `test.skip` when **not** `win32` | env-conditional | Windows-only fsmonitor code path. |
| `test/config/tui.test.ts:15`                                                | `test.skip` when **not** `win32` | env-conditional | Windows-only TUI config invalidation path. |
| `test/tool/bash.test.ts:1032` "captures stderr in output"                   | `test.skipIf(win32)` | env-conditional | Relies on POSIX shell semantics for stderr capture. |
| `test/session/prompt-effect.test.ts:215`                                    | `it.live.skip` on `win32` | env-conditional | Local `unix`-only alias used in subsequent tests. |
| `test/snapshot/snapshot.test.ts:374` "unicode filenames modification and restore" | `test.skip` | **permanent tech debt** | Never gated on env; flagged broken at authoring time. Unicode paths (CJK, Cyrillic) don't round-trip through the snapshot store; needs encoding fix in `Snapshot.track()`. |
| `test/lib/effect.ts:29,38`                                                  | library helper | n/a | Re-exports `test.skip` as `effect.skip`/`live.skip` for use by other tests. Not a skip itself. |

### Current test suite state (post-batch)

Full `bun test` on `unify/copilot-plan` HEAD (`edcb0ce7e`):

```
2143 pass
  12 skip
   1 todo
  10 fail
   1 error  (BranchUpdated watcher timeout — same root cause as the vcs failures)
9686 expect() calls
Ran 2166 tests across 177 files
```

Remaining failures, all reproducible on `dev` under the same local conditions:

| Test                                                                                     | Category |
| ---------------------------------------------------------------------------------------- | -------- |
| `Vcs > publishes BranchUpdated when .git/HEAD changes` (timeout 5000 ms)                 | native-watcher |
| `Vcs > branch() reflects the new branch after HEAD change` (timeout 5000 ms)             | native-watcher |
| `SyncEvent > run > emits events` (timeout 5000 ms)                                       | bus-wait timeout |
| `running task tool preserves metadata after tool-call transition`                        | prompt-effect flake |
| `cancel interrupts shell and resolves cleanly`                                           | shell/cancel flake |
| `cancel persists aborted shell result when shell ignores TERM`                           | shell/cancel flake |
| `cancel interrupts loop queued behind shell`                                             | shell/cancel flake |
| `session.created event > should emit session.created event when session is created`     | bus-event ordering |
| `session.created event > session.created event should be emitted before session.updated` | bus-event ordering |
| `step-finish token propagation via Bus event > non-zero tokens propagate through PartUpdated event` | bus-event ordering |

Three clusters:

1. **Watcher / bus-wait timeouts** (3 + 1 unhandled error) — all `@parcel/watcher`
   or subscribe-and-wait patterns that hit exact 5000 ms ceilings. Sensitive to
   native binding + FS-event latency on macOS.
2. **`prompt-effect.test.ts` shell/cancel flakes** (4 tests) — `Exit.isSuccess ===
   false` on shell TERM / loop cancel. Likely interacts with the inline autobest
   extraction added in `prompt.ts` (see open-items table); warrants isolating the
   autobest call behind a flag to confirm.
3. **`session.test.ts` bus-event ordering** (3 tests) — `Session.Service.create`
   dispatches `Event.Created` via `SyncEvent.run` but `Event.Updated` via
   `bus.publish`, so a `Bus.subscribe(Event.Created)` caller never sees Created.
   Pre-existing architectural quirk exposed by new tests, not a regression from the
   unify batch.

---

## Migration notes

### Nested Copilot layout (breaking for internal consumers)

Before this branch, Copilot code lived at `packages/opencode/src/plugin/copilot-*.ts`
(flat layout). Those files were **deleted** in commit `6c0c9b7c9` and replaced by the
nested `packages/opencode/src/plugin/github-copilot/` package. Consumers who imported
from the old flat paths must update to the new nested module:

| Old import                     | New import                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `@/plugin/copilot-auth`        | `@/plugin/github-copilot/auth`                                                 |
| `@/plugin/copilot-quota`       | `@/plugin/github-copilot/quota`                                                |
| `@/plugin/copilot-models`      | `@/plugin/github-copilot/models`                                               |
| `@/plugin/copilot-runtime`     | `@/plugin/github-copilot/runtime`                                              |
| `@/plugin/copilot-connections` | `@/plugin/github-copilot/connections`                                          |
| `@/plugin/copilot`             | `@/plugin/github-copilot/copilot` (`CopilotAuthPlugin`, `CopilotRuntimeState`) |

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
- `/session/:id/autobest*` is fully wired to `Session.applyAutobest` / `setAutobestEnabled` (since `d37c7ea64`); the prior `501 { skipped: true }` stubs are gone.
- `GET /timer` returns an instance-wide list; `GET /session/:id/timer` returns the same because timers are scoped to the instance directory rather than the session. This is intentional and will stay that way until sessions grow their own timer scope.
- `/session/:id/timer/drain?inject=true` re-injects fired timers as synthesised user text via `Session.appendUserText`.

### Operational notes for Copilot

- Setting `OPENCODE_COPILOT_RUNTIME_LIMIT=2+` enables true parallel dispatch across a single account. Most users want to keep the default of `1`.
- Enterprise hosts are detected via `enterpriseUrl` on the OAuth record; the API base becomes `https://copilot-api.<domain>`.
- Setting `connections.<key>.proxyUrl` in `copilot-connections.json` routes that account's traffic through a proxy, with optional `proxyToken` sent as `x-copilot-proxy-token`.
- A 429 response blocks the account for 11 minutes (wall-clock, not monotonic). A discovery error blocks discovery rank promotion for 30 minutes.

---

## Rounds 4–7 additions (v`1.4.6-unify.1`)

After the initial merge the fork continued in four additional rounds, each run as 8 parallel feature streams + an integrator. Summary of what each round delivered on top of the baseline in the sections above.

### Round 4 — close R3 residuals

| Area | Change | Commit(s) |
|---|---|---|
| `SessionPrompt.runLoop` | `AdaptiveHooks.Inject` directive converts into real synthetic `MessageV2.User{synthetic:true}` + re-enters the loop | `f76766f24`, `b3eed66c7` |
| `subagent/guardian.ts` | Full guardian routing: `parentOf` + `Question.Event.ForwardedToParent` + auto-approval via parent's permission ruleset | `343f85196` |
| `SessionPrompt.runStopHook` | ChildProcess-backed runner + preBreak observer walking `experimental.hooks.stopHooks[]` | `2fd2158b9` |
| `app-runtime.ts` | Removed speculative R-channel cast — `Database.use()` is sync, Memory layer has `R=never` natively | `45cf0b0c4` |
| `src/embedding/` | Extracted `Embedding.Service` + LocalTfIdf provider + `hybridRank` (0.4×BM25 + 0.6×cosine) | `a4d02f698` |
| Memory extractor | Lazy LLM bridge resolution inside `ensureRegistered` closure (fixes 38 prompt-effect regressions from eager layer-time resolution) | `cb2bb19a3` |
| Observer consolidation | `SessionAutobestObserver.Service`/`layer`/`defaultLayer` markers removed; pure helpers + `ensureRegistered` only. autosteer migrated to `AdaptiveHooks.postIteration` | `9e0164573` |

### Round 5 — architectural features

| Area | Change | Commit(s) |
|---|---|---|
| **BlackBird client** | `plugin/github-copilot/blackbird.ts` (~490 LOC) — Copilot embeddings / chunks / code-search client | `9c2e60281` |
| **Account transfer** | `plugin/github-copilot/transfer.ts` + `providers export`/`providers import` CLI | `09cb95730` |
| **CopilotRateLimiter** | Adaptive semaphore, 10-min sliding 429 window, FIFO waiter queue | `2cfe3f0eb` |
| **AccountPool RAII** | `acquirePreferSecondary`, primary/backup split, typed `AcquireTimeoutError`, `Symbol.asyncDispose` | `4ad0458bf` |
| **Parent-UI forwarded modal** | TUI inline prompt on `Question.Event.ForwardedToParent` with FIFO queue + dedupe | `9552e9303` |
| **Memory hybrid retrieval** | `Bm25MemoryIndex` over sextuples; default `retrieval.mode = hybrid` | `09a09dbd3` |

### Round 6 — residual codex_git features

| Stream | Feature |
|---|---|
| **A** | **Hooks system** — 21 event kinds, subprocess dispatcher, config `experimental.hooks.<EventName>[]` |
| **B** | **multi_agents tool family** — `task-wait`, `task-send-input`, `task-close`, `task-list` + `SubagentRegistry` extensions |
| **C** | **Exec-policy DSL + Keyring** — YAML/JSONC rule DSL with ReDoS guards + `keytar` + AES-256-GCM fallback |
| **D** | **Connectors + apps directory** — `[$name](app://id)` parser, 8 bundled apps, MCP adapter |
| **E** | **ACP server parity** — elicitation, plan-mode, replay capability |
| **F** | **Shared HTTP stack** — typed errors, retry with jitter, custom-CA |
| **G** | **Rollout/replay foundation** — JSONL append-only with resume + pure replay |
| **H** | **Skill router + builtins + memory polish** — RRF/Boltzmann router, 8 builtin skills, `refining-llm.ts` LLM polish |

### Round 7 — hooks integration at call sites

All 10 hook event points are now wired into production code:

| Call site | Hook events | Commit |
|---|---|---|
| `tool/registry.ts` execute wrapper | PreToolUse (abort/deny/ask/updatedInput) → PostToolUse (updatedOutput) | `4f573dc3f` |
| `session/session.ts` | SessionStart / SessionEnd (with `rolloutPath`, `reason`) | `008720706` |
| `tool/task.ts` + `subagent/registry.ts` | SubagentStart / SubagentStop with `reason: completed\|cancelled\|failed` | `2ebadc926` |
| `session/prompt.ts` runLoop | TurnStart → UserMessage → AssistantMessage → TurnStop (ULID per turn, with `finish_reason`) | `b79852aea` |
| `permission/index.ts` + `question/index.ts` | PermissionRequest (short-circuitable) → PermissionGranted/Denied with `source` enum | `c36cbf75b` |
| `session/compaction.ts` | PreCompact (with metrics) → PostCompact (summary). Deny cancels compaction | `8c0f289be` |
| `mcp/connectors.ts` | `invokeConnector(app, toolName, args)` via `MCP.Service.tools()` | `5487703ce` |
| `acp/replay.ts` | Real replay via `Rollout.Replay.replayToEmitter` streaming `session/update` chunks | `5487703ce` |

### Configuration surface added through R4–R7

```yaml
# opencode.json example
{
  "experimental": {
    "hooks": {
      "PreToolUse": [{"name": "audit", "command": "/path/to/audit.sh", "matcher": "bash|write", "timeoutMs": 5000}],
      "PostToolUse": [], "SessionStart": [], "SubagentStart": [], "Stop": [],
      "stopHooks": []
    },
    "subagent": { "maxConcurrent": 8, "depthLimit": 3, "autoWaitTimeoutMs": 300000 }
  },
  "memories": {
    "enabled": false,
    "retrieval": { "mode": "hybrid", "bm25Weight": 0.4, "embeddingWeight": 0.6 }
  },
  "skills": {
    "autoskill": true, "builtin": true,
    "router": { "kind": "rrf" }
  },
  "autobest": { "enabled": true, "maxIterations": 3 },
  "autosteering": { "enabled": true },
  "copilot": {
    "rateLimiter": { "enabled": true, "maxConcurrent": 7, "threshold": 0.2 }
  }
}
```

### Environment variables added through R4–R7

| Env | Purpose |
|---|---|
| `OPENCODE_USE_KEYRING=1` | Route credentials through OS keyring (keytar) with AES-256-GCM fallback |
| `OPENCODE_KEYRING_DISABLE=1` | Force fallback file store even when keytar available |
| `OPENCODE_ALLOW_TEST_ACCOUNTS=1` | Include `github-copilot#edu-*` accounts in routing |
| `OPENCODE_COPILOT_PROXY_ENVELOPE=1` | Use Rust-compatible `POST {proxy}/fetch` envelope |
| `OPENCODE_COPILOT_RATE_LIMITER_*` | Override `rateLimiter.*` config per-process |
| `OPENCODE_DISABLE_BUILTIN_SKILLS=1` | Disable 8 bundled builtin skills |
| `OPENCODE_EMBEDDING_PROVIDER=local\|api\|none` | Force TF-IDF local / API / disabled embedding |

### Upgrade isolation

Auto-updater queries `https://api.github.com/repos/apstenku123/opencode/releases/latest` (not upstream `anomalyco/opencode`). Only tags published to **this fork** trigger upgrade prompts. Upstream releases cannot auto-update over the unify branch.

### Test surface summary

| Milestone | Pass count |
|---|---|
| Pre-merge baseline (`dev`) | 1378 |
| R1–R3 integration | 2785 |
| R4 (close TODOs) | 2835 |
| R5 (architectural) | 2941 |
| R6 (residual codex_git) | 3214 |
| **R7 (hook integration + connector runtime + replay bridge)** | **3258** |

Pre-push hook (`bun turbo typecheck`) passes across all 13 packages without `--no-verify` at HEAD.

---

## Round 8 — Copilot auth discovery, pool routing, envelope proxy, providers CLI

Round 8 expands the GitHub Copilot surface to cover the full codex_git feature parity
around multi-source credential discovery, explicit edu/prod pool routing, the
Rust-compatible `POST {proxy}/fetch` GCP envelope protocol, and a richly instrumented
`providers accounts` display. All work lives under
`packages/opencode/src/plugin/github-copilot/` and `packages/opencode/src/cli/cmd/providers.ts`;
no server-instance Copilot routes ship in this round (those are being added under a
parallel effort).

### 8.1 Multi-source auth discovery

On every `allAuth()` invocation (CLI boot, `providers login`, `providers accounts`,
`providers quota`) the plugin drains a cascade of on-disk credential stores via
`CopilotAuth.migrate()` (`packages/opencode/src/plugin/github-copilot/auth.ts:282`).
Credentials are deduped by final account `key` *and* by raw `refresh` token so the same
OAuth token can never register under two slot names.

| Source | Path | Import gate | Parser |
| ------ | ---- | ----------- | ------ |
| Legacy CLI credential | `~/.copilot/auth/credential.json` | always | `legacy()` (flat `{token, login, proxy_url?, proxy_token?}` or keyed `{host: {...}}`) |
| macOS Application Support store | `~/Library/Application Support/opencode/auth.json` | always (macOS) | `opencodeNative()` — keyed `{"github-copilot#edu-N": {type, refresh, access, proxy_url?, ...}}` |
| VS Code / Neovim multiplexer | `~/.config/github-copilot/apps.json` | `OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1` | `apps()` — each `"<host>:<githubAppId>"` slot becomes `github-copilot#app-<slug>` |
| Copilot CLI oauth store | `~/.config/github-copilot/oauth.json` | `OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1` | `oauth()` — each `{host: [{accessToken, account}]}` session becomes `github-copilot#oauth-<slug>` |
| Forge CLI credentials | `~/forge/.credentials.json` | `OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1` | `forge()` — `id: "github_copilot"` entries become `github-copilot#forge-<slug>` |
| Codedash profile | `~/.codedash/github-profile.json` | `OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1` | `codedash()` — single `{username, token}` becomes `github-copilot#codedash-<user>` |
| Env-provided test tokens | `OPENCODE_TEST_COPILOT_TOKENS` env var | always | `testTokensFromEnv()` — comma-separated tokens become `github-copilot#edu-N` slots |
| Config test accounts | `[copilot.testAccounts]` section | always | `testAccountsFromConfig()` — see 8.6 |

Cascade precedence: macOS Application Support wins over `~/.copilot/auth/credential.json`
for the same key because primary sources are listed in that order in `allFound`
(`auth.ts:301-304`). All six on-disk sources plus env + config tokens are merged, then
filtered to drop any key that already exists in `Auth.Service.all()` — re-runs are
idempotent and no duplicate will be imported.

Path constants live in `packages/opencode/src/plugin/github-copilot/paths.ts`. The
migration marker is recorded at `~/.local/share/opencode/copilot-migration.json`
(`migrationFile`) with `{version, migratedAt, source, keys, skipped}`; subsequent
boots respect this marker.

**Proxy imports.** When a parsed credential carries `proxy_url` (legacy /
opencode-native) or `proxy_token` the value is stashed in the transient
`proxyImports` map (`auth.ts:280`). Call sites (`providers.ts:85-101`) drain this into
`copilot-connections.json`, forcing `envelope: true` for those accounts — the Rust CLI
always envelopes through the GCP fetch-proxy.

**Configure.** No opencode.json key gates the legacy migration — it always runs.
To enable import from VS Code / Forge / Codedash stores:

```bash
# Opt in to secondary IDE / tool stores
export OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1

# Supply test tokens inline (comma-separated)
export OPENCODE_TEST_COPILOT_TOKENS='ghu_test1,ghu_test2,ghu_test3'

# Allow test accounts (otherwise `github-copilot#edu-*` keys are
# filtered out of production routing)
export OPENCODE_ALLOW_TEST_ACCOUNTS=1
```

### 8.2 Pool routing (edu vs prod)

`packages/opencode/src/plugin/github-copilot/pool-routing.ts` introduces an explicit
account-pool policy. Two pools:

- `edu` — free / unlimited / individual / `github-copilot#edu-*` test slots.
- `prod` — pro / enterprise / business / team.

Model → pool mapping is explicit rather than substring-matched. `DEFAULT_POOL_RULES`
(`pool-routing.ts:53`):

```ts
{
  "codex-5.3":              "edu",
  "codex-5.3-xhigh":        "edu",
  "gpt-5.4":                "prod",
  "gpt-5.4-xhigh":          "prod",
  "claude-4.7-opus-high":   "prod",
  "claude-sonnet-4.7":      "prod",
}
```

`gateModel(modelId, cfg)` (`pool-routing.ts:111`) performs two checks:

1. `xhighOnly` gate — for families listed in `DEFAULT_XHIGH_ONLY`
   (default `["gpt-5.4", "codex-5.3"]`), only the `-xhigh` variant is permitted.
   Non-xhigh requests return `{allow: false, reason: "only xhigh variants permitted
   for <family>"}`.
2. Pool lookup — `poolFor(modelId, cfg)` returns `"edu" | "prod" | undefined`.
   When undefined the dispatcher falls back to legacy `policyPlan` substring
   behaviour so `gpt-5-enterprise` / `gpt-4.1-edu` aliases still work.

`poolForAccount({key, plan, cfg})` (`pool-routing.ts:134`) classifies a given account:

- Explicit `cfg.pools.edu` / `cfg.pools.prod` membership wins.
- Keys matching `github-copilot#edu-*` always classify as `edu` regardless of plan
  (mirrors codex_git `connections.rs:217`).
- Plan `edu` / `free` / `individual` → `edu` pool.
- Plan `enterprise` / `pro` / `business` / `team` → `prod` pool.
- Otherwise `undefined`.

`copilot.ts::dispatch()` resolves the pool via `getPoolRoutingConfig()` (module-level
seed set by `CopilotAuthPlugin` boot, `copilot.ts:60-68`) and narrows the routing pool
via `preferPlan` + `preferPolicy`.

#### `[copilot.poolRouting]` config section

```jsonc
// ~/.config/opencode/opencode.json
{
  "copilot": {
    "poolRouting": {
      // Pin specific account keys to a pool, overriding plan-derived defaults.
      "pools": {
        "edu":  ["github-copilot#codedash-alice"],
        "prod": ["github-copilot#work-team"]
      },
      // Extend or override the default model → pool map.
      "models": {
        "gpt-5.4-xhigh":        "edu",   // pilot an enterprise model on edu accounts
        "custom-preview-model": "prod"
      },
      // Only accept -xhigh variants for these family prefixes.
      "xhighOnly": ["gpt-5.4", "codex-5.3"]
    }
  }
}
```

Schema defined in `packages/opencode/src/config/config.ts:255-285`.

#### `[copilot.testAccounts]` config section

Mirrors codex_git's `[test_accounts]` TOML section (`codex-rs/core/src/config/types.rs::TestAccountsToml`).
Synthesises `github-copilot#edu-<slug>` slots from config rather than env.

```jsonc
{
  "copilot": {
    "testAccounts": {
      "tokens":          ["ghu_xxx1", "ghu_xxx2"],
      "labels":          ["pilot-a", "pilot-b"],
      "supportedModels": ["gpt-4.1", "gpt-5-mini-xhigh"],
      "proxyUrls": [
        "https://us-central1-project.run.app",
        "https://us-east1-project.run.app"
      ]
    }
  }
}
```

`testAccountsFromConfig(section)` is resolved in
`packages/opencode/src/cli/cmd/providers.ts:60-84` from
`Config.Service.use((c) => c.getGlobal())` — note `getGlobal()` skips project-level
`opencode.json` overlays, so test tokens must live in `~/.config/opencode/opencode.json`.

Each `proxyUrls[i]` is paired with `tokens[i]` (and enables envelope protocol).
Labels are index-matched; missing labels default to the synthetic `edu-<N>` form.
Schema: `config.ts:334-360`.

**Operator gating.**

| Env var | Purpose |
| ------- | ------- |
| `OPENCODE_TEST_COPILOT_TOKENS` | Comma-separated tokens registered as `github-copilot#edu-N` slots (env-driven equivalent of `[copilot.testAccounts].tokens`). |
| `OPENCODE_ALLOW_TEST_ACCOUNTS=1` | Include `github-copilot#edu-*` accounts in routing (pool.ts::`filterTestAccounts`). Otherwise they are hidden from production dispatch. |
| `OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1` | Enable import of VS Code apps.json, Copilot oauth.json, Forge, Codedash stores. |

### 8.3 GCP envelope proxy (`POST {proxy}/fetch`)

The Rust CLI routes Copilot traffic through a Cloud-Run / regional fetch-proxy that
speaks a JSON envelope protocol. The TS fork ships a compatible implementation so the
same per-account GCP proxies keep working.

- `envelopeEnabled(cfg)` (`copilot.ts:727`) — `true` when `cfg.envelope === true`
  OR env `OPENCODE_COPILOT_PROXY_ENVELOPE=1`.
- `envelopeFetch(request, init, {url, token})` (`copilot.ts:774`) — `POST {proxy}/fetch`
  with JSON body `{url, method, headers, body, timeout_ms}`. Proxy response is
  `{status_code, headers, body}`; callers receive a normal `Response` reconstructed from
  the envelope.
- `routedFetch(request, init, cfg)` (`copilot.ts:828`) — dispatches through envelope
  when `cfg?.envelope`, otherwise legacy URL-rewrite.
- `ENVELOPE_STRIP_HEADERS = {content-length, host}` filters headers that would be
  wrong if forwarded verbatim (`copilot.ts:738`).
- Timeout advertised in the envelope: `PROXY_FETCH_TIMEOUT_SEC = 120` (matches Rust
  `http_get_via_proxy`).

**Per-account regional proxies.** `Conn.proxyUrl` (`connections.ts:28`) is a free-form
URL so operators can pin each Copilot account to a distinct regional Cloud-Run
fetch-proxy for IP rotation / geo-affinity:

```
https://us-central1-project.a.run.app
https://us-east1-project.a.run.app
https://europe-west1-project.a.run.app
https://asia-northeast1-project.a.run.app
```

`Conn.envelope: true` forces the envelope protocol for that account. Set automatically
when credentials are drained from `~/.copilot/auth/credential.json` (the Rust CLI
always envelopes) or injected via `[copilot.testAccounts].proxyUrls`.

Coverage in `/copilot_internal/user` (quota.ts:88-132), `/models` discovery
(`models.ts:321-330`), chat/completions dispatch (`copilot.ts:828-870`), and
BlackBird (`blackbird.ts:158-200`).

**Env override.** `OPENCODE_COPILOT_PROXY_ENVELOPE=1` opts every proxy into envelope
mode regardless of `Conn.envelope`.

**Configure.**

```bash
# Opt every Copilot proxy into envelope protocol
export OPENCODE_COPILOT_PROXY_ENVELOPE=1
```

```bash
# Per-account: set proxy via CLI
opencode providers proxy --provider github-copilot#edu-1 \
  --url https://us-central1-project.a.run.app --token "$GCP_TOKEN"
```

Direct edit of `~/.local/share/opencode/copilot-connections.json`:

```jsonc
{
  "version": 1,
  "connections": {
    "github-copilot#edu-1": {
      "proxyUrl":   "https://us-central1-project.a.run.app",
      "proxyToken": "…",
      "envelope":   true
    },
    "github-copilot#edu-2": {
      "proxyUrl":   "https://asia-northeast1-project.a.run.app",
      "proxyToken": "…",
      "envelope":   true
    }
  }
}
```

### 8.4 `providers accounts` display

`ProvidersAccountsCommand` (`providers.ts:1422`) renders a per-account card backed by
`renderAccountStatus()` (`providers.ts:641`) with the following new fields:

- `Pool: edu|prod|<none>` — resolved via `accountPoolLabel(key, plan)`
  (pool-routing config honoured).
- `Machine ID: <uuid>` — stable per-account machine id from `Conn.machineId`.
- `Proxy: <url> (envelope)` — shows `proxyUrl`; appends `(envelope)` when
  `envelope === true`.
- `Allowed (prod): …` — comma-separated models the pool is allowed to dispatch for
  production traffic, derived from `poolAllowedProdModels(pool)`.
- `Allowed (test-only): …` — models routed only when the account is consumed as a
  test slot, from `poolAllowedTestModels(pool)`.
- `best <model>` — on the following line per account; reflects the pool-routing
  default, NOT the raw `/models` discovery cache.
  Implementation: `renderBestPerVendor(state)` (`providers.ts:1013`) — when a pool
  is assigned, `best` is the first entry of `poolAllowedProdModels(pool)`. Unpooled
  accounts fall back to vendor-grouped picks from `CopilotModels.bestPerVendor`.
- Migration banner (`Migration: <text>`, `Migration source: <path>`, `Migration at: <ISO>`)
  sourced from `resolveMigrationSummary()`.

**Auto-deactivation.** In `loadAccountStatuses()` (`providers.ts:712`) any Copilot
account that returns 401 / 403 from `/copilot_internal/user` is added to
`newlyDeactivated` and persisted via `markDeactivated(state, key)`
(`connections.ts`). The next `providers accounts` run filters these out by default
(`providers.ts:1436-1441`); pass `--all` to include them. The footer reads
`N accounts (K deactivated hidden — pass --all to show)`.

#### Example output

```
◇  Migration: migrated 4 legacy Copilot accounts
│  Migration source: /Users/dave/.copilot/auth/credential.json
│  Migration at: 2026-04-18T12:34:56.789Z
│
◇  Primary proxy on, pool=prod, discovery fresh
│    Login: dave-github
│    Plan: pro
│    Machine ID: 5a3c9d2e-1e2f-4b7a-9d6e-1f2a3b4c5d6e
│    Proxy: https://us-central1-project.a.run.app (envelope)
│    Health: ok
│    Discovery: ok, 23 picker-enabled models
│    Allowed (prod):      gpt-5.4-xhigh, claude-4.7-opus-high
│    Allowed (test-only): gpt-4.1, gpt-5-mini-xhigh
│    Premium: premium 120 / 500 (resets 2026-05-01)
│
◇  edu-1 proxy on, pool=edu, discovery fresh
│    Login: alice
│    Plan: edu
│    Machine ID: 7b4d1a0c-aa22-4c33-bb44-55d66e77f88a
│    Proxy: https://asia-northeast1-project.a.run.app (envelope)
│    Health: ok
│    Discovery: ok, 18 picker-enabled models
│    Allowed (prod):      codex-5.3-xhigh
│    Allowed (test-only): gpt-4.1, gpt-5-mini-xhigh
│
◇  Primary   best gpt-5.4-xhigh (option: claude-4.7-opus-high)
│  edu-1     best codex-5.3-xhigh
│
└  2 accounts (1 deactivated hidden — pass --all to show)
```

The `--json` output embeds the same shape under a stable envelope:

```jsonc
{
  "schemaVersion": 1,
  "migration": { "migrated": 4, "text": "…", "source": "…", "migratedAt": 1700000000000, "skipped": false },
  "health":    [ /* checkAccountStatuses() triage */ ],
  "bestPerVendor": { "github-copilot": [ /* per-vendor picks */ ] },
  "items": [
    {
      "schemaVersion": 1,
      "info":   { "refresh": "…", "enterpriseUrl": null },
      "quota":  { /* Quota */ },
      "proxy":  { "url": "…", "token": "…", "envelope": true },
      "status": {
        "schemaVersion": 1,
        "key":                "github-copilot",
        "label":              "Primary",
        "pool":               "prod",
        "proxyUrl":           "https://us-central1-project.a.run.app",
        "envelope":           true,
        "machineId":          "5a3c9d2e-…",
        "allowedProdModels":  ["gpt-5.4-xhigh", "claude-4.7-opus-high"],
        "allowedTestModels":  ["gpt-4.1", "gpt-5-mini-xhigh"],
        "health":             "ok",
        "quota":              { /* … */ },
        "discovery":          { "ok": true, "models": ["…"] },
        "route":              { "discovery": 3, "penalty": 0, "load": 0, "cooldown": false, "routeReason": ["lane:prod"] }
      },
      "triage": { "health": "healthy", "premium": { /* … */ } }
    }
  ]
}
```

Schema version `ACCOUNT_STATUS_SCHEMA_VERSION = 1` (`providers.ts:378`).

### 8.5 CLI commands

Full `opencode providers` command tree (`packages/opencode/src/cli/cmd/providers.ts:987`):

| Command | Description |
| ------- | ----------- |
| `opencode providers list` / `ls` | List providers + credentials + cached per-account "best" pick. |
| `opencode providers login [url] [--provider <id>] [--method <label>]` | Interactive OAuth / API-key login. `--provider` skips the select picker; `--method` skips the method picker. |
| `opencode providers logout` | Remove a credential (select from list). |
| `opencode providers quota [--json]` | Print per-account quota (`formatQuotaBar`). `--json` emits stable schema envelope. |
| `opencode providers accounts [--json] [--all]` | Rich per-account status card (see 8.4). `--all` includes deactivated accounts. |
| `opencode providers route-debug [model] [--provider <id>] [--account <key>] [--all-accounts] [--all-models] [--summary-only] [--json]` | Show routing candidates, lane, discovery rank, penalty, selected/rejected reasons. Defaults to `gpt-5-mini`. `--all-models` iterates `{gpt-5-mini, gpt-4.1, gpt-5-enterprise, gpt-4.1-edu}` and emits a summary with win rates + rejection breakdown by lane/penalty/discovery. |
| `opencode providers proxy [--provider <key>] [--url <url>] [--token <token>] [--list]` | Configure per-account proxy URL + token. `--list` prints the current proxy map. Omitting `--url` clears the proxy; omitting `--token` leaves it unset. Writes to `copilot-connections.json`. |
| `opencode providers export [--out <path>] [--plain\|--base64] [--redact-tokens] [--exported-by <label>]` | Emit portable JSON bundle (version 1) with every Copilot OAuth credential + connection metadata. `--redact-tokens` strips `refresh`/`proxyToken` (sets `redacted: true` in envelope). `--base64` wraps for clipboard-safe sharing. Write to stdout by default, or `--out <path>`. |
| `opencode providers import <path>\|- [--merge\|--replace] [--dry-run] [--json]` | Import a bundle (base64 envelope auto-detected). `--merge` (default) upserts by `account.key`; `--replace` wipes existing `github-copilot*` accounts + connection state first; `--dry-run` reports without writing; `--json` emits machine-readable result. Version mismatch rejected by `parseBundle`. |

The root command accepts both `opencode providers …` and its alias `opencode auth …`.
Each command registers `--help` text via yargs' `describe` / option `describe` strings
above. Full command source: `packages/opencode/src/cli/cmd/providers.ts`.

**`route-debug` summary shape.** With `--all-models --json`:

```jsonc
{
  "schemaVersion": 1,
  "summary": {
    "wins":            { "github-copilot": 3, "github-copilot#edu-1": 1 },
    "topWinner":       "github-copilot",
    "topWinRate":      0.75,
    "topLoser":        "github-copilot#enterprise",
    "rejectionRate":   0.25,
    "modelCount":      4,
    "selectedCount":   3,
    "selectedRate":    0.75,
    "rejectedByLane":      2,
    "rejectedByPenalty":   1,
    "rejectedByDiscovery": 0,
    "byModel": {
      "gpt-5-mini":      { "selected": "github-copilot",          "winnerReason": ["lane:prod"], … },
      "gpt-4.1-edu":     { "selected": "github-copilot#edu-1",    "winnerReason": ["lane:edu"], … },
      "gpt-5-enterprise":{ "selected": null,                      "winnerReason": [], "rejectedByLane": 2, … }
    }
  },
  "models": [ /* per-model RouteDebugJSON */ ]
}
```

### 8.6 HTTP endpoints (status)

No Copilot-specific HTTP routes are mounted on `InstanceRoutes` at this commit — the
existing surface remains:

- `GET /session/:id/autobest`, `POST /session/:id/autobest*` — see
  [Server instance modifications](#server-instance-modifications).
- `GET /timer`, `GET /session/:id/timer`, lifecycle — see [Timer subsystem](#timer-subsystem).
- `/thread`, `/turn` aliases — see [Thread and Turn HTTP routes](#thread-and-turn-http-routes).

A parallel effort is adding `/copilot/accounts`, `/copilot/route-debug`, and
`/copilot/proxy` routes under `packages/opencode/src/server/instance/` that share the
shape of `providers accounts --json` / `providers route-debug --json` emit. Until those
land, clients should shell out to the CLI (`opencode providers accounts --json`) or
import the plugin helpers directly from
`@/cli/cmd/providers` (`loadAccountStatuses`, `loadRouteExplain`, `loadAccountHealth`)
for programmatic access.

### 8.7 Source cross-reference

| Feature | File(s) |
| ------- | ------- |
| Auth discovery cascade | `packages/opencode/src/plugin/github-copilot/auth.ts:282-376`, `paths.ts` |
| Source parsers | `auth.ts::legacy/apps/oauth/opencodeNative/forge/codedash/testTokensFromEnv/testAccountsFromConfig` |
| Pool routing policy | `packages/opencode/src/plugin/github-copilot/pool-routing.ts` |
| Pool-routing config binding | `packages/opencode/src/plugin/github-copilot/copilot.ts:60-72` (`setPoolRoutingConfig`, `getPoolRoutingConfig`, `resolveAccountPool`) |
| Config schema | `packages/opencode/src/config/config.ts:253-360` |
| Envelope proxy protocol | `packages/opencode/src/plugin/github-copilot/copilot.ts:710-870` (`envelopeEnabled`, `envelopeFetch`, `routedFetch`) |
| Envelope for quota / models / blackbird | `quota.ts:88-132`, `models.ts:321-330`, `blackbird.ts:158-200` |
| Account health triage | `packages/opencode/src/plugin/github-copilot/health.ts` |
| Providers CLI | `packages/opencode/src/cli/cmd/providers.ts` |
| Account display helpers | `providers.ts::renderAccountStatus/renderBestPerVendor/poolAllowedProdModels/poolAllowedTestModels` |
| JSON status envelope | `providers.ts::jsonStatus/jsonMigration` (`ACCOUNT_STATUS_SCHEMA_VERSION = 1`) |
| Auto-deactivation | `providers.ts:724-788` + `connections.ts::markDeactivated` |
| Test coverage | `test/cli/cmd/providers-quota.test.ts`, `test/plugin/github-copilot-auth.test.ts`, `test/plugin/github-copilot-connections.test.ts` |

### 8.8 Environment variables summary (Round 8)

| Env | Source | Effect |
| --- | ------ | ------ |
| `OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1` | `auth.ts:311` | Opt in to importing secondary IDE / tool credential stores (apps.json, oauth.json, Forge, Codedash). |
| `OPENCODE_TEST_COPILOT_TOKENS=tok1,tok2,…` | `auth.ts:297` | Register synthetic `github-copilot#edu-N` slots from comma-separated tokens. |
| `OPENCODE_ALLOW_TEST_ACCOUNTS=1` | `connections.ts:70` | Include `github-copilot#edu-*` keys in routing (otherwise hidden). |
| `OPENCODE_COPILOT_PROXY_ENVELOPE=1` | `copilot.ts:729`, `quota.ts:104`, `models.ts:328` | Force the Rust-compatible `POST {proxy}/fetch` envelope protocol for every configured proxy. |
| `OPENCODE_PROBE_DISCOVERY=0` | `providers.ts:794` | Disable the lazy `/models` discovery probe inside `providers accounts` (keeps the display purely from cached state; used by unit tests). |
| `OPENCODE_DEBUG_PROVIDERS=1` | `providers.ts:713` | Emit stderr trace lines from `loadAccountStatuses()` — useful when an account hangs mid-discovery. |

### 8.9 Full `opencode.json` snippet

```jsonc
// ~/.config/opencode/opencode.json — Copilot multi-account + pool routing +
// test accounts + per-account GCP envelope proxies.
{
  "copilot": {
    "poolRouting": {
      "pools": {
        "prod": ["github-copilot"],
        "edu":  ["github-copilot#edu-primary"]
      },
      "models": {
        "gpt-5.4-xhigh":       "prod",
        "claude-4.7-opus-high":"prod",
        "codex-5.3-xhigh":     "edu"
      },
      "xhighOnly": ["gpt-5.4", "codex-5.3"]
    },
    "testAccounts": {
      "tokens": ["ghu_pilotA", "ghu_pilotB"],
      "labels": ["pilot-a",    "pilot-b"],
      "supportedModels": ["gpt-4.1", "gpt-5-mini-xhigh"],
      "proxyUrls": [
        "https://us-central1-project.a.run.app",
        "https://europe-west1-project.a.run.app"
      ]
    },
    "rateLimiter": {
      "enabled":         true,
      "maxConcurrent":   7,
      "threshold":       0.2,
      "slidingWindowMs": 600000,
      "cleanWindowMs":   300000
    }
  },
  "provider": {
    "github-copilot": {
      "options": {
        "runtimeLimit":         1,
        "runtimeMinIntervalMs": 0
      }
    }
  }
}
```

Shell configuration for a typical multi-account operator:

```bash
# Enable extended auth discovery
export OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1

# Enable test accounts (if any are configured)
export OPENCODE_ALLOW_TEST_ACCOUNTS=1

# Force the GCP envelope proxy protocol globally
export OPENCODE_COPILOT_PROXY_ENVELOPE=1
```

Then at runtime:

```bash
# Review discovered accounts + their pool assignment
opencode providers accounts

# Review routing for a specific model
opencode providers route-debug gpt-5.4-xhigh --all-accounts

# Export a portable bundle (redacted, for sharing proxy/plan config)
opencode providers export --redact-tokens --out copilot-config.json

# On a second machine — import (dry-run first)
opencode providers import copilot-config.json --dry-run
opencode providers import copilot-config.json --merge
```

---

## HTTP retry-race (p99 latency lever)

Ported from codex_git's `codex-rs/core/src/client_retry_race.rs` in
commit `4893e9e1b`. The orchestrator spawns *duplicate* HTTP attempts
against different accounts/proxies after a stagger delay; first-to-
respond wins, siblings are aborted via `AbortController`. This
sidesteps the class of hangs where a POST is accepted but no SSE byte
ever arrives.

See `packages/opencode/src/plugin/github-copilot/retry-race.ts` for the
`raceFetch` generic + `HttpAttemptBus` observation surface, and
`copilot.ts::dispatchWithRace` for the Copilot-specific wiring.

### Default behaviour in this fork (enabled out of the box)

Unlike the Rust reference — which ships with `enabled: false` so
consumers opt in — the opencode fork ships `enabled: true` with tuned
defaults that trade a modest quota burn for real p99 reduction:

| Field              | Default        | Rationale                                                                                                         |
| ------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `enabled`          | `true`         | Fork's headline latency lever. Quota burn on the happy path is near zero because healthy turns finish before the stagger. |
| `staggerMs`        | `45_000` (45s) | Most healthy Copilot turns complete under 30s; 45s before firing a duplicate keeps the p50/p95 curve essentially unchanged. |
| `concurrentLimit`  | `2`            | 1 original + 1 backup. Worst-case quota burn ≤2× vs the Rust default's 3×.                                        |
| `maxAttempts`      | `3`            | Original + up to two staggered retries before surfacing `RetryRaceExhaustedError`.                                |
| `totalDeadlineMs`  | `180_000` (3 min) | Wall-clock upper bound. Accommodates slow SGR reasoning turns while still capping pathological hangs.           |
| `eventBusCapacity` | `64`           | Matches Rust `tokio::broadcast` capacity; sized to replay the most recent events for late-subscribed debug consumers. |

### Semantics in one paragraph

Attempt 1 fires at `t=0`. If no winner arrives inside `staggerMs`, attempt 2
fires — attempt 1 is **not** cancelled, it may still win. Further attempts
layer up to `concurrentLimit` in-flight and `maxAttempts` total. A single
attempt rejecting does **not** fail the race; siblings keep running. The
race surfaces a rejection only when every attempt has failed and the budget
is exhausted, or when `totalDeadlineMs` elapses without a winner —
producing `RetryRaceExhaustedError`. Observers subscribe via
`HttpAttemptBus` for `sent` / `firstByte` / `succeeded` / `failed` /
`canceled` / `exhausted` events.

### Disabling the race (rollback safety)

Users who want strict single-account budgets (e.g. strict quota
accounting, single-tenancy proxies) can flip the switch three ways:

1. **Environment variable** — highest precedence, no config file edit:

   ```bash
   export OPENCODE_COPILOT_HTTP_RETRY_RACE_ENABLED=false
   ```

2. **User config** — persists across shells:

   ```jsonc
   // ~/.config/opencode/opencode.json
   {
     "copilot": {
       "httpRetryRace": { "enabled": false }
     }
   }
   ```

3. **Field-level tuning** — reduce concurrency/deadline without
   disabling:

   ```jsonc
   {
     "copilot": {
       "httpRetryRace": {
         "staggerMs":       60000,
         "concurrentLimit": 1,
         "maxAttempts":     1
       }
     }
   }
   ```

Every field also has a matching `OPENCODE_COPILOT_HTTP_RETRY_RACE_*`
env override (e.g. `OPENCODE_COPILOT_HTTP_RETRY_RACE_STAGGER_MS=60000`);
env beats config which beats defaults. See `httpRetryRaceConfig()` in
`retry-race.ts` for the resolution order.

### Benchmark

`packages/opencode/test-e2e/bench_retry_race.py` fires N sequential
SGR turns with `format={type: "json_schema", schema: …}` and measures
wall-clock latency per turn with the race ON vs OFF. It reports p50 /
p95 / p99 for each configuration and asserts `p99_on < p99_off` so a
regression in the race's effectiveness is caught immediately. Run it
against the live `github-copilot` provider via:

```bash
cd packages/opencode/test-e2e
.venv/bin/python bench_retry_race.py
```

### Regression guard

`packages/opencode/test/plugin/github-copilot-retry-race-defaults.test.ts`
asserts every field of `DEFAULT_HTTP_RETRY_RACE_CONFIG` so an accidental
flip back to `enabled: false` (or a merge that resets the stagger to the
Rust default of 40s) surfaces as a unit-test failure.

---

## Copilot OTEL Telemetry (`copilot.telemetry`)

Port of the Rust `codex-otel` crate's `SessionTelemetry`,
`RequestTelemetry`, and `SseTelemetry` to TypeScript. Implemented in
`packages/opencode/src/plugin/github-copilot/telemetry.ts` and wired
into `dispatchOnce` + the 429 branch of `copilot.ts` so every HTTP
dispatch emits an OTEL counter + duration histogram when the exporter
is enabled.

### What it records

All metrics live under the `opencode.copilot.*` namespace with common
tags: `account_key`, `model`, `pool`, `status_code`, `success`,
`kind`, `tool`.

| Metric                                        | Type      | Tags                                   |
| --------------------------------------------- | --------- | -------------------------------------- |
| `opencode.copilot.api_request`                | counter   | account_key, model, pool, status_code  |
| `opencode.copilot.api_request.duration`       | histogram | account_key, model, pool, status_code  |
| `opencode.copilot.sse_event`                  | counter   | account_key, model, pool, kind, success |
| `opencode.copilot.sse_event.duration`         | histogram | account_key, model, pool, kind, success |
| `opencode.copilot.retries.429`                | counter   | account_key, model, pool               |
| `opencode.copilot.session.turns`              | counter   | model                                  |
| `opencode.copilot.session.tools`              | counter   | tool, model, success                   |
| `opencode.copilot.session.tokens.input`       | counter   | account_key, model                     |
| `opencode.copilot.session.tokens.output`      | counter   | account_key, model                     |
| `opencode.copilot.session.cost`               | histogram | model                                  |

### Configuration

```jsonc
// opencode.json
{
  "copilot": {
    "telemetry": {
      "enabled": true,
      "endpoint": "http://localhost:4318/v1/metrics",
      "headers": { "X-Honeycomb-Team": "xxx" },
      "bufferCap": 2048,
      "exportIntervalMs": 15000
    }
  }
}
```

Env-var overrides (precedence: env > config > defaults):

| Env var                                           | Effect                                             |
| ------------------------------------------------- | -------------------------------------------------- |
| `OPENCODE_COPILOT_TELEMETRY_ENABLED`              | `true`/`false` — force on or off                   |
| `OPENCODE_COPILOT_TELEMETRY_ENDPOINT`             | OTLP/HTTP collector URL                            |
| `OPENCODE_COPILOT_TELEMETRY_BUFFER`               | Ring-buffer capacity (default 2048)                |
| `OPENCODE_COPILOT_TELEMETRY_EXPORT_INTERVAL_MS`   | PeriodicExportingMetricReader interval             |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`             | Fallback endpoint (standard OTEL env)              |
| `OTEL_EXPORTER_OTLP_ENDPOINT`                     | Fallback endpoint (standard OTEL env)              |

When `enabled` is unset it auto-enables iff an endpoint resolves;
otherwise the in-memory ring buffer still collects records so the
`providers telemetry` CLI works without any collector.

### CLI inspection

```bash
# Live-follow the last 50 telemetry records:
opencode providers telemetry --tail 50

# Dump the current buffer as JSON:
opencode providers telemetry --json

# Last 10 minutes only:
opencode providers telemetry --since 10m --json
```

Example `--tail` output:

```
| GitHub Copilot telemetry
| exporter=disabled endpoint=none buffered=3
| 2026-04-19 18:32:10.112 request key=github-copilot#work model=gpt-5.4-xhigh pool=prod status=200 dur=834ms ok=true (2s ago)
| 2026-04-19 18:32:12.487 retry_429 key=github-copilot#edu-3 model=gpt-4.1 pool=edu (0ms ago)
| 2026-04-19 18:32:13.010 request key=github-copilot#edu-7 model=gpt-4.1 pool=edu status=200 dur=1123ms ok=true (0ms ago)
```

### Dashboard recipe (Grafana / OTEL Collector)

Minimal collector config to funnel opencode metrics into Prometheus:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  prometheus:
    endpoint: 0.0.0.0:8889
service:
  pipelines:
    metrics:
      receivers: [otlp]
      exporters: [prometheus]
```

Then:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318/v1/metrics \
  opencode run "your prompt here"
```

Suggested Grafana panels (PromQL):

- p95 Copilot request latency per pool:
  `histogram_quantile(0.95, sum(rate(opencode_copilot_api_request_duration_bucket[5m])) by (le, pool))`
- 429 density per account:
  `sum(rate(opencode_copilot_retries_429[5m])) by (account_key)`
- Token burn per model:
  `sum(rate(opencode_copilot_session_tokens_output[5m])) by (model)`

### Tests

`packages/opencode/test/plugin/github-copilot-telemetry.test.ts`
covers env/config merging, ring-buffer bounds + prune semantics, every
`record*` helper's metric shape with a `MockMeter`, no-op behavior
when the exporter is disabled, and the singleton swap path
(`installCopilotMeter`).

---
