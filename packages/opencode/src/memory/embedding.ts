/**
 * Provider-neutral text-embedding client.
 *
 * Round 1 ships a minimal OpenAI-compatible `POST /v1/embeddings` adapter
 * behind a `Context.Service` interface so tests can substitute a deterministic
 * fake layer (`EmbeddingService.mockLayer`). Later rounds will plumb this
 * through the same provider/account resolver autoskill uses.
 *
 * The contract: `embed(text)` → `Effect<Float32Array, MemoryEmbeddingError>`.
 * The Float32Array is the raw 1-D dense vector; the caller decides dimension
 * and model. The client is intentionally stateless — batching, retries, and
 * rate-limit handling belong in the calling pipeline, not here.
 */

import { Context, Effect, Layer } from "effect"
import { createHash } from "node:crypto"
import { MemoryEmbeddingError } from "./schema"

// --------------------------------------------------------------------------
// Service contract
// --------------------------------------------------------------------------

export namespace EmbeddingService {
  export interface Interface {
    readonly embed: (text: string) => Effect.Effect<Float32Array, MemoryEmbeddingError>
    /**
     * Optional batch helper. Default impl falls back to per-call `embed`; a
     * real provider adapter can override this to use the vendor's
     * multi-input endpoint for cost/latency.
     */
    readonly embedBatch: (texts: ReadonlyArray<string>) => Effect.Effect<Float32Array[], MemoryEmbeddingError>
  }
}

export class EmbeddingService extends Context.Service<EmbeddingService, EmbeddingService.Interface>()(
  "@opencode/memory/EmbeddingService",
) {}

// --------------------------------------------------------------------------
// OpenAI-compatible HTTP adapter
// --------------------------------------------------------------------------

/**
 * Config for the OpenAI-compatible embedding endpoint. `apiBaseURL` defaults
 * to OpenAI's production `/v1`. `apiKey` is read from the caller — we do not
 * touch OPENCODE env vars at this layer (round 2 wires the config-resolver).
 */
export interface OpenAICompatConfig {
  readonly apiBaseURL?: string
  readonly apiKey: string
  readonly model: string
  /** Optional request timeout in ms, default 30_000. */
  readonly timeoutMs?: number
  /** Optional `fetch` override — useful for tests. */
  readonly fetch?: typeof fetch
}

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
export const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Build an `EmbeddingService` layer backed by a live OpenAI-compat HTTP
 * endpoint. The layer is intentionally a plain function so callers can
 * compose it with `Layer.provide` at the application root.
 */
export function openAICompatLayer(config: OpenAICompatConfig): Layer.Layer<EmbeddingService> {
  const baseURL = (config.apiBaseURL ?? DEFAULT_EMBEDDING_BASE_URL).replace(/\/+$/, "")
  const model = config.model
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = config.fetch ?? fetch

  const callApi = (input: string | string[]): Effect.Effect<Float32Array[], MemoryEmbeddingError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const url = `${baseURL}/embeddings`
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), timeoutMs)
        const onAbort = () => ac.abort(signal.reason)
        signal.addEventListener("abort", onAbort, { once: true })
        try {
          const response = await fetchImpl(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({ model, input }),
            signal: ac.signal,
          })
          if (!response.ok) {
            const body = await response.text().catch(() => "")
            throw new Error(`embedding request failed: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`)
          }
          const payload = (await response.json()) as {
            data?: Array<{ embedding?: ReadonlyArray<number> | number[] }>
          }
          const data = payload.data
          if (!Array.isArray(data) || data.length === 0) {
            throw new Error("embedding response missing `data`")
          }
          return data.map((entry) => {
            if (!entry?.embedding || !Array.isArray(entry.embedding)) {
              throw new Error("embedding response entry missing `embedding`")
            }
            return Float32Array.from(entry.embedding)
          })
        } finally {
          clearTimeout(timer)
          signal.removeEventListener("abort", onAbort)
        }
      },
      catch: (cause) =>
        new MemoryEmbeddingError({
          message: cause instanceof Error ? cause.message : "embedding request failed",
          cause,
        }),
    })

  const impl: EmbeddingService.Interface = {
    embed: (text) => callApi(text).pipe(Effect.map((vectors) => vectors[0]!)),
    embedBatch: (texts) => (texts.length === 0 ? Effect.succeed([] as Float32Array[]) : callApi([...texts])),
  }

  return Layer.succeed(EmbeddingService, impl)
}

// --------------------------------------------------------------------------
// Mock layer (tests / dev)
// --------------------------------------------------------------------------

/**
 * Deterministic, dependency-free embedding layer for tests. Produces a fixed
 * `dimension`-long Float32Array seeded by the text's SHA-256, unit-normalized
 * so cosine similarity is well-defined and stable.
 *
 * Not cryptographically sound and not semantically meaningful — it only
 * exists to give retrieval tests a deterministic, cosine-friendly vector.
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
  }

  return Layer.succeed(EmbeddingService, impl)
}

/**
 * Deterministic hash-seeded unit-norm vector. Each dimension is driven by a
 * byte of sha256(text) rescaled to [-1, 1], then the vector is L2-normalized
 * so cosine similarity reduces to dot product.
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
  // L2-normalize
  let sumSq = 0
  for (let i = 0; i < dimension; i++) sumSq += v[i]! * v[i]!
  const norm = Math.sqrt(sumSq)
  if (norm > 0) for (let i = 0; i < dimension; i++) v[i] = v[i]! / norm
  return v
}
