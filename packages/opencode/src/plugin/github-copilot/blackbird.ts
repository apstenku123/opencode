/**
 * GitHub Copilot BlackBird API client.
 *
 * Ports the Rust `BlackbirdClient` from
 * `codex-rs/github-copilot/src/blackbird.rs` (~509 LOC) to TypeScript,
 * integrating with the TS plugin's proxy/auth stack:
 *
 *   - `proxyConfig` + `routedFetch` from `./copilot.ts` for per-account
 *     proxy envelope support (`OPENCODE_COPILOT_PROXY_ENVELOPE=1` or
 *     per-account `envelope: true`).
 *   - `copilotStatus` triage so callers receive the same
 *     `{rateLimited, authError, networkError}` classification used by the
 *     chat/completions `dispatch()` path.
 *   - Optional `AccountPool` integration: a 429 routes through
 *     `pool.recordExhaustion(key)` (which honours `Retry-After` and runs
 *     the 11m→21m→41m headerless-429 escalator), a 401 deactivates the
 *     account via the connection `Store`.
 *
 * ## Endpoints
 *
 * - `POST /chunks` — split files into semantic chunks
 * - `POST /embeddings` — generate embeddings (64 inputs per batch)
 * - `POST /embeddings/code/search` — semantic code search across a repo
 * - `GET  /repos/{owner}/{repo}/copilot_internal/embeddings_index` —
 *   check if a repo is indexed
 *
 * ## Authentication & API version
 *
 * Uses the raw OAuth `gho_` refresh token (same as `/copilot_internal/user`),
 * not the exchanged session token, and sets
 * `X-GitHub-Api-Version: 2025-05-01` — distinct from the chat/completions
 * API's `2026-01-09`.
 */

import { Effect } from "effect"
import { InstallationVersion } from "@/installation/version"
import { copilotStatus, envelopeEnabled, proxyConfig, routedFetch } from "./copilot"
import { markDeactivated } from "./connections"
import type { State } from "./connections"
import type { AccountPool } from "./account-pool"
import {
  ChunksResponseSchema,
  CodeSearchResponseSchema,
  EmbeddingsIndexResponseSchema,
  EmbeddingsResponseSchema,
  type Chunk,
  type ChunksRequest,
  type CodeSearchRequest,
  type CodeSearchResult,
  type EmbeddingResult,
} from "./blackbird-schema"

/** Base URL for BlackBird endpoints (same host as the GitHub REST API). */
export const BLACKBIRD_BASE_URL = "https://api.github.com"

/** `X-GitHub-Api-Version` value for BlackBird endpoints. */
export const BLACKBIRD_API_VERSION = "2025-05-01"

/** Default embedding model used by Copilot CLI. */
export const DEFAULT_EMBEDDING_MODEL = "metis-1024-I16-Binary"

/** Max inputs per embedding batch (matches Copilot CLI). */
export const EMBEDDING_BATCH_SIZE = 64

/** Default per-request timeout (ms) — matches Rust `DEFAULT_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Error thrown by the BlackBird client when the API returns a non-2xx
 * status. `status` of `0` indicates a network-level failure (thrown by
 * `fetch` itself, e.g. DNS resolution, TLS).
 */
export class BlackBirdError extends Error {
  readonly status: number
  readonly body: string
  readonly rateLimited: boolean
  readonly authError: boolean
  readonly networkError: boolean
  readonly retryAfterSec?: number
  constructor(input: {
    status: number
    body: string
    rateLimited?: boolean
    authError?: boolean
    networkError?: boolean
    retryAfterSec?: number
  }) {
    super(`BlackBird API error ${input.status}: ${input.body.slice(0, 200)}`)
    this.name = "BlackBirdError"
    this.status = input.status
    this.body = input.body
    this.rateLimited = input.rateLimited ?? false
    this.authError = input.authError ?? false
    this.networkError = input.networkError ?? false
    this.retryAfterSec = input.retryAfterSec
  }
}

