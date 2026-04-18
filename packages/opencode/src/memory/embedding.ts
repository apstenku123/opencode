/**
 * @deprecated Use the shared `@/embedding` module instead.
 *
 * This file is now a thin shim that adapts the shared embedding service
 * (`src/embedding/`) to the historical `MemoryEmbeddingError` typed-error
 * surface used by S7 codemem. New consumers — including the S5 autoskill
 * evolution path — should depend on `@/embedding` directly.
 *
 * Why the shim still exists:
 *   - `MemoryStorage`/`MemoryRetrieval` consumers were typed against
 *     `EmbeddingService` with `MemoryEmbeddingError` in their failure
 *     channel. Switching the underlying tag would force every memory
 *     test/layer to be re-typed, which is out of scope for the round-2
 *     refactor.
 *   - The shim re-exports `mockLayer`, `openAICompatLayer`, and
 *     `hashEmbedding` so existing imports from
 *     `"…/memory/embedding"` continue to compile.
 *
 * The implementations themselves (HTTP adapter + TF-IDF fallback +
 * deterministic hash mock) live in `src/embedding/` and are the single
 * source of truth.
 */

import { Context, Effect, Layer } from "effect"
import { hashEmbedding as sharedHashEmbedding } from "../embedding"
import { makeImpl as makeOpenAIImpl, type OpenAICompatConfig as SharedOpenAICompatConfig } from "../embedding/openai"
import { MemoryEmbeddingError } from "./schema"

// --------------------------------------------------------------------------
// Service contract (memory-typed, preserved for S7 wiring compatibility)
// --------------------------------------------------------------------------

export namespace EmbeddingService {
  export interface Interface {
    readonly embed: (text: string) => Effect.Effect<Float32Array, MemoryEmbeddingError>
    readonly embedBatch: (texts: ReadonlyArray<string>) => Effect.Effect<Float32Array[], MemoryEmbeddingError>
  }
}

export class EmbeddingService extends Context.Service<EmbeddingService, EmbeddingService.Interface>()(
  "@opencode/memory/EmbeddingService",
) {}

// --------------------------------------------------------------------------
// OpenAI-compatible adapter
// --------------------------------------------------------------------------

export type OpenAICompatConfig = SharedOpenAICompatConfig

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
export const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1"

/**
 * Build a memory-typed `EmbeddingService` layer backed by the shared
 * OpenAI-compat HTTP impl. Errors are mapped from the shared
 * `EmbeddingError` to `MemoryEmbeddingError` so callers inside `memory/`
 * keep their existing failure channel.
 */
export function openAICompatLayer(config: OpenAICompatConfig): Layer.Layer<EmbeddingService> {
  const impl = makeOpenAIImpl(config)
  const adapted: EmbeddingService.Interface = {
    embed: (text) =>
      impl
        .embed(text)
        .pipe(Effect.mapError((e) => new MemoryEmbeddingError({ message: e.message, cause: e.cause }))),
    embedBatch: (texts) =>
      impl
        .embedBatch(texts)
        .pipe(Effect.mapError((e) => new MemoryEmbeddingError({ message: e.message, cause: e.cause }))),
  }
  return Layer.succeed(EmbeddingService, adapted)
}

// --------------------------------------------------------------------------
// Mock layer (tests / dev)
// --------------------------------------------------------------------------

/**
 * Memory-typed mock layer. Re-implemented locally rather than re-exported so
 * the failure type stays `MemoryEmbeddingError` (the shared mock is typed
 * against `EmbeddingError`).
 */
export function mockLayer(options?: {
  dimension?: number
  embed?: (text: string) => Float32Array
}): Layer.Layer<EmbeddingService> {
  const dim = options?.dimension ?? 32
  const embed = options?.embed ?? ((text: string) => sharedHashEmbedding(text, dim))
  const impl: EmbeddingService.Interface = {
    embed: (text) => Effect.sync(() => embed(text)),
    embedBatch: (texts) => Effect.sync(() => texts.map((t) => embed(t))),
  }
  return Layer.succeed(EmbeddingService, impl)
}

/** Re-export so existing `import { hashEmbedding } from "…/memory/embedding"` keeps working. */
export const hashEmbedding = sharedHashEmbedding
