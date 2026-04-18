/**
 * Shared, provider-neutral text-embedding service.
 *
 * Both the `memory/` (S7 codemem) and `skill/` (S5 evolution / autoskill)
 * subsystems need to convert text into a dense vector. This module is the
 * single source of truth for that capability so the two callers do not
 * diverge. It mirrors the `core/src/skills/embedding.rs` surface from
 * codex-rs (`EmbeddingClient` with `Api` / `LocalTfIdf` providers) while
 * staying TS-idiomatic — exposing an Effect `Context.Service` instead of a
 * concrete struct so each consumer can choose its own provider layer at the
 * application root.
 *
 * What lives here:
 *   - {@link EmbeddingError} — typed error for all embedding ops.
 *   - {@link EmbeddingService} — the service contract (`embed` + `embedBatch`).
 *   - {@link cosineSimilarity} — math helper shared by every consumer.
 *   - {@link mockLayer} / {@link hashEmbedding} — deterministic in-memory
 *     fake for tests, identical to the round-1 memory-local impl.
 *
 * What is provided by sibling modules:
 *   - {@link "./openai"} — OpenAI-compat HTTP `/v1/embeddings` provider.
 *   - {@link "./tfidf"} — local TF-IDF fallback that requires no network.
 *
 * Both providers are also re-exported from this index for convenience.
 *
 * Backward compatibility: the historical service tag
 * `@opencode/memory/EmbeddingService` (used by `src/memory/embedding.ts`) is
 * preserved by the memory shim so existing `Memory.layer` wiring continues
 * to type-check unchanged. New consumers should depend on
 * {@link EmbeddingService} from this module.
 */

import { Context, Effect, Layer } from "effect"
import { Schema } from "effect"
import { createHash } from "node:crypto"

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------

/**
 * Tagged embedding error. Mirrors the Rust `EmbeddingError::Api` variant —
 * `Database` and `DimensionMismatch` are out of scope for this layer because
 * the service is purely "text in, vector out".
 */
