/**
 * Typed error classes for the shared HTTP stack.
 *
 * Mirrors Rust `codex-client::error::HttpError` + the `CopilotError` triage
 * helpers (`github-copilot/src/error.rs::{is_auth_error,is_rate_limited,
 * is_network_error}`) so every caller of {@link HttpClient.request} can branch
 * on a single classification instead of re-parsing status codes.
 *
 * The hierarchy is flat on purpose — each error carries the inbound
 * `Response`/headers where useful so callers can surface plan-specific
 * diagnostics without the HTTP layer knowing about them.
 */
export namespace HttpErrors {
  export type Kind = "auth" | "rate-limited" | "network" | "timeout" | "transport" | "server" | "client" | "decode"

  export class HttpError extends Error {
    readonly kind: Kind
    readonly status?: number
    readonly retryAfterMs?: number
    readonly headers?: Record<string, string>
    readonly bodySnippet?: string
    override readonly cause?: unknown

    constructor(input: {
      kind: Kind
      message: string
      status?: number
      retryAfterMs?: number
      headers?: Record<string, string>
      bodySnippet?: string
      cause?: unknown
    }) {
      super(input.message)
      this.name = "HttpError"
      this.kind = input.kind
      this.status = input.status
      this.retryAfterMs = input.retryAfterMs
      this.headers = input.headers
      this.bodySnippet = input.bodySnippet
      this.cause = input.cause
    }

    isAuthError() {
      return this.kind === "auth"
    }
    isRateLimited() {
      return this.kind === "rate-limited"
    }
    isNetworkError() {
      return this.kind === "network" || this.kind === "transport" || this.kind === "timeout" || this.kind === "server"
    }
    isRetryable() {
      return this.isRateLimited() || this.kind === "network" || this.kind === "transport" || this.kind === "server" || this.kind === "timeout"
    }
  }

  /** Pull a single header value, tolerating both `Headers` and plain records. */
  export function headerValue(
    headers: Headers | Record<string, string> | undefined,
    name: string,
  ): string | undefined {
    if (!headers) return undefined
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name) ?? undefined
    }
    const rec = headers as Record<string, string>
    return rec[name] ?? rec[name.toLowerCase()] ?? undefined
  }

  /** Snapshot a `Headers` instance to a plain record for error propagation. */
  export function snapshotHeaders(headers: Headers | Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) return undefined
    if (typeof (headers as Headers).forEach === "function") {
      const out: Record<string, string> = {}
      ;(headers as Headers).forEach((v, k) => {
        out[k] = v
      })
      return out
    }
    return { ...(headers as Record<string, string>) }
  }

  /**
   * Parse a `Retry-After` header value (either seconds or HTTP-date).
   * Returns milliseconds or `undefined` when the header is absent/invalid.
   * Mirrors the Rust helper in `codex-client::retry::parse_retry_after`.
   */
  export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
    if (!value) return undefined
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const secs = Number(trimmed)
    if (Number.isFinite(secs)) {
      // Pure-numeric values are always seconds — positive returns the
      // delay, negative/NaN-less are treated as invalid (no HTTP-date
      // fallback, which would accept e.g. "-5" as year -5).
      return secs >= 0 ? Math.trunc(secs * 1000) : undefined
    }
    const date = Date.parse(trimmed)
    if (!Number.isNaN(date)) {
      const delta = date - now
      return delta > 0 ? delta : 0
    }
    return undefined
  }

  /**
   * Classify an HTTP response into an `HttpError` kind. Returns `undefined`
   * when the response is in the 2xx range (caller should treat as success).
   */
  export function classifyStatus(status: number): Kind | undefined {
    if (status >= 200 && status < 300) return undefined
    if (status === 401 || status === 403) return "auth"
    if (status === 429) return "rate-limited"
    if (status >= 500 && status < 600) return "server"
    return "client"
  }

  /** Build an {@link HttpError} from a `Response` + optional body snippet. */
  export function fromResponse(res: Response, bodySnippet?: string): HttpError {
    const kind = classifyStatus(res.status) ?? "client"
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"))
    return new HttpError({
      kind,
      message: `HTTP ${res.status} ${res.statusText || ""}`.trim(),
      status: res.status,
      retryAfterMs,
      headers: snapshotHeaders(res.headers),
      bodySnippet,
    })
  }

  /** Build an {@link HttpError} from a low-level fetch/transport failure. */
  export function fromTransport(cause: unknown, opts?: { timeout?: boolean }): HttpError {
    const kind: Kind = opts?.timeout ? "timeout" : "transport"
    const message = cause instanceof Error ? cause.message : String(cause)
    return new HttpError({
      kind,
      message: message || (opts?.timeout ? "request timed out" : "network error"),
      cause,
    })
  }
}
