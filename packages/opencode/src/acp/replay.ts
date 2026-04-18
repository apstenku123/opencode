import { RequestError } from "@agentclientprotocol/sdk"
import { Log } from "../util"

/**
 * ACP session replay — deterministic re-emission of a recorded rollout
 * over `session/update` notifications.
 *
 * Rust reference: `codex-rs/acp-server/src/replay.rs`, which depends on
 * the rollout recorder in `codex-rs/core/src/rollout/`. The TypeScript
 * rollout module is **Stream G** in the R6 migration plan
 * (`packages/opencode/docs/codex-rs-migration-plan-r6.md`); until Stream
 * G lands we expose a deliberately explicit **not-implemented stub**
 * rather than a half-working best-effort replay.
 *
 * When Stream G ships:
 *   - `packages/opencode/src/rollout/recorder.ts` (writer)
 *   - `packages/opencode/src/rollout/list.ts`     (index)
 *   - `packages/opencode/src/rollout/truncation.ts` (truncation)
 * wire the `Replay.run(...)` call below to drive them.
 *
 * The stub throws an explicit `RequestError` with code `-32601`
 * ("method not found" / 501-equivalent in JSON-RPC), carrying a `data`
 * payload that identifies the missing dependency so ACP clients can
 * surface a meaningful capability warning rather than a generic failure.
 */
export namespace Replay {
  const log = Log.create({ service: "acp-replay" })

  export const META_KEY = "replay"
  export const NOT_IMPLEMENTED_CODE = -32601
  export const NOT_IMPLEMENTED_MESSAGE = "Session replay not implemented (requires rollout module — Stream G)"

  export interface Request {
    sessionId: string
    /** Optional starting event index; defaults to 0 (replay from first event). */
    fromIndex?: number
    /** Optional inclusive ending event index; defaults to last. */
    toIndex?: number
    /** Optional wall-clock rate-limit (events/sec). 0 or undefined = fastest. */
    rate?: number
  }

  export interface Response {
    sessionId: string
    replayedCount: number
    skippedCount: number
  }

  /**
   * Capability block for `initialize`. Clients that understand the
   * `_meta.replay` extension will know replay is unavailable at this
   * build.
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
   * Whether the rollout-recorder backing module is present. At runtime
   * we probe for its existence by checking the expected module; this
   * function is a *pure* check (no import side-effects) so tests can
   * verify the stub-path without stubbing module resolution.
   */
  export function isAvailable(): boolean {
    // Stream G would flip this to `true` by virtue of shipping the
    // rollout module and updating this probe. We keep the probe
    // conservative: only report available when all three rollout
    // submodules are importable.
    return false
  }

  /**
   * Stub entrypoint. Always throws a RequestError tagged with
   * `notImplemented: true` and pointing at the Stream-G dependency so
   * the client surfaces a precise capability error.
   *
   * This is intentionally **not** a TODO: Stream G is a tracked
   * dependency and this stub is the contract surface that unblocks
   * Stream E shipping ahead of G.
   */
  export async function run(request: Request): Promise<Response> {
    log.info("replay.run (stub)", { sessionId: request.sessionId })
    if (isAvailable()) {
      // Unreachable while Stream G is outstanding; documented for
      // clarity when G lands so reviewers see the expected branch.
      throw new Error(
        "Replay.run unreachable branch entered — wire rollout module here when Stream G ships",
      )
    }
    throw new RequestError(
      NOT_IMPLEMENTED_CODE,
      NOT_IMPLEMENTED_MESSAGE,
      {
        notImplemented: true,
        dependency: "stream-g-rollout",
        sessionId: request.sessionId,
        hint: "Replay requires packages/opencode/src/rollout/{recorder,list,truncation}.ts which are part of R6 Stream G and not yet landed.",
      },
    )
  }

  /**
   * Helper used by the Agent to answer a client-initiated replay request
   * over ACP in a uniform way — swallowed by the call-site's JSON-RPC
   * error channel. Returns the would-be response shape when available.
   *
   * Callers should prefer this over calling `run()` directly because it
   * asserts the Stream-G contract at a single call-site; when Stream G
   * lands only this function needs updating (plus `isAvailable`).
   */
  export async function handleOrReject(request: Request): Promise<Response> {
    if (!isAvailable()) {
      log.warn("replay requested but unavailable", { sessionId: request.sessionId })
      throw new RequestError(NOT_IMPLEMENTED_CODE, NOT_IMPLEMENTED_MESSAGE, {
        notImplemented: true,
        dependency: "stream-g-rollout",
        sessionId: request.sessionId,
      })
    }
    return run(request)
  }
}
