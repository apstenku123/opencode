import { HttpErrors } from "./errors"
import { HttpRetry } from "./retry"

/**
 * Shared HTTP client for opencode's native stack.
 *
 * Ports the pieces of `codex-rs/codex-client` that still had no TS
 * counterpart: a single `request(...)` entrypoint that layers
 *
 *   1. Custom CA support — `NODE_EXTRA_CA_CERTS` is picked up automatically
 *      by Node's TLS stack; callers that need *programmatic* bundles pass
 *      `caCerts` and we attach an undici dispatcher lazily.
 *   2. Per-request timeout — wraps `AbortSignal.timeout`, composing with any
 *      caller-supplied signal.
 *   3. Retry policy — exponential backoff + jitter + `Retry-After`, driven
 *      by {@link HttpRetry.run}. Only retryable `HttpError` kinds spin.
 *   4. Typed error triage — every non-2xx response becomes an
 *      {@link HttpErrors.HttpError} with `isAuthError / isRateLimited /
 *      isNetworkError` branches.
 *
 * The client is deliberately small: it does *not* own auth, plan logic, or
 * observability. Those live in the plugin layer (e.g. `copilot.ts`), which
 * delegates the raw transport here and keeps its rich runtime semantics.
 */
export namespace HttpClient {
  export interface RequestOptions extends Omit<RequestInit, "signal"> {
    /** Per-request timeout in ms. `0` disables the internal timeout. */
    timeoutMs?: number
    /** Caller-supplied abort signal; composed with the internal timeout. */
    signal?: AbortSignal
    /** Retry policy override. Defaults to {@link HttpRetry.DEFAULT}. */
    retry?: Partial<HttpRetry.Policy> | false
    /** Programmatic CA bundle (PEM). Augments `NODE_EXTRA_CA_CERTS`. */
    caCerts?: string | string[]
    /** Optional injected fetch (tests). Defaults to `globalThis.fetch`. */
    fetch?: typeof fetch
    /** Optional sleep injector (tests). */
    sleep?: (ms: number) => Promise<void>
    /** Optional RNG injector (tests). */
    rng?: () => number
    /**
     * Treat a non-2xx response as an {@link HttpErrors.HttpError}. Default
     * `true`. When `false`, the raw `Response` is returned even on 4xx/5xx.
     */
    throwOnError?: boolean
  }

  /**
   * Node's global `fetch` already honours `NODE_EXTRA_CA_CERTS` via its
   * bundled undici. For programmatic CA bundles we lazily construct an
   * undici `Agent` so we don't pay the import cost when nobody uses it.
   *
   * The dispatcher is memoized per unique CA payload to avoid leaking
   * sockets across every call.
   */
  const dispatcherCache = new Map<string, unknown>()

  async function caDispatcher(caCerts: string | string[]): Promise<unknown | undefined> {
    const joined = Array.isArray(caCerts) ? caCerts.join("\n") : caCerts
    if (!joined || joined.trim().length === 0) return undefined
    const cached = dispatcherCache.get(joined)
    if (cached) return cached
    try {
      const mod = await import("undici")
      const Agent = (mod as { Agent?: new (opts: unknown) => unknown }).Agent
      if (!Agent) return undefined
      const agent = new Agent({ connect: { ca: joined } })
      dispatcherCache.set(joined, agent)
      return agent
    } catch {
      // `undici` not installed in this runtime (e.g. browser); silently
      // fall back to plain fetch so the caller's env-based CA still works.
      return undefined
    }
  }

  /**
   * Reset the programmatic CA dispatcher cache. Primarily useful for tests.
   */
  export function resetCaCache() {
    dispatcherCache.clear()
  }

