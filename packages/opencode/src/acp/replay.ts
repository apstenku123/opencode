import { RequestError } from "@agentclientprotocol/sdk"
import { Log } from "../util"
import { Rollout } from "../rollout"
import type { RolloutWriter } from "../rollout/writer"
import { SessionID } from "../session/schema"

/**
 * ACP session replay — deterministic re-emission of a recorded rollout
 * over `session/update` notifications.
 *
 * Rust reference: `codex-rs/acp-server/src/replay.rs`, which depends on
 * the rollout recorder in `codex-rs/core/src/rollout/`. Stream G landed
 * the TypeScript rollout module (see `packages/opencode/src/rollout/`)
 * so this module now replaces its not-implemented stub with a real
 * bridge.
 *
 * Public surface:
 *
 *   - {@link Replay.isAvailable}  — now `true` once the rollout module
 *     is wired; kept for capability negotiation over `initialize`.
 *   - {@link Replay.run}          — resolve a rollout file for the
 *     supplied session and stream each entry via the caller-provided
 *     emitter. Returns the number of replayed / skipped entries.
 *   - {@link Replay.handleOrReject} — ergonomic adapter used by the
 *     ACP agent; still throws a structured `RequestError` when the
 *     backing rollout is missing so ACP clients can distinguish
 *     "session has no rollout" from generic server errors.
 */
export namespace Replay {
  const log = Log.create({ service: "acp-replay" })

  export const META_KEY = "replay"
  /** JSON-RPC "method not found" (reused as 501-equivalent). */
  export const NOT_IMPLEMENTED_CODE = -32601
  /**
   * Retained for backwards compatibility with callers/tests that still
   * compare against the stub message. Emitted only when the session has
   * no rollout file on disk (fresh session, not-yet-recorded). The
   * string intentionally references Stream G so older ACP clients whose
   * capability UI looks for the marker keep working.
   */
  export const NOT_IMPLEMENTED_MESSAGE =
    "Session replay not implemented (requires rollout module \u2014 Stream G)"

  export interface Request {
    sessionId: string
    /** Optional starting event index; defaults to 0 (replay from first event). */
    fromIndex?: number
    /** Optional inclusive ending event index; defaults to last. */
    toIndex?: number
    /**
     * Optional wall-clock rate-limit (events/sec). 0 or undefined = fastest.
     * When >0, the replay paces emissions so consumers can render a
     * human-visible timeline instead of receiving the full log in one tick.
     */
    rate?: number
    /**
     * Emitter callback invoked for every replayed entry. Supplying no
     * emitter yields a dry-run that still returns replayed/skipped
     * counts — useful for smoke tests and capability probes.
     */
    emit?: (entry: RolloutWriter.Entry) => void | Promise<void>
  }

  export interface Response {
    sessionId: string
    replayedCount: number
    skippedCount: number
  }

  /**
   * Capability block for `initialize`. The ACP agent asks
   * {@link isAvailable} once at construction time; if Stream G is
   * present the advertised `supported` flag flips to `true`.
   */
  export function initializeMeta(available: boolean): Record<string, unknown> {
    return {
      [META_KEY]: {
        supported: available,
        reason: available ? undefined : "rollout module (Stream G) not yet shipped",
      },
    }
  }

  /**
   * Probe for the rollout backing module. The import at the top of
   * this file guarantees the symbol is bound at compile time; the
   * runtime check just confirms the expected shape so the capability
   * flag never returns `true` when the module has been tree-shaken.
   */
  export function isAvailable(): boolean {
    return (
      typeof Rollout === "object" &&
      Rollout !== null &&
      typeof Rollout.open === "function" &&
      typeof Rollout.replay === "function" &&
      typeof Rollout.Reader?.exists === "function"
    )
  }

  /**
   * Execute the replay: open the rollout reader for `request.sessionId`,
   * drive each entry through `request.emit` (when provided), and return a
   * summary. When the rollout file does not exist we still return the
   * zero-state response rather than throwing — callers that want the
   * "no rollout recorded" signal should use {@link handleOrReject}.
   */
  export async function run(request: Request): Promise<Response> {
    const sessionId = SessionID.make(request.sessionId)
    log.info("replay.run", {
      sessionId: request.sessionId,
      fromIndex: request.fromIndex,
      toIndex: request.toIndex,
      rate: request.rate,
    })

    const hasFile = await Rollout.exists(sessionId).catch(() => false)
    if (!hasFile) {
      log.warn("replay requested for session with no rollout", { sessionId: request.sessionId })
      return {
        sessionId: request.sessionId,
        replayedCount: 0,
        skippedCount: 0,
      }
    }

    const opts = {
      sinceSeq: request.fromIndex,
      untilSeq: request.toIndex,
    }

    const rateMs = request.rate && request.rate > 0 ? Math.max(1, Math.floor(1000 / request.rate)) : 0
    let replayedCount = 0
    let skippedCount = 0

    const state = await Rollout.Replay.replayToEmitter(
      sessionId,
      async (entry) => {
        try {
          if (request.emit) await request.emit(entry)
          replayedCount += 1
        } catch (err) {
          skippedCount += 1
          log.error("replay emitter threw", { seq: entry.seq, error: err })
        }
        if (rateMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, rateMs))
        }
      },
      opts,
    )

    log.info("replay.run done", {
      sessionId: request.sessionId,
      total: state.entries.length,
      replayedCount,
      skippedCount,
    })

    return {
      sessionId: request.sessionId,
      replayedCount,
      skippedCount,
    }
  }

  /**
   * Adapter preferred by the ACP agent: when the session has no
   * recorded rollout we throw a structured `RequestError` (mirroring
   * the historical stub path) so JSON-RPC clients receive a precise
   * "unavailable for this session" signal. Otherwise we delegate to
   * {@link run}.
   */
  export async function handleOrReject(request: Request): Promise<Response> {
    if (!isAvailable()) {
      log.warn("replay requested but rollout module unavailable", { sessionId: request.sessionId })
      throw new RequestError(NOT_IMPLEMENTED_CODE, NOT_IMPLEMENTED_MESSAGE, {
        notImplemented: true,
        dependency: "stream-g-rollout",
        sessionId: request.sessionId,
        hint: "Replay requires packages/opencode/src/rollout/ which is part of R6 Stream G.",
      })
    }

    const sessionId = SessionID.make(request.sessionId)
    const hasFile = await Rollout.exists(sessionId).catch(() => false)
    if (!hasFile) {
      throw new RequestError(NOT_IMPLEMENTED_CODE, NOT_IMPLEMENTED_MESSAGE, {
        notImplemented: true,
        dependency: "rollout-missing",
        sessionId: request.sessionId,
        hint: "No rollout file exists for this session. The session was likely created before the rollout writer was enabled.",
      })
    }

    return run(request)
  }
}