export class EmbeddingError extends Schema.TaggedErrorClass<EmbeddingError>()("EmbeddingError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// --------------------------------------------------------------------------
// Service contract
// --------------------------------------------------------------------------

export namespace EmbeddingService {
  export interface Interface {
    /** Embed a single string. */
    readonly embed: (text: string) => Effect.Effect<Float32Array, EmbeddingError>
    /**
     * Embed a batch. Default impl falls back to per-call `embed`; provider
     * adapters can override to use the vendor's multi-input endpoint.
     */
    readonly embedBatch: (texts: ReadonlyArray<string>) => Effect.Effect<Float32Array[], EmbeddingError>
    /** Stable identifier for the underlying provider, e.g. `"api"` or `"tfidf"`. */
    readonly providerName: string
  }
}

export class EmbeddingService extends Context.Service<EmbeddingService, EmbeddingService.Interface>()(
  "@opencode/EmbeddingService",
) {}

// --------------------------------------------------------------------------
// Math helpers (shared by every consumer)
// --------------------------------------------------------------------------

/**
 * Cosine similarity between two equal-length vectors.
 *
 * Returns `dot(a, b) / (|a| * |b|)`; if either vector has zero norm or the
 * lengths differ, returns `0`. Mirrors the Rust
 * `EmbeddingClient::cosine_similarity` semantics.
 */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

// --------------------------------------------------------------------------
// Mock layer (tests / dev)
// --------------------------------------------------------------------------

/**
 * Deterministic, dependency-free embedding layer for tests. Produces a fixed
 * `dimension`-long Float32Array seeded by sha256(text), L2-normalised so
 * cosine similarity is well-defined and stable.
 *
 * Not cryptographically sound and not semantically meaningful — it only
 * exists to give retrieval / skill tests a deterministic vector source.
 */
export function mockLayer(options?: {
  dimension?: number
  embed?: (text: string) => Float32Array
}): Layer.Layer<EmbeddingService> {
  const dim = options?.dimension ?? 32
  const embed = options?.embed ?? ((text: string) => hashEmbedding(text, dim))
  const impl: EmbeddingService.Interface = {
    embed: (text) => Effect.sync(() => embed(text)),
    embedBatch: (texts) => Effect.sync(() => texts.map((t) => embed(t))),
    providerName: "mock",
  }
  return Layer.succeed(EmbeddingService, impl)
}

/**
 * Deterministic hash-seeded unit-norm vector. Each dimension is driven by a
 * byte of sha256(text) rescaled to [-1, 1], then the vector is L2-normalised
 * so cosine similarity reduces to the dot product.
 */
export function hashEmbedding(text: string, dimension: number): Float32Array {
  const hasher = createHash("sha256")
  hasher.update(text)
  const digest = hasher.digest()
  const v = new Float32Array(dimension)
  for (let i = 0; i < dimension; i++) {
    const b = digest[i % digest.length]!
    v[i] = (b - 127.5) / 127.5
  }
  let sumSq = 0
  for (let i = 0; i < dimension; i++) sumSq += v[i]! * v[i]!
  const norm = Math.sqrt(sumSq)
  if (norm > 0) for (let i = 0; i < dimension; i++) v[i] = v[i]! / norm
  return v
}

// --------------------------------------------------------------------------
// Provider re-exports
// --------------------------------------------------------------------------

export {
  DEFAULT_EMBEDDING_BASE_URL,
  DEFAULT_EMBEDDING_MODEL,
  openAICompatLayer,
  type OpenAICompatConfig,
} from "./openai"
export {
  DEFAULT_TFIDF_VOCAB_SIZE,
  localTfIdfLayer,
  tfidfEmbed,
  LocalTfIdfCorpus,
  type LocalTfIdfCorpusFile,
  type LocalTfIdfQueryResult,
} from "./tfidf"

// --------------------------------------------------------------------------
// Provider selection
// --------------------------------------------------------------------------

import { openAICompatLayer as _openAICompatLayer, type OpenAICompatConfig } from "./openai"
import { localTfIdfLayer as _localTfIdfLayer } from "./tfidf"

/**
 * Resolve the user-requested embedding provider. Honoured values:
 *
 *   - `"local"` / `"tfidf"` → always use the local TF-IDF fallback.
 *   - `"api"` / `"openai"`  → use the HTTP provider; no fallback on auth
 *                              failure (callers who *want* fallback should
 *                              call {@link autoEmbeddingLayer}).
 *   - anything else         → `"auto"` (HTTP if config present, else local).
 *
 * Reads `OPENCODE_EMBEDDING_PROVIDER` at call time so tests that mutate
 * `process.env` between runs see the updated value.
 */
export function resolveEmbeddingProvider(): "local" | "api" | "auto" {
  const raw = (process.env["OPENCODE_EMBEDDING_PROVIDER"] ?? "").trim().toLowerCase()
  if (raw === "local" || raw === "tfidf") return "local"
  if (raw === "api" || raw === "openai") return "api"
  return "auto"
}

/**
 * Build an {@link EmbeddingService} layer with an auto-fallback to the local
 * TF-IDF provider. Selection rules:
 *
 *   - `OPENCODE_EMBEDDING_PROVIDER=local` forces the TF-IDF fallback.
 *   - `OPENCODE_EMBEDDING_PROVIDER=api`   forces the HTTP provider (requires
 *     `apiConfig`).
 *   - Otherwise: use `apiConfig` when provided, else fall back to local.
 *
 * The returned layer never errors at construction time; any HTTP failure
 * surfaces on the `embed`/`embedBatch` call sites. Callers that want a
 * *runtime* fallback (e.g. silently swap to local on the first `401`) can
 * wrap this layer with their own Effect-level retry strategy.
 */
export function autoEmbeddingLayer(options?: {
  apiConfig?: OpenAICompatConfig
  localVocabSize?: number
}): Layer.Layer<EmbeddingService> {
  const provider = resolveEmbeddingProvider()
  const local = () => _localTfIdfLayer({ vocabSize: options?.localVocabSize })
  if (provider === "local") return local()
  if (provider === "api") {
    if (!options?.apiConfig) {
      throw new Error(
        "OPENCODE_EMBEDDING_PROVIDER=api requires an apiConfig — pass one to autoEmbeddingLayer() or set provider=auto.",
      )
    }
    return _openAICompatLayer(options.apiConfig)
  }
  // auto
  return options?.apiConfig ? _openAICompatLayer(options.apiConfig) : local()
}
