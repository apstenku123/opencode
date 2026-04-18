/**
 * SubagentRegistry — tracks active async child sessions spawned by the `task`
 * tool in its `async: true` variant.
 *
 * This is the TS analog of codex_git's `AgentControl` / `auto_wait_for_active_children`
 * pipeline (`codex-rs/core/src/codex_fork.rs:416`).
 *
 * # Round 2 additions
 *
 * - {@link spawn} now accepts an optional cancel callback. When the parent's
 *   fiber is interrupted, the registry's {@link cancelAll} method invokes
 *   every registered cancel — the structural analog of Rust's
 *   `child_token()` cascade in `codex_delegate.rs::run_codex_thread_interactive`.
 * - {@link depth} returns the parent→ancestor chain depth for a given session
 *   id, walking the parent chain registered via {@link spawn}. The `task`
 *   tool's `async: true` path consults this against `experimental.subagent.depthLimit`
 *   before allowing the spawn (mirrors `agent::exceeds_thread_spawn_depth_limit`).
 * - {@link summarize} produces the canonical "[Sub-agent results] …" string
 *   that the parent loop's `preBreak` observer injects as a synthetic user
 *   turn (mirrors `codex_fork::auto_wait_for_active_children` summary).
 *
 * # API shape
 *
 * - {@link spawn}: register a child under a parent session id with a
 *   `Deferred` that the child will complete when it finishes.
 * - {@link waitForAll}: suspend until every currently-active child under a
 *   parent has completed (or a deadline elapses). Returns summaries in the
 *   order the children completed.
 * - {@link active}: synchronous snapshot of the current child-id set.
 * - {@link close}: mark a child finished with a summary. Triggers any pending
 *   `waitForAll` awaits to resolve.
 * - {@link cancelAll}: invoke the cancel callbacks of every registered child
 *   under a parent session, then mark them as `cancelled`.
 * - {@link depth}: number of ancestors registered under {@link spawn} for a
 *   given session id (0 if no registration is found).
 *
 * # Notes
 *
 * - The registry is in-memory and per-`InstanceState` scope. It clears when
 *   the instance's scope closes.
 * - Each child is owned by exactly one parent. Re-spawning under a new parent
 *   id replaces the prior registration (consistent with codex `SubAgentSource::ThreadSpawn`).
 * - `close` is idempotent — calling close on an unknown child is a no-op,
 *   matching codex's tolerance for duplicate deletion events.
 */

import { SessionID } from "@/session/schema"
import { InstanceState } from "@/effect"
import { Effect, Layer, Context, Deferred } from "effect"

export namespace SubagentRegistry {
  export interface ChildSummary {
    readonly sessionID: SessionID
    readonly parentID: SessionID
    readonly status: "completed" | "cancelled" | "error"
    readonly startedAt: number
    readonly finishedAt: number
    readonly result?: string
    readonly error?: string
  }

  interface ActiveChild {
    readonly parentID: SessionID
    readonly startedAt: number
    readonly done: Deferred.Deferred<ChildSummary>
    /**
     * Optional cancel callback. Invoked by {@link cancelAll}. Should be
     * idempotent — `cancelAll` will both call it and `close()` the child as
     * `cancelled`, so a second `cancel()` from cleanup paths must be a no-op.
     */
    cancel?: () => void
  }

  export interface SpawnOptions {
    /** Cancel callback invoked when the parent's fiber is interrupted. */
    readonly cancel?: () => void
  }

  /**
   * Row returned by {@link Interface.listChildren}. Combines active child state
   * with finished-child summaries so the `task_list` tool can present a single
   * view of every child owned by a parent.
   */
  export interface ChildRow {
    readonly sessionID: SessionID
    readonly parentID: SessionID
    readonly startedAt: number
    /** `"running"` for active, matches {@link ChildSummary.status} otherwise. */
    readonly status: "running" | ChildSummary["status"]
    readonly finishedAt?: number
    readonly result?: string
    readonly error?: string
  }

