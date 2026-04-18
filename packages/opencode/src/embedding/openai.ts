/**
 * OpenAI-compatible embedding provider.
 *
 * Posts to `{baseURL}/embeddings` with the standard request body and parses
 * the OpenAI response shape. Works against OpenAI itself, vLLM, llama.cpp,
 * Ollama, etc. — anything that speaks the `/v1/embeddings` API contract.
 *
 * Round 2 ports the simpler call-shape from the round-1 memory module
 * verbatim (no retries, no caching). Retries / dim-caching are deferred to a
 * later round when we have the broader provider/account resolver wired in
 * — at which point this module's `fetch` adapter is the place to extend.
 */

import { Effect, Layer } from "effect"
import { EmbeddingError, EmbeddingService } from "./index"

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
export const DEFAULT_EMBEDDING_BASE_URL = "https://api.openai.com/v1"
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Config for the OpenAI-compatible embedding endpoint. `apiBaseURL` defaults
 * to OpenAI's production `/v1`. `apiKey` is read from the caller — the
 * provider/account resolver lives at the application layer, not here.
 */
export interface OpenAICompatConfig {
  readonly apiBaseURL?: string
  readonly apiKey: string
  readonly model: string
  /** Optional request timeout in ms, default 30_000. */
  readonly timeoutMs?: number
  /** Optional `fetch` override — used by tests to stub HTTP. */
  readonly fetch?: typeof fetch
}

/**
 * Build an {@link EmbeddingService} layer backed by an OpenAI-compatible
 * `/embeddings` HTTP endpoint.
 */
export function openAICompatLayer(config: OpenAICompatConfig): Layer.Layer<EmbeddingService> {
  return Layer.succeed(EmbeddingService, makeImpl(config))
}

/**
 * Lower-level factory used by the memory shim so it can wrap the impl into
 * its own service tag without re-implementing the HTTP plumbing.
 */
export function makeImpl(config: OpenAICompatConfig): EmbeddingService.Interface {
  const baseURL = (config.apiBaseURL ?? DEFAULT_EMBEDDING_BASE_URL).replace(/\/+$/, "")
  const model = config.model
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchImpl = config.fetch ?? fetch

  const callApi = (input: string | string[]): Effect.Effect<Float32Array[], EmbeddingError> =>
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
            throw new Error(
              `embedding request failed: ${response.status} ${response.statusText} — ${body.slice(0, 500)}`,
            )
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
        new EmbeddingError({
          message: cause instanceof Error ? cause.message : "embedding request failed",
          cause,
        }),
    })

  return {
    embed: (text) => callApi(text).pipe(Effect.map((vectors) => vectors[0]!)),
    embedBatch: (texts) => (texts.length === 0 ? Effect.succeed([] as Float32Array[]) : callApi([...texts])),
    providerName: "api",
  }
}
