/**
 * Rollout subsystem — persistent JSONL session event log + replay.
 *
 * This is the TS port of Rust `codex-rs/core/src/rollout/` (~4.1 kLOC).
 * The goal of this module (R6 Stream G) is to provide a durable,
 * append-only record of every user-visible event in a session so
 * that ACP replay and deterministic fork (R6 Stream E / Stream H)
 * can be built on top without re-deriving state from the sqlite
 * session store.
 *
 * Public surface:
 *
 *  - {@link Rollout.open}   — open or resume a writer for a session.
 *  - {@link Rollout.read}   — read all entries for a session id.
 *  - {@link Rollout.stream} — async-iterate entries.
 *  - {@link Rollout.replay} — pure in-memory replay.
 *  - {@link Rollout.path}   — path helpers for server routes.
 */
import { RolloutPath } from "./path"
import { RolloutWriter } from "./writer"
import { RolloutReader } from "./reader"
import { RolloutReplay } from "./replay"

export namespace Rollout {
  export const Path = RolloutPath
  export const Writer = RolloutWriter
  export const Reader = RolloutReader
  export const Replay = RolloutReplay

  // Re-export core types / helpers for convenience.
  export const open = RolloutWriter.open
  export const read = RolloutReader.readAll
  export const stream = RolloutReader.stream
  export const exists = RolloutReader.exists
  export const replay = RolloutReplay.replayToMemory
  export const path = RolloutPath.forSession
}

export { RolloutPath, RolloutWriter, RolloutReader, RolloutReplay }