  export interface Interface {
    readonly spawn: (
      parentID: SessionID,
      childID: SessionID,
      options?: SpawnOptions,
    ) => Effect.Effect<void>
    readonly waitForAll: (
      parentID: SessionID,
      options?: { timeoutMs?: number },
    ) => Effect.Effect<ReadonlyArray<ChildSummary>>
    /**
     * Wait for the specific set of child IDs (must all be under `parentID`)
     * and return their summaries in completion order. Unknown or foreign-parent
     * IDs are rejected synchronously. Already-finished IDs resolve with their
     * recorded summary. Timeout returns whatever summaries have landed so far.
     * Mirrors Rust `wait.rs::Handler::handle` (multi_agents/wait.rs).
     */
    readonly waitForIds: (
      parentID: SessionID,
      ids: ReadonlyArray<SessionID>,
      options?: { timeoutMs?: number },
    ) => Effect.Effect<ReadonlyArray<ChildSummary>, Error>
    readonly active: (parentID: SessionID) => Effect.Effect<ReadonlySet<SessionID>>
    readonly close: (
      childID: SessionID,
      summary: Omit<ChildSummary, "sessionID" | "parentID" | "startedAt" | "finishedAt"> & {
        finishedAt?: number
      },
    ) => Effect.Effect<void>
    /** Cancel every child under a parent session and mark them as cancelled. */
    readonly cancelAll: (parentID: SessionID) => Effect.Effect<number>
    /**
     * Cancel a single child under a parent. Returns `true` when the child was
     * active and got cancelled, `false` for unknown or foreign-parent ids.
     * Port of `close_agent.rs::Handler::handle`.
     */
    readonly cancelChild: (parentID: SessionID, childID: SessionID) => Effect.Effect<boolean>
    /** Child-id → summary lookup for children that have already finished. */
    readonly summary: (childID: SessionID) => Effect.Effect<ChildSummary | undefined>
    /**
     * List every child registered under `parentID` — both running and
     * completed — as a single snapshot. Port of
     * `list_agents.rs::Handler::handle`. Used by the `task_list` tool.
     */
    readonly listChildren: (parentID: SessionID) => Effect.Effect<ReadonlyArray<ChildRow>>
    /**
     * Depth of the chain of registered ancestors for a given session id.
     * Returns 0 when the session id isn't registered as a child anywhere.
     * Self-cycles guarded.
     */
    readonly depth: (sessionID: SessionID) => Effect.Effect<number>
    /**
     * Direct parent of a registered child session, if any. Returns
     * `undefined` for top-level sessions or unknown ids. Survives child
     * close so guardian routing can still identify the parent after
     * completion. Used by {@link Guardian} to route approval requests.
     */
    readonly parentOf: (sessionID: SessionID) => Effect.Effect<SessionID | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentRegistry") {}

  /**
   * Format the canonical `[Sub-agent results] …` summary string that the
   * parent loop injects as a synthetic user turn after auto-wait.
   * Mirrors `codex_fork::auto_wait_for_active_children` body shape.
   */
  export function summarize(children: ReadonlyArray<ChildSummary>): string {
    if (children.length === 0) return ""
    const lines = children.map((child) => {
      const tag =
        child.status === "completed" ? "ok" : child.status === "cancelled" ? "cancelled" : "error"
      const body =
        child.status === "error"
          ? child.error?.slice(0, 240) ?? "<unknown error>"
          : child.result?.slice(0, 240) ?? "<no output>"
      return `- ${child.sessionID} [${tag}]: ${body}`
    })
    return [
      `[Sub-agent results] All ${children.length} sub-agent(s) have finished:`,
      ...lines,
    ].join("\n")
  }

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const data = yield* InstanceState.make(
        Effect.fn("SubagentRegistry.state")(function* () {
          const children = new Map<SessionID, ActiveChild>()
          const summaries = new Map<SessionID, ChildSummary>()
          // Persistent parent-of map (survives child close) so depth() can
          // walk the lineage even after a child has finished. Used by the
          // `task` tool depth-limit check on async spawns.
          const parentOf = new Map<SessionID, SessionID>()
          return { children, summaries, parentOf }
        }),
      )

