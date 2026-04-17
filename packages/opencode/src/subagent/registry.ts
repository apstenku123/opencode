/**
 * SubagentRegistry — tracks active async child sessions spawned by the `task`
 * tool in its `async: true` variant.
 *
 * This is the TS analog of codex_git's `AgentControl` / `auto_wait_for_active_children`
 * pipeline (`codex-rs/core/src/codex_fork.rs:416`). In round 1 we ship the
 * lifecycle API only; the parent `SessionPrompt.runLoop` does not yet consult
 * the registry at pre-break time. Round 2 (Task-based `preBreak` observer)
 * wires the auto-wait injection.
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
  }

  export interface Interface {
    readonly spawn: (parentID: SessionID, childID: SessionID) => Effect.Effect<void>
    readonly waitForAll: (
      parentID: SessionID,
      options?: { timeoutMs?: number },
    ) => Effect.Effect<ReadonlyArray<ChildSummary>>
    readonly active: (parentID: SessionID) => Effect.Effect<ReadonlySet<SessionID>>
    readonly close: (
      childID: SessionID,
      summary: Omit<ChildSummary, "sessionID" | "parentID" | "startedAt" | "finishedAt"> & {
        finishedAt?: number
      },
    ) => Effect.Effect<void>
    /** Child-id → summary lookup for children that have already finished. */
    readonly summary: (childID: SessionID) => Effect.Effect<ChildSummary | undefined>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SubagentRegistry") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const data = yield* InstanceState.make(
        Effect.fn("SubagentRegistry.state")(function* () {
          const children = new Map<SessionID, ActiveChild>()
          const summaries = new Map<SessionID, ChildSummary>()
          return { children, summaries }
        }),
      )

      const getState = InstanceState.get(data)

      const spawn: Interface["spawn"] = (parentID, childID) =>
        Effect.gen(function* () {
          const state = yield* getState
          const done = yield* Deferred.make<ChildSummary>()
          state.children.set(childID, {
            parentID,
            startedAt: Date.now(),
            done,
          })
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

      return Service.of({
        spawn,
        waitForAll,
        active,
        close,
        summary,
      })
    }),
  )

  export const defaultLayer = layer
}
