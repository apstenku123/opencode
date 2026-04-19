import type { Model } from "@opencode-ai/sdk/v2"
import path from "path"
import fs from "fs/promises"
import { Global } from "@/global"
import { CopilotModels } from "./models"

/**
 * In-memory + disk-backed cache for Copilot `/models` responses.
 *
 * Mirrors the Rust `ModelsCacheManager` in
 * `codex-rs/core/src/models_manager/{cache,manager}.rs`:
 * - Per-account TTL (default 5 minutes), refresh lock awareness,
 *   and stale-while-revalidate so concurrent callers never duplicate
 *   the same network fetch.
 * - Disk persistence under `$XDG_DATA_HOME/opencode/copilot-models-cache.json`
 *   (the path literal in the task brief is a Linux XDG default;
 *   `Global.Path.data` resolves to the platform-appropriate equivalent
 *   on macOS too).
 *
 * Cache entries are keyed by account key (`github-copilot`,
 * `github-copilot#corp`, …) and hold the exact `Record<string, Model>`
 * that `CopilotModels.get()` would have produced for that account,
 * including the plan-SKU filtered catalog.
 */
export namespace ModelsCache {
  export type Entry = {
    accountKey: string
    models: Record<string, Model>
    fetchedAt: number
    apiBase: string
    plan?: string
  }

  export type Options = {
    enabled: boolean
    ttlMs: number
    /**
     * Refresh in background if an entry's age is above this threshold,
     * but still below `ttlMs`.  Defaults to `ttlMs / 2`.  Set to `0`
     * to disable background refresh (classic hard-TTL).
     */
    staleWhileRevalidateMs: number
  }

  export const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 minutes
  export const DEFAULT_SWR_MS = 2.5 * 60 * 1000 // TTL / 2
  export const PERSIST_FILE = "copilot-models-cache.json"

  export type FetchArgs = {
    apiBase: string
    headers: HeadersInit
    existing: Record<string, Model>
    proxyUrl?: string
    plan?: string
    proxy?: { token?: string; envelope?: boolean }
  }

  export type FetchFn = (input: FetchArgs) => Promise<Record<string, Model>>

  /**
   * Default fetcher: forwards straight to `CopilotModels.get()`.
   * Call sites override this in tests.
   */
  export const defaultFetcher: FetchFn = (input) =>
    CopilotModels.get(input.apiBase, input.headers, input.existing, input.proxyUrl, input.plan, input.proxy)

  /**
   * Build an options object from a resolved opencode config
   * (`Config.Service.get()`).  Env overrides win over config file
   * which wins over defaults — same precedence as the rate-limiter
   * config helper in `rate-limiter.ts::copilotRateLimiterConfig`.
   */
  export function optionsFromConfig(config?: {
    copilot?: {
      modelsCache?: {
        enabled?: boolean
        ttlMs?: number
        staleWhileRevalidateMs?: number
      }
    }
  }): Options {
    const raw = config?.copilot?.modelsCache ?? {}
    const envNum = (v: string | undefined) => {
      if (v === undefined) return undefined
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : undefined
    }
    const envBool = (v: string | undefined) => {
      if (v === undefined) return undefined
      if (v === "0" || v.toLowerCase() === "false") return false
      if (v === "1" || v.toLowerCase() === "true") return true
      return undefined
    }
    const enabled = envBool(process.env.OPENCODE_COPILOT_MODELS_CACHE_ENABLED) ?? raw.enabled ?? true
    const ttlMs = envNum(process.env.OPENCODE_COPILOT_MODELS_CACHE_TTL_MS) ?? raw.ttlMs ?? DEFAULT_TTL_MS
    const swr =
      envNum(process.env.OPENCODE_COPILOT_MODELS_CACHE_SWR_MS) ?? raw.staleWhileRevalidateMs ?? Math.floor(ttlMs / 2)
    return { enabled, ttlMs, staleWhileRevalidateMs: swr }
  }

  /**
   * The cache manager.  All public methods are safe to call
   * concurrently from the same event loop; `get()` collapses racing
   * callers onto the same in-flight fetch.
   */
  export class Manager {
    private readonly entries = new Map<string, Entry>()
    private readonly inflight = new Map<string, Promise<Entry>>()
    private readonly persistPath: string
    private readonly options: Options
    private readonly fetcher: FetchFn
    private diskLoaded = false
    private diskLoadPromise: Promise<void> | undefined
    // Metrics so the CLI + tests can assert hit ratio.
    hits = 0
    misses = 0
    refreshes = 0
    swrRefreshes = 0

    constructor(opts: {
      options?: Options
      fetcher?: FetchFn
      persistPath?: string
    }) {
      this.options = opts.options ?? {
        enabled: true,
        ttlMs: DEFAULT_TTL_MS,
        staleWhileRevalidateMs: DEFAULT_SWR_MS,
      }
      this.fetcher = opts.fetcher ?? defaultFetcher
      this.persistPath = opts.persistPath ?? path.join(Global.Path.data, PERSIST_FILE)
    }