      const getState = InstanceState.get(data)

      const spawn: Interface["spawn"] = (parentID, childID, options) =>
        Effect.gen(function* () {
          const state = yield* getState
          const done = yield* Deferred.make<ChildSummary>()
          state.children.set(childID, {
            parentID,
            startedAt: Date.now(),
            done,
            cancel: options?.cancel,
          })
          state.parentOf.set(childID, parentID)
        })

      const active: Interface["active"] = (parentID) =>
        Effect.map(
          getState,
          (state) =>
            new Set(
              Array.from(state.children.entries())
                .filter(([, c]) => c.parentID === parentID)
                .map(([childID]) => childID),
            ) as ReadonlySet<SessionID>,
        )

      const close: Interface["close"] = (childID, payload) =>
        Effect.gen(function* () {
          const state = yield* getState
          const entry = state.children.get(childID)
          if (!entry) return
          const summary: ChildSummary = {
            sessionID: childID,
            parentID: entry.parentID,
            startedAt: entry.startedAt,
            status: payload.status,
            finishedAt: payload.finishedAt ?? Date.now(),
            result: payload.result,
            error: payload.error,
          }
          state.summaries.set(childID, summary)
          state.children.delete(childID)
          yield* Deferred.succeed(entry.done, summary)
        })

      const cancelAll: Interface["cancelAll"] = (parentID) =>
        Effect.gen(function* () {
          const state = yield* getState
          const entries = Array.from(state.children.entries()).filter(
            ([, c]) => c.parentID === parentID,
          )
          for (const [childID, entry] of entries) {
            try {
              entry.cancel?.()
            } catch {
              // swallow — best-effort cancellation
            }
            // Move to summaries as cancelled and resolve the deferred so any
            // pending waitForAll() unblocks.
            const summary: ChildSummary = {
              sessionID: childID,
              parentID: entry.parentID,
              startedAt: entry.startedAt,
              finishedAt: Date.now(),
              status: "cancelled",
            }
            state.summaries.set(childID, summary)
            state.children.delete(childID)
            yield* Deferred.succeed(entry.done, summary)
          }
          return entries.length
        })

      const waitForAll: Interface["waitForAll"] = (parentID, options) =>
        Effect.gen(function* () {
          const state = yield* getState
          const entries = Array.from(state.children.entries()).filter(([, c]) => c.parentID === parentID)
          if (entries.length === 0) return [] as ReadonlyArray<ChildSummary>
          const awaits = entries.map(([, c]) => Deferred.await(c.done))
          const all = Effect.all(awaits, { concurrency: "unbounded" })
          const timeoutMs = options?.timeoutMs
          if (timeoutMs === undefined) return yield* all
          return yield* all.pipe(
            Effect.timeout(timeoutMs),
            Effect.catchTag("TimeoutError", () =>
              Effect.sync(() => {
                // On timeout, return whatever summaries have already landed.
                return entries
                  .map(([id]) => state.summaries.get(id))
                  .filter((s): s is ChildSummary => s !== undefined) as ReadonlyArray<ChildSummary>
              }),
            ),
          )
        })

      const summary: Interface["summary"] = (childID) =>
        Effect.map(getState, (state) => state.summaries.get(childID))

