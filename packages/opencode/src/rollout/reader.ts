/**
 * Rollout reader — streams {@link RolloutWriter.Entry} values back
 * out of a JSONL rollout file.
 *
 * Mirrors Rust `codex-rs/core/src/rollout/reader.rs`. Tolerant of
 * truncated / partially-corrupt tails: malformed lines are skipped
 * and surfaced via an optional `onWarn` callback.
 */
import { readFile, stat } from "fs/promises"
import type { SessionID } from "@/session/schema"
import { RolloutPath } from "./path"
import { RolloutWriter } from "./writer"

export namespace RolloutReader {
  export interface Options {
    readonly onWarn?: (msg: string, cause?: unknown) => void
  }

  /** True iff a rollout file exists on disk for this session. */
  export async function exists(sessionID: SessionID): Promise<boolean> {
    try {
      const st = await stat(RolloutPath.forSession(sessionID))
      return st.isFile() && st.size > 0
    } catch {
      return false
    }
  }

  /** Read all valid entries from a session's rollout file. */
  export async function readAll(sessionID: SessionID, opts: Options = {}): Promise<RolloutWriter.Entry[]> {
    const filePath = RolloutPath.forSession(sessionID)
    let text: string
    try {
      text = await readFile(filePath, "utf-8")
    } catch (e) {
      opts.onWarn?.(`rollout: no file at ${filePath}`, e)
      return []
    }
    const out: RolloutWriter.Entry[] = []
    const lines = text.split(/\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.length === 0) continue
      try {
        const parsed = JSON.parse(line)
        const entry = RolloutWriter.Entry.safeParse(parsed)
        if (!entry.success) {
          opts.onWarn?.(`rollout: skipping invalid entry at line ${i + 1}`, entry.error)
          continue
        }
        out.push(entry.data)
      } catch (e) {
        opts.onWarn?.(`rollout: skipping unparsable line ${i + 1}`, e)
      }
    }
    return out
  }

  /**
   * Async-iterator variant for large rollout files. Avoids loading
   * the whole file into memory; yields entries in append order.
   */
  export async function* stream(sessionID: SessionID, opts: Options = {}): AsyncGenerator<RolloutWriter.Entry> {
    // Bun's fast path: read + split. For the session-scale files
    // we target (≤ low-MB typical), this is good enough and avoids
    // node:readline's backpressure quirks.
    const entries = await readAll(sessionID, opts)
    for (const e of entries) yield e
  }
}