    /**
     * Primary entry point used by dispatch code.  The semantics match
     * the Rust `ModelsManager::get_default_model` contract:
     *
     * - cache hit within TTL → return cached immediately; optionally
     *   kick off an SWR refresh if `age > swrMs`.
     * - cache miss OR entry older than TTL → wait on (or start) a
     *   live fetch, store, return.
     * - concurrent callers all await the same in-flight fetch.
     *
     * When `options.enabled === false` the manager bypasses the
     * in-memory map entirely and returns `fetcher(input)` every call.
     */
    async get(
      accountKey: string,
      input: FetchArgs,
      opts?: { force?: boolean },
    ): Promise<Record<string, Model>> {
      if (!this.options.enabled) {
        this.misses++
        return this.fetcher(input)
      }
      await this.ensureDiskLoaded()
      const existing = this.entries.get(accountKey)
      const now = Date.now()
      if (!opts?.force && existing) {
        const age = now - existing.fetchedAt
        if (age < this.options.ttlMs) {
          this.hits++
          // Stale-while-revalidate: return cached now, refresh in background.
          if (
            this.options.staleWhileRevalidateMs > 0 &&
            age > this.options.staleWhileRevalidateMs &&
            !this.inflight.has(accountKey)
          ) {
            this.swrRefreshes++
            void this.startFetch(accountKey, input).catch(() => undefined)
          }
          return existing.models
        }
      }
      return (await this.startFetch(accountKey, input, opts?.force === true)).models
    }

    /**
     * Force a live fetch and replace whatever is cached for the key.
     */
    async refresh(accountKey: string, input: FetchArgs): Promise<Entry> {
      return this.startFetch(accountKey, input, true)
    }

    /** Peek at the in-memory entry without fetching. */
    peek(accountKey: string): Entry | undefined {
      return this.entries.get(accountKey)
    }

    /** Snapshot of every cached entry (used by the CLI list command). */
    list(): Entry[] {
      return [...this.entries.values()]
    }

    /** Invalidate one or all keys. */
    async clear(accountKey?: string): Promise<void> {
      if (accountKey) {
        this.entries.delete(accountKey)
      } else {
        this.entries.clear()
      }
      await this.persistToDisk().catch(() => undefined)
    }

    private async startFetch(accountKey: string, input: FetchArgs, isRefresh = false): Promise<Entry> {
      const current = this.inflight.get(accountKey)
      // Lock-awareness: if a live fetch is already racing and the caller
      // didn't explicitly request a fresh one, join it.  This prevents
      // discover-on-every-dispatch from firing N parallel HTTP calls.
      if (current && !isRefresh) return current
      const promise = (async () => {
        try {
          const models = await this.fetcher(input)
          const entry: Entry = {
            accountKey,
            models,
            fetchedAt: Date.now(),
            apiBase: input.apiBase,
            plan: input.plan,
          }
          this.entries.set(accountKey, entry)
          if (isRefresh) this.refreshes++
          else this.misses++
          await this.persistToDisk().catch(() => undefined)
          return entry
        } finally {
          this.inflight.delete(accountKey)
        }
      })()
      this.inflight.set(accountKey, promise)
      return promise
    }

    private async ensureDiskLoaded(): Promise<void> {
      if (this.diskLoaded) return
      if (this.diskLoadPromise) {
        await this.diskLoadPromise
        return
      }
      this.diskLoadPromise = (async () => {
        try {
          const buf = await fs.readFile(this.persistPath, "utf8")
          const parsed = JSON.parse(buf) as { entries?: Entry[] }
          const entries = Array.isArray(parsed.entries) ? parsed.entries : []
          for (const e of entries) {
            if (typeof e?.accountKey !== "string") continue
            if (typeof e?.fetchedAt !== "number") continue
            if (!e.models || typeof e.models !== "object") continue
            // Drop entries older than 2 * TTL so stale boot state
            // never hangs around forever.  Matches the spirit of the
            // Rust `ModelsCache::is_fresh` check.
            const maxAge = Math.max(this.options.ttlMs * 2, 60_000)
            if (Date.now() - e.fetchedAt > maxAge) continue
            this.entries.set(e.accountKey, e)
          }
        } catch {
          // File absent or unparseable — start with an empty cache.
        }
        this.diskLoaded = true
      })()
      await this.diskLoadPromise
    }

    private async persistToDisk(): Promise<void> {
      try {
        await fs.mkdir(path.dirname(this.persistPath), { recursive: true })
        const payload = {
          version: 1,
          entries: [...this.entries.values()],
        }
        await fs.writeFile(this.persistPath, JSON.stringify(payload, null, 2))
      } catch {
        // Disk persistence is best-effort; in-memory cache still works.
      }
    }
  }

  // Process-wide singleton.  Dispatch, alias, and probe code paths
  // all share it so a `/models` fetch for `github-copilot#corp` from
  // `aliasModels` also warms the cache consulted by the lazy probe
  // inside `providers accounts`.
  let singleton: Manager | undefined

  export function instance(): Manager {
    if (!singleton) {
      // Options are resolved lazily so tests that tweak env vars
      // before touching the module still win.
      singleton = new Manager({ options: optionsFromConfig() })
    }
    return singleton
  }

  /** Test-only. Swap the process-wide singleton. */
  export function __setInstance(m: Manager | undefined): void {
    singleton = m
  }
}