      const waitForIds: Interface["waitForIds"] = (parentID, ids, options) =>
        Effect.gen(function* () {
          const state = yield* getState
          // Validate every id belongs to this parent (either still active or
          // recorded in summaries). Reject the whole call on foreign/unknown
          // to mirror Rust's `agent_id` validation step.
          for (const id of ids) {
            const active = state.children.get(id)
            const finished = state.summaries.get(id)
            if (!active && !finished) {
              return yield* Effect.fail(new Error(`Unknown child session: ${id}`))
            }
            const owner = active?.parentID ?? finished?.parentID
            if (owner !== parentID) {
              return yield* Effect.fail(
                new Error(`Child ${id} is owned by ${owner}, not ${parentID}`),
              )
            }
          }
          if (ids.length === 0) return [] as ReadonlyArray<ChildSummary>
          const pending: Array<Effect.Effect<ChildSummary>> = []
          const alreadyDone: ChildSummary[] = []
          for (const id of ids) {
            const active = state.children.get(id)
            const finished = state.summaries.get(id)
            if (active) pending.push(Deferred.await(active.done))
            else if (finished) alreadyDone.push(finished)
          }
          if (pending.length === 0) return alreadyDone as ReadonlyArray<ChildSummary>
          const all = Effect.all(pending, { concurrency: "unbounded" })
          const timeoutMs = options?.timeoutMs
          if (timeoutMs === undefined) {
            const waited = yield* all
            return [...alreadyDone, ...waited] as ReadonlyArray<ChildSummary>
          }
          const waited = yield* all.pipe(
            Effect.timeout(timeoutMs),
            Effect.catchTag("TimeoutError", () =>
              Effect.sync(() => {
                return ids
                  .map((id) => state.summaries.get(id))
                  .filter((s): s is ChildSummary => s !== undefined) as ReadonlyArray<ChildSummary>
              }),
            ),
          )
          // When a timeout occurs the fallback already returns every
          // currently-known summary (including ids we already had), so dedupe.
          const seen = new Set<SessionID>()
          const merged: ChildSummary[] = []
          for (const s of [...alreadyDone, ...waited]) {
            if (seen.has(s.sessionID)) continue
            seen.add(s.sessionID)
            merged.push(s)
          }
          return merged as ReadonlyArray<ChildSummary>
        })

      const cancelChild: Interface["cancelChild"] = (parentID, childID) =>
        Effect.gen(function* () {
          const state = yield* getState
          const entry = state.children.get(childID)
          if (!entry || entry.parentID !== parentID) return false
          try {
            entry.cancel?.()
          } catch {
            // swallow — best-effort
          }
          const summary: ChildSummary = {
            sessionID: childID,
            parentID: entry.parentID,
            startedAt: entry.startedAt,
            finishedAt: Date.now(),
            status: "cancelled",
          }
          state.summaries.set(childID, summary)
          state.children.delete(childID)
          yield* Deferred.succeed(entry.done, summary)
          return true
        })

      const listChildren: Interface["listChildren"] = (parentID) =>
        Effect.map(getState, (state) => {
          const rows: ChildRow[] = []
          for (const [childID, entry] of state.children.entries()) {
            if (entry.parentID !== parentID) continue
            rows.push({
              sessionID: childID,
              parentID: entry.parentID,
              startedAt: entry.startedAt,
              status: "running",
            })
          }
          for (const [childID, s] of state.summaries.entries()) {
            if (s.parentID !== parentID) continue
            rows.push({
              sessionID: childID,
              parentID: s.parentID,
              startedAt: s.startedAt,
              status: s.status,
              finishedAt: s.finishedAt,
              result: s.result,
              error: s.error,
            })
          }
          // Stable sort: oldest started first (ascending).
          rows.sort((a, b) => a.startedAt - b.startedAt)
          return rows as ReadonlyArray<ChildRow>
        })

      const depth: Interface["depth"] = (sessionID) =>
        Effect.map(getState, (state) => {
          let current: SessionID | undefined = state.parentOf.get(sessionID)
          let n = 0
          const seen = new Set<SessionID>([sessionID])
          while (current && !seen.has(current)) {
            seen.add(current)
            n += 1
            current = state.parentOf.get(current)
            if (n > 1024) break // hard guard against cycles in pathological data
          }
          return n
        })

      const parentOf: Interface["parentOf"] = (sessionID) =>
        Effect.map(getState, (state) => state.parentOf.get(sessionID))

      return Service.of({
        spawn,
        waitForAll,
        waitForIds,
        active,
        close,
        cancelAll,
        cancelChild,
        summary,
        listChildren,
        depth,
        parentOf,
      })
    }),
  )

  export const defaultLayer = layer
}
