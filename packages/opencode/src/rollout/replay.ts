/**
 * Rollout replay — reconstruct an in-memory session state from a
 * JSONL rollout log. Mirrors Rust `codex-rs/core/src/rollout/replay.rs`.
 *
 * Two modes are supported:
 *
 *   1. {@link replayToMemory} — deterministic pure replay: returns an
 *      aggregated {@link ReplayState}. No side effects. This is what
 *      Stream E's ACP `replay.ts` will consume.
 *
 *   2. {@link replayToBus} — publish each rollout entry on the
 *      in-process Bus as a synthetic event so observers / the UI
 *      can re-hydrate. Useful for the `POST /session/:id/replay`
 *      endpoint.
 */
import type { SessionID } from "@/session/schema"
import { RolloutReader } from "./reader"
import { RolloutWriter } from "./writer"

export namespace RolloutReplay {
  export interface ReplayState {
    readonly sessionID: SessionID
    readonly entries: ReadonlyArray<RolloutWriter.Entry>
    readonly kinds: Readonly<Record<string, number>>
    readonly firstTime?: number
    readonly lastTime?: number
    readonly lastSeq?: number
  }

  export interface Options {
    readonly onWarn?: (msg: string, cause?: unknown) => void
    /** If provided, only entries whose seq >= this value are included. */
    readonly sinceSeq?: number
    /** If provided, only entries whose seq <= this value are included. */
    readonly untilSeq?: number
  }

  /** Deterministic pure replay — no Bus emissions, no DB writes. */
  export async function replayToMemory(sessionID: SessionID, opts: Options = {}): Promise<ReplayState> {
    const all = await RolloutReader.readAll(sessionID, { onWarn: opts.onWarn })
    const filtered = all.filter((e) => {
      if (opts.sinceSeq !== undefined && e.seq < opts.sinceSeq) return false
      if (opts.untilSeq !== undefined && e.seq > opts.untilSeq) return false
      return true
    })
    const kinds: Record<string, number> = {}
    for (const e of filtered) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
    return {
      sessionID,
      entries: filtered,
      kinds,
      firstTime: filtered[0]?.time,
      lastTime: filtered.at(-1)?.time,
      lastSeq: filtered.at(-1)?.seq,
    }
  }

  /**
   * Publish each entry as a synthetic event on a caller-supplied
   * emitter. We avoid binding directly to `Bus` here so the function
   * remains side-effect-free / unit-testable without an Instance
   * scope. The server route wraps this with a bound Bus publisher.
   */
  export async function replayToEmitter(
    sessionID: SessionID,
    emit: (entry: RolloutWriter.Entry) => void | Promise<void>,
    opts: Options = {},
  ): Promise<ReplayState> {
    const state = await replayToMemory(sessionID, opts)
    for (const entry of state.entries) {
      await emit(entry)
    }
    return state
  }
}
