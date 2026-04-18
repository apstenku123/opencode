import type { AgentSideConnection, PlanEntry } from "@agentclientprotocol/sdk"
import { Log } from "../util"

/**
 * ACP plan-mode exposure.
 *
 * The opencode agent has a first-class `plan` agent (see
 * `src/agent/agent.ts` — the plan agent has edit tools denied by default
 * and auto-approves `plan_enter`/`plan_exit` transitions). When this
 * agent is active, ACP clients should see:
 *
 *   1. `current_mode_update` session updates reflecting the active mode id
 *   2. `plan` session updates with the current PlanEntry[] snapshot
 *   3. `_meta.planMode.<...>` on outgoing updates so clients who
 *      understand the extension can render plan-specific affordances
 *      (read-only badges, plan diff view, etc.)
 *
 * This module is pure protocol shape: it takes the already-resolved
 * agent-name/todo-snapshot and emits the right `sessionUpdate` payload.
 * Side-effect-free; all IO is through the passed-in connection.
 *
 * Parity ref: Rust `codex-rs/acp-server/src/session.rs::plan_mode_*`.
 */
export namespace PlanMode {
  const log = Log.create({ service: "acp-plan-mode" })

  export const PLAN_MODE_ID = "plan"
  export const META_KEY = "planMode"

  export interface Transition {
    sessionId: string
    from?: string
    to: string
    /**
     * True when transition is auto-triggered by the agent itself (e.g. via
     * the `plan_enter` native tool), false when driven by a client
     * `setSessionMode` call.
     */
    automatic: boolean
  }

  export interface Snapshot {
    sessionId: string
    entries: PlanEntry[]
    /** Human-readable plan title, if any. */
    title?: string
    /** Whether the plan mode is currently active. */
    active: boolean
  }

  export function isPlanMode(modeId: string | undefined | null): boolean {
    return modeId === PLAN_MODE_ID
  }

  /**
   * Build the `_meta.planMode` extension object for session updates. ACP
   * clients that understand it can render plan-specific UI; clients that
   * don't just ignore the block.
   */
  export function buildMeta(opts: {
    active: boolean
    title?: string
    entriesCount?: number
    reason?: "enter" | "exit" | "update"
  }): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      active: opts.active,
    }
    if (opts.title !== undefined) meta["title"] = opts.title
    if (opts.entriesCount !== undefined) meta["entriesCount"] = opts.entriesCount
    if (opts.reason !== undefined) meta["reason"] = opts.reason
    return { [META_KEY]: meta }
  }

  /**
   * Emit a `current_mode_update` when the agent-side mode changes.
   * Clients that previously set `modes.currentModeId` update their UI.
   */
  export async function announceTransition(
    connection: Pick<AgentSideConnection, "sessionUpdate">,
    transition: Transition,
  ): Promise<void> {
    log.info("plan_mode.transition", transition)
    const reason: "enter" | "exit" = isPlanMode(transition.to) ? "enter" : "exit"
    await connection
      .sessionUpdate({
        sessionId: transition.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: transition.to,
        },
        _meta: buildMeta({
          active: isPlanMode(transition.to),
          reason,
        }),
      })
      .catch((error) => {
        log.error("failed to announce plan-mode transition", { error, transition })
      })
  }

  /**
   * Emit the current plan entries snapshot when plan mode is active.
   * Mirrors how `todowrite` results are surfaced today in
   * `agent.ts::processMessage`, but emits the `planMode` `_meta` block so
   * clients can distinguish "todo from any agent" vs "active plan-mode
   * plan".
   */
  export async function publishSnapshot(
    connection: Pick<AgentSideConnection, "sessionUpdate">,
    snapshot: Snapshot,
  ): Promise<void> {
    log.debug("plan_mode.snapshot", { sessionId: snapshot.sessionId, entries: snapshot.entries.length })
    await connection
      .sessionUpdate({
        sessionId: snapshot.sessionId,
        update: {
          sessionUpdate: "plan",
          entries: snapshot.entries,
        },
        _meta: buildMeta({
          active: snapshot.active,
          title: snapshot.title,
          entriesCount: snapshot.entries.length,
          reason: "update",
        }),
      })
      .catch((error) => {
        log.error("failed to publish plan snapshot", { error })
      })
  }

  /**
   * Compute the capability block to advertise from `initialize`. Clients
   * that want plan-mode visibility inspect `_meta.planMode.supported`
   * before calling `setSessionMode("plan")`.
   */
  export function initializeMeta(): Record<string, unknown> {
    return {
      [META_KEY]: {
        supported: true,
        modeId: PLAN_MODE_ID,
      },
    }
  }

  /**
   * Tracks per-session plan-mode state so the Agent can decide whether
   * to emit a transition notification. Returns `true` iff the state
   * changed (caller should emit updates).
   */
  export class Tracker {
    private current = new Map<string, string>()

    observe(sessionId: string, modeId: string): { changed: boolean; previous?: string } {
      const prev = this.current.get(sessionId)
      if (prev === modeId) return { changed: false, previous: prev }
      this.current.set(sessionId, modeId)
      return { changed: true, previous: prev }
    }

    get(sessionId: string): string | undefined {
      return this.current.get(sessionId)
    }

    clear(sessionId: string): void {
      this.current.delete(sessionId)
    }
  }
}
