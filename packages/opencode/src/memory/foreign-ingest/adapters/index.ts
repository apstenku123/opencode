/**
 * Foreign-ingest adapter barrel + shared types.
 *
 * Each adapter parses one external tool's session storage layout into the
 * common [`IngestedSession`] shape so the pipeline can drive a single
 * memcoder-style extraction path regardless of which vibe-coding tool
 * produced the data. Round-2 adapters land in pairs:
 *
 *  - `discover<Tool>`: cheap filesystem/SQLite walk that returns
 *    [`DiscoveredSession`] metadata (path, tool, content_hash, cwd) WITHOUT
 *    fully parsing every turn — used to populate the work queue and feed the
 *    checkpoint dedup.
 *  - `parse<Tool>Session`: full per-session parse that produces
 *    [`IngestedSession`] with one [`IngestedTurn`] per user/assistant
 *    exchange.
 *
 * Mirrors `codex-rs/core/src/memories/foreign_ingest/adapters/`.
 */

import { createHash } from "node:crypto"
import { statSync } from "node:fs"

// --------------------------------------------------------------------------
// Foreign tool discriminator
// --------------------------------------------------------------------------

/**
 * Stable string identifiers used as the `tool` column in `foreign_ingest_done`
 * and as the `tool` field of [`ForeignSource`] sextuples. Matches the Rust
 * `ForeignTool` enum variants in `codex-rs/core/src/config/types.rs`.
 */
export type ForeignTool = "claude_code" | "claude_ext" | "cursor" | "codex" | "opencode" | "kiro"

// --------------------------------------------------------------------------
// Common ingest types
// --------------------------------------------------------------------------

/**
 * One turn in a normalized foreign session.
 */
export interface IngestedTurn {
  readonly userText: string
  readonly assistantText: string
  /** Tool calls made by the assistant in this turn. `args` is a truncated
   * JSON-stringified summary (≤200 chars) — full args are NOT preserved. */
  readonly toolCalls: ReadonlyArray<{ name: string; args: string }>
  readonly hasReasoning: boolean
  readonly reasoningText?: string
}

/**
 * Normalized session, the input the pipeline feeds to extraction.
 */
export interface IngestedSession {
  readonly tool: ForeignTool
  readonly sourceID: string
  readonly sourcePath: string
  readonly cwd?: string
  readonly turns: ReadonlyArray<IngestedTurn>
  readonly firstTs?: number
  readonly lastTs?: number
}

/**
 * Cheap metadata produced by `discover*` before any per-turn parse. Carries
 * the `contentHash` used for checkpoint dedup.
 */
export interface DiscoveredSession {
  readonly tool: ForeignTool
  readonly sourceID: string
  readonly sourcePath: string
  readonly cwd?: string
  /** File mtime / DB updated_at as unix milliseconds. */
  readonly updatedAt: number
  readonly contentHash: string
}

// --------------------------------------------------------------------------
// Helpers shared by adapters
// --------------------------------------------------------------------------

/**
 * Concatenate session turns into a single transcript suitable for an
 * extraction prompt. Mirrors `IngestedSession::full_text` in Rust.
 */
export function fullText(session: IngestedSession): string {
  let buf = ""
  session.turns.forEach((turn, i) => {
    buf += `--- Turn ${i + 1} ---\n`
    buf += `User: ${turn.userText}\n`
    if (turn.reasoningText) buf += `Thinking: ${turn.reasoningText}\n`
    buf += `Assistant: ${turn.assistantText}\n`
    for (const call of turn.toolCalls) {
      buf += `  Tool: ${call.name}(${call.args})\n`
    }
    buf += "\n"
  })
  return buf
}

/**
 * Last user message in a session — drives sentiment / momentum signals in
 * the refining scorer.
 */
export function lastUserMessage(session: IngestedSession): string | undefined {
  const last = session.turns[session.turns.length - 1]
  return last?.userText
}

/**
 * Compute a content hash that survives non-functional file reformatting but
 * changes when turns are added or modified. Uses (size, mtime, first 4KiB,
 * last 4KiB) — same fingerprint Rust adapters use so checkpoint rows are
 * comparable across the migration. Pure helper; callers decide the path.
 */
export function computeContentHash(filePath: string, content: Uint8Array | string): string {
  const bytes = typeof content === "string" ? Buffer.from(content) : content
  const stat = statSync(filePath, { throwIfNoEntry: false })
  const size = stat?.size ?? bytes.byteLength
  const mtimeSec = stat?.mtimeMs ? Math.floor(stat.mtimeMs / 1000) : 0

  const hasher = createHash("sha256")
  const sizeBuf = Buffer.alloc(8)
  sizeBuf.writeBigUInt64LE(BigInt(size))
  hasher.update(sizeBuf)
  const mtimeBuf = Buffer.alloc(8)
  mtimeBuf.writeBigUInt64LE(BigInt(mtimeSec))
  hasher.update(mtimeBuf)
  const head = bytes.subarray(0, Math.min(bytes.byteLength, 4096))
  hasher.update(head)
  if (bytes.byteLength > 4096) {
    const tail = bytes.subarray(Math.max(0, bytes.byteLength - 4096))
    hasher.update(tail)
  }
  return hasher.digest("hex")
}

// --------------------------------------------------------------------------
// Re-exports
// --------------------------------------------------------------------------

export * as Claude from "./claude"
export * as Cursor from "./cursor"
export * as Codex from "./codex"
export * as OpenCodeAdapter from "./opencode"
export * as Kiro from "./kiro"