/**
 * Configuration for a BlackBird request. When `state` + `key` are supplied
 * the client resolves the per-account proxy envelope via `proxyConfig`.
 *
 * When `pool` is supplied, a 429 is recorded through
 * `AccountPool.recordExhaustion` (honouring `Retry-After` and the
 * escalator). When `writeState` is supplied a 401/403 marks the account
 * deactivated in the connection store.
 */
export interface BlackBirdOptions {
  /** Raw OAuth `gho_` refresh token. */
  token: string
  /** Override the BlackBird base URL (GHE / tests). Trailing slash is stripped. */
  baseUrl?: string
  /** Per-request timeout override (default: 30s). Used via `AbortController`. */
  timeoutMs?: number
  /** Enterprise host header — unused by upstream today but mirrors `fetchQuota`. */
  enterpriseUrl?: string
  /**
   * Connection state + account key. When both are present the client
   * routes through `proxyConfig(state, key)` so the per-account envelope
   * proxy (or URL-rewrite proxy) is honoured.
   */
  state?: State
  key?: string
  /** Shared `AccountPool`. A 429 is reported via `recordExhaustion(key)`. */
  pool?: AccountPool
  /**
   * State mutator called on 401/403 to persist `markDeactivated`. Optional
   * because many callers (e.g. one-shot CLI tools) don't maintain a
   * persistent connection store.
   */
  writeState?: (state: State) => Promise<void> | void
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

function baseHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": `opencode/${InstallationVersion}`,
    "X-GitHub-Api-Version": BLACKBIRD_API_VERSION,
  }
}

function searchHeaders(): Record<string, string> {
  // Mirrors `search_code` + `is_repo_indexed` in Rust: tells the server
  // this is a workspace-scoped code-search request from an agent tool.
  return {
    "X-Client-Application": "sweagentd",
    "X-Client-Features": "blackbird_tool",
  }
}

/**
 * Run a BlackBird API request through `routedFetch` (envelope-aware) +
 * handle the triage result: 401/403 deactivates the account, 429 feeds
 * the pool, every other non-2xx throws a `BlackBirdError`.
 */
async function blackbirdRequest<T>(
  opts: BlackBirdOptions,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  parse: (json: unknown) => T,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const configuredBase = stripTrailingSlash(opts.baseUrl ?? BLACKBIRD_BASE_URL)
  const cfg = opts.state && opts.key ? proxyConfig(opts.state, opts.key) : undefined
  // When a per-account proxy is configured and the envelope protocol is
  // NOT in play, the proxy URL replaces `api.github.com` as the effective
  // base (mirrors `fetchQuota`'s URL-rewrite fallback). In envelope mode
  // the base URL is preserved because the inner envelope carries the real
  // target URL as `envelope.url`.
  const baseUrl =
    cfg?.url && !envelopeEnabled(cfg as { envelope?: boolean })
      ? stripTrailingSlash(cfg.url)
      : configuredBase
  const url = `${baseUrl}${path}`
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const headers = {
    ...baseHeaders(opts.token),
    ...extraHeaders,
    ...(opts.enterpriseUrl ? { "X-GitHub-Enterprise-Host": opts.enterpriseUrl } : {}),
    "X-GitHub-Request-ID": crypto.randomUUID(),
  }
  let res: Response
  try {
    res = await routedFetch(
      url,
      {
        method,
        headers,
        body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      },
      cfg,
    )
  } catch (err) {
    clearTimeout(timer)
    throw new BlackBirdError({
      status: 0,
      body: err instanceof Error ? err.message : String(err),
      networkError: true,
    })
  }
  clearTimeout(timer)
  const triage = copilotStatus(res)
  if (triage.authError) {
    // 401/403 → mark the account deactivated and bail. Mirrors
    // `dispatchOnce` in `copilot.ts:1014-1024`.
    if (opts.state && opts.key && opts.writeState) {
      try {
        await opts.writeState(markDeactivated(opts.state, opts.key))
      } catch {
        // swallow — failure to persist shouldn't mask the upstream auth error
      }
    }
    const bodyText = await res.text().catch(() => "")
    throw new BlackBirdError({
      status: res.status,
      body: bodyText,
      authError: true,
    })
  }
  if (triage.rateLimited) {
    if (opts.pool && opts.key) {
      opts.pool.recordExhaustion(opts.key, {
        retryAfter: res.headers.get("retry-after") ?? res.headers.get("Retry-After"),
      })
    }
    const bodyText = await res.text().catch(() => "")
    throw new BlackBirdError({
      status: res.status,
      body: bodyText,
      rateLimited: true,
      retryAfterSec: triage.retryAfterSec,
    })
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "")
    throw new BlackBirdError({
      status: res.status,
      body: bodyText,
      networkError: triage.networkError,
    })
  }
  const json = (await res.json().catch(() => null)) as unknown
  return parse(json)
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Split files into semantic chunks. Mirrors Rust `get_chunks`.
 *
 * `POST {baseUrl}/chunks`
 */