  function composeSignal(timeoutMs: number | undefined, extra: AbortSignal | undefined): {
    signal?: AbortSignal
    dispose: () => void
  } {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let aborted = false
    const abort = (reason: unknown) => {
      if (aborted) return
      aborted = true
      controller.abort(reason)
    }
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs)
    }
    if (extra) {
      if (extra.aborted) abort(extra.reason)
      else extra.addEventListener("abort", () => abort(extra.reason), { once: true })
    }
    return {
      signal: controller.signal,
      dispose: () => {
        if (timer) clearTimeout(timer)
      },
    }
  }

  function resolvePolicy(input: RequestOptions["retry"]): HttpRetry.Policy | undefined {
    if (input === false) return undefined
    if (!input) return HttpRetry.DEFAULT
    return { ...HttpRetry.DEFAULT, ...input }
  }

  async function readSnippet(res: Response, limit = 512): Promise<string | undefined> {
    try {
      const clone = res.clone()
      const text = await clone.text()
      if (!text) return undefined
      return text.length > limit ? `${text.slice(0, limit)}…` : text
    } catch {
      return undefined
    }
  }

  /**
   * Execute a single HTTP request with typed errors + optional retry.
   *
   * Body handling follows the Fetch spec: callers that pass a streamed
   * body and want retries must ensure the body is re-readable (e.g. a
   * string / `Uint8Array` / `Blob`). Non-replayable bodies + `retry !==
   * false` will throw on the second attempt as a defensive signal.
   */
  export async function request(input: string | URL | Request, opts: RequestOptions = {}): Promise<Response> {
    const policy = resolvePolicy(opts.retry)
    const fetchImpl = opts.fetch ?? globalThis.fetch
    const throwOnError = opts.throwOnError !== false

    const body = opts.body
    const bodyReusable =
      body === undefined ||
      body === null ||
      typeof body === "string" ||
      body instanceof ArrayBuffer ||
      body instanceof Uint8Array ||
      (typeof Blob !== "undefined" && body instanceof Blob) ||
      (typeof FormData !== "undefined" && body instanceof FormData) ||
      (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams)

    const dispatcher = opts.caCerts ? await caDispatcher(opts.caCerts) : undefined

    const runOnce = async (attempt: number): Promise<Response> => {
      if (attempt > 1 && !bodyReusable) {
        throw new HttpErrors.HttpError({
          kind: "transport",
          message: "request body is not replayable; disable retry or pass a buffered body",
        })
      }

      const composed = composeSignal(opts.timeoutMs, opts.signal)
      const init: RequestInit & { dispatcher?: unknown } = {
        method: opts.method,
        headers: opts.headers,
        body,
        cache: opts.cache,
        credentials: opts.credentials,
        integrity: opts.integrity,
        keepalive: opts.keepalive,
        mode: opts.mode,
        redirect: opts.redirect,
        referrer: opts.referrer,
        referrerPolicy: opts.referrerPolicy,
        signal: composed.signal,
      }
      if (dispatcher) init.dispatcher = dispatcher

      let res: Response
      try {
        res = await fetchImpl(input as RequestInfo, init)
      } catch (err) {
        const aborted =
          (err instanceof Error && err.name === "AbortError") ||
          (err as { code?: string } | undefined)?.code === "ABORT_ERR"
        const timeout = aborted && (opts.timeoutMs ?? 0) > 0 && !opts.signal?.aborted
        throw HttpErrors.fromTransport(err, { timeout })
      } finally {
        composed.dispose()
      }

      if (!throwOnError) return res
      if (res.status >= 200 && res.status < 300) return res
      const snippet = await readSnippet(res)
      throw HttpErrors.fromResponse(res, snippet)
    }

    if (!policy) return runOnce(1)
    return HttpRetry.run(policy, runOnce, { sleep: opts.sleep, rng: opts.rng })
  }

  /**
   * Convenience: request + parse JSON with the standard error mapping.
   */
  export async function json<T = unknown>(input: string | URL | Request, opts: RequestOptions = {}): Promise<T> {
    const res = await request(input, opts)
    try {
      return (await res.json()) as T
    } catch (err) {
      throw new HttpErrors.HttpError({
        kind: "decode",
        message: err instanceof Error ? `failed to decode JSON: ${err.message}` : "failed to decode JSON",
        status: res.status,
        headers: HttpErrors.snapshotHeaders(res.headers),
        cause: err,
      })
    }
  }

  /** Programmatic accessor for the default retry policy. */
  export const defaultRetry = HttpRetry.DEFAULT
}
