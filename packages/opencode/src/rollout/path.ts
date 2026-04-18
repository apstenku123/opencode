/**
 * Rollout-path helpers. Mirrors Rust `codex-rs/core/src/rollout/path.rs`.
 *
 * A "rollout" is an append-only JSONL log of all user-visible events
 * that occurred during a session — sufficient to replay the session
 * state deterministically against a fresh store. One file per
 * session, rooted under XDG data (`~/.local/share/opencode/rollouts/`).
 */
import path from "path"
import { mkdir } from "fs/promises"
import { Global } from "@/global"
import type { SessionID } from "@/session/schema"

export namespace RolloutPath {
  /** Root directory for rollout files, rooted under XDG data. */
  export function root(): string {
    return path.join(Global.Path.data, "rollouts")
  }

  /** Ensure the rollout root directory exists. */
  export async function ensureRoot(): Promise<string> {
    const r = root()
    await mkdir(r, { recursive: true })
    return r
  }

  /** Absolute path of the rollout file for a given session id. */
  export function forSession(sessionID: SessionID): string {
    return path.join(root(), `${sessionID}.jsonl`)
  }

  /** Staging path for atomic-rename flushes. */
  export function stagingFor(sessionID: SessionID): string {
    return path.join(root(), `${sessionID}.jsonl.tmp`)
  }
}