export async function chunks(
  opts: BlackBirdOptions,
  request: ChunksRequest,
): Promise<Chunk[]> {
  const parsed = await blackbirdRequest(
    opts,
    "POST",
    "/chunks",
    request,
    (json) => ChunksResponseSchema.parse(json),
  )
  return parsed.chunks
}

/**
 * Split a single file's content into chunks. Thin helper around {@link chunks}
 * matching the `BlackBird.chunks(file, content, opts?)` signature requested
 * by the tool scope.
 */
export async function chunksForFile(
  file: string,
  content: string,
  opts: BlackBirdOptions,
): Promise<Chunk[]> {
  return chunks(opts, { documents: [{ path: file, content }] })
}

/**
 * Generate embeddings for `inputs`. Batches into 64-input requests to
 * match the Copilot CLI behaviour.
 *
 * `POST {baseUrl}/embeddings`
 */
export async function embed(
  opts: BlackBirdOptions,
  inputs: string[],
  model: string = DEFAULT_EMBEDDING_MODEL,
): Promise<EmbeddingResult[]> {
  const out: EmbeddingResult[] = []
  for (let i = 0; i < inputs.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = inputs.slice(i, i + EMBEDDING_BATCH_SIZE)
    const parsed = await blackbirdRequest(
      opts,
      "POST",
      "/embeddings",
      { inputs: batch, model },
      (json) => EmbeddingsResponseSchema.parse(json),
    )
    out.push(...parsed.embeddings)
  }
  return out
}

/**
 * Run a semantic code search against a repository index.
 *
 * `POST {baseUrl}/embeddings/code/search`
 */
export async function codeSearch(
  opts: BlackBirdOptions,
  input: {
    owner: string
    repo: string
    query: string
    maxResults?: number
    includeEmbeddings?: boolean
  },
): Promise<CodeSearchResult[]> {
  const request: CodeSearchRequest = {
    prompt: input.query,
    scoping_query: `repo:${input.owner}/${input.repo}`,
    include_embeddings: input.includeEmbeddings ?? false,
    limit: input.maxResults ?? 10,
  }
  const parsed = await blackbirdRequest(
    opts,
    "POST",
    "/embeddings/code/search",
    request,
    (json) => CodeSearchResponseSchema.parse(json),
    searchHeaders(),
  )
  return parsed.results
}

/**
 * Check whether a repository has a BlackBird embeddings index. Returns
 * `false` on any non-2xx status instead of throwing, matching Rust
 * `is_repo_indexed` semantics.
 */
export async function isRepoIndexed(
  opts: BlackBirdOptions,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const parsed = await blackbirdRequest(
      opts,
      "GET",
      `/repos/${owner}/${repo}/copilot_internal/embeddings_index`,
      undefined,
      (json) => EmbeddingsIndexResponseSchema.parse(json),
      searchHeaders(),
    )
    return parsed.semantic_code_search_ok
  } catch (err) {
    if (err instanceof BlackBirdError && err.authError) {
      // Preserve the deactivation side-effect but still surface `false`
      // — caller code-search fallbacks don't need the exception.
      return false
    }
    if (err instanceof BlackBirdError) return false
    throw err
  }
}

/**
 * Format code-search results as plain text. Matches Copilot CLI output:
 *
 * ```
 * path/to/file.rs:10-20
 * <chunk body>
 *
 * other/file.rs
 * <other chunk body>
 * ```
 */
export function formatSearchResults(results: CodeSearchResult[]): string {
  return results
    .map((r) => {
      const range = r.chunk.line_range ? `:${r.chunk.line_range.start}-${r.chunk.line_range.end}` : ""
      return `${r.location.path}${range}\n${r.chunk.text}`
    })
    .join("\n\n")
}

/**
 * L2-normalize an embedding vector in place. Matches Copilot CLI's
 * `HHr` helper + Rust `normalize_embedding`.
 */
export function normalizeEmbedding(embedding: number[]): void {
  let sum = 0
  for (const x of embedding) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm > 0) {
    for (let i = 0; i < embedding.length; i++) embedding[i] = embedding[i] / norm
  }
}

// ── Effect-flavoured namespace ──────────────────────────────────────────
//
// The scope asks for `BlackBird.embed(…): Effect<Embedding[]>` etc. We
// keep the pure async implementations above as the primary public surface
// (so tests can use mocked `globalThis.fetch` directly) and expose an
// `Effect`-shaped wrapper for call-sites that live inside the app
// runtime.

export namespace BlackBird {
  /** Re-exported Rust-compatible constants. */
  export const BASE_URL = BLACKBIRD_BASE_URL
  export const API_VERSION = BLACKBIRD_API_VERSION

  /** Effect wrapper around {@link embed}. */
  export function embed(
    opts: BlackBirdOptions,
    inputs: string[],
    model?: string,
  ): Effect.Effect<EmbeddingResult[], BlackBirdError> {
    return Effect.tryPromise({
      try: () => exportedEmbed(opts, inputs, model),
      catch: (err) => (err instanceof BlackBirdError ? err : toBlackBirdError(err)),
    })
  }

  /** Effect wrapper around {@link chunksForFile}. */
  export function chunks(
    file: string,
    content: string,
    opts: BlackBirdOptions,
  ): Effect.Effect<Chunk[], BlackBirdError> {
    return Effect.tryPromise({
      try: () => chunksForFile(file, content, opts),
      catch: (err) => (err instanceof BlackBirdError ? err : toBlackBirdError(err)),
    })
  }

  /** Effect wrapper around {@link codeSearch}. */
  export function codeSearch(
    opts: BlackBirdOptions,
    input: {
      owner: string
      repo: string
      query: string
      maxResults?: number
      includeEmbeddings?: boolean
    },
  ): Effect.Effect<CodeSearchResult[], BlackBirdError> {
    return Effect.tryPromise({
      try: () => exportedCodeSearch(opts, input),
      catch: (err) => (err instanceof BlackBirdError ? err : toBlackBirdError(err)),
    })
  }

  /** Effect wrapper around {@link isRepoIndexed}. */
  export function repoIndexed(
    opts: BlackBirdOptions,
    owner: string,
    repo: string,
  ): Effect.Effect<boolean, BlackBirdError> {
    return Effect.tryPromise({
      try: () => isRepoIndexed(opts, owner, repo),
      catch: (err) => (err instanceof BlackBirdError ? err : toBlackBirdError(err)),
    })
  }
}

// Aliases to avoid TS "declaration emit can't resolve" cycles caused by
// naming the namespace and the plain function identically.
const exportedEmbed = embed
const exportedCodeSearch = codeSearch

function toBlackBirdError(err: unknown): BlackBirdError {
  return new BlackBirdError({
    status: 0,
    body: err instanceof Error ? err.message : String(err),
    networkError: true,
  })
}
