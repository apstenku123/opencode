/**
 * Explicit pool-routing policy for GitHub Copilot multi-account.
 *
 * Two pools are defined: `edu` (free/unlimited accounts) and `prod`
 * (pro/enterprise/business/team). Model families are mapped to a
 * pool explicitly rather than via substring matching on the modelId
 * so we can route premium / anchored variants (e.g. `claude-4.7-opus-high`,
 * `gpt-5.4-xhigh`, `codex-5.3-xhigh`) deterministically.
 *
 * Consumers:
 *   - `copilot.ts::policyPlan()` delegates to `gateModel(modelId).pool`
 *     when the model is mapped, so `preferPolicy()` narrows the account
 *     lane to the right pool.
 *   - `copilot.ts::preferPlan()` narrows the routable account set to
 *     the pool's account keys when explicit config lists them.
 *   - `providers.ts` CLI renders `pool=<edu|prod|...>` per account.
 *
 * Fallback: when no config is provided, `DEFAULT_POOL_RULES` drives the
 * mapping. When the model isn't in the map, callers fall back to the
 * legacy substring `policyPlan` behaviour so we don't break existing
 * `gpt-5-enterprise` / `gpt-4.1-edu` aliases.
 */

export type PoolId = "edu" | "prod"

export type PoolConfig = {
  /**
   * Pool → list of account keys that are *members* of the pool. When a
   * key appears here it overrides the account's `plan` classification.
   * Useful for pinning a specific `github-copilot#x` account to `edu`
   * even if its SKU reports as `free`.
   */
  pools?: Partial<Record<PoolId, string[]>>
  /**
   * Explicit model → pool routing table. Merges with `DEFAULT_POOL_RULES`;
   * user entries win.
   */
  models?: Record<string, PoolId>
  /**
   * Model-family prefixes that only permit their `-xhigh` variant.
   * Non-`-xhigh` requests against these families are rejected by
   * `gateModel()` with `allow: false, reason: "only xhigh variants permitted for <family>"`.
   *
   * Defaults to `["gpt-5.4", "codex-5.3"]`.
   */
  xhighOnly?: string[]
}

/**
 * Default model → pool table. Explicit entries; no substring inference.
 * Callers can extend this via `config.copilot.poolRouting.models`.
 */
export const DEFAULT_POOL_RULES: Readonly<Record<string, PoolId>> = Object.freeze({
  "codex-5.3": "edu",
  "codex-5.3-xhigh": "edu",
  "gpt-5.4": "prod",
  "gpt-5.4-xhigh": "prod",
  "claude-4.7-opus-high": "prod",
  "claude-sonnet-4.7": "prod",
})

export const DEFAULT_XHIGH_ONLY: readonly string[] = Object.freeze(["gpt-5.4", "codex-5.3"])

export type GateResult = {
  pool: PoolId | undefined
  allow: boolean
  reason?: string
}

/**
 * Merge `DEFAULT_POOL_RULES` with any user-supplied map. User entries
 * override defaults (so an operator can pin `gpt-5.4-xhigh` to `edu`
 * for a pilot). Returns a plain record for cheap O(1) lookups.
 */
export function mergedRules(cfg?: PoolConfig): Record<string, PoolId> {
  return { ...DEFAULT_POOL_RULES, ...(cfg?.models ?? {}) }
}

/**
 * Look up the pool for a specific `modelId`. Returns `undefined` when
 * the model isn't mapped — callers fall back to legacy substring
 * matching (`policyPlan`) in that case.
 */
export function poolFor(modelId: string, cfg?: PoolConfig): PoolId | undefined {
  if (!modelId) return undefined
  const rules = mergedRules(cfg)
  return rules[modelId]
}

/**
 * List all modelIds that currently route to the given pool. Order is
 * insertion order (defaults first, then config). Useful for display /
 * CLI listings.
 */
export function allowedModels(pool: PoolId, cfg?: PoolConfig): string[] {
  const rules = mergedRules(cfg)
  return Object.entries(rules)
    .filter(([, value]) => value === pool)
    .map(([key]) => key)
}

/**
 * Gate a model dispatch. Enforces the `xhighOnly` family rule — for
 * configured families (default `gpt-5.4` + `codex-5.3`) we only permit
 * the `-xhigh` variant. Non-xhigh requests receive `allow: false` with a
 * human-readable reason the dispatcher can surface.
 *
 * When the model isn't in the routing table, `pool` is `undefined` and
 * `allow` is `true` — the caller keeps its legacy behaviour.
 */
export function gateModel(modelId: string, cfg?: PoolConfig): GateResult {
  const xhighOnly = cfg?.xhighOnly ?? DEFAULT_XHIGH_ONLY
  for (const family of xhighOnly) {
    // family matches *exactly* (the base id, e.g. `gpt-5.4`) or any
    // variant prefix that is not the allowed `-xhigh` form.
    if (modelId === family || (modelId.startsWith(`${family}-`) && modelId !== `${family}-xhigh`)) {
      return {
        pool: poolFor(modelId, cfg),
        allow: false,
        reason: `only xhigh variants permitted for ${family}`,
      }
    }
  }
  return { pool: poolFor(modelId, cfg), allow: true }
}

/**
 * Resolve the pool assignment for a *specific account key* given the
 * optional config + the account's plan classification. Config-driven
 * `pools.{edu,prod}` membership wins; otherwise the account's plan
 * classifies it (`edu`/`free` → edu; `enterprise|pro|business|team` →
 * prod). Returns `undefined` when neither rule matches.
 */
export function poolForAccount(input: {
  key: string
  plan?: string | undefined
  cfg?: PoolConfig
}): PoolId | undefined {
  const { key, plan, cfg } = input
  if (cfg?.pools) {
    const explicit = (Object.entries(cfg.pools) as Array<[PoolId, string[] | undefined]>).find(([, keys]) =>
      keys?.includes(key),
    )
    if (explicit) return explicit[0]
  }
  // Keys following the `github-copilot#edu-*` test-pool convention route
  // to the edu pool regardless of whether quota discovery has resolved a
  // `plan`. Mirrors codex_git's `#edu-` filter in `connections.rs:217` —
  // every edu-prefixed key is a test/supplementary slot in the edu pool.
  if (/^github-copilot#edu-/.test(key)) return "edu"
  if (!plan) return undefined
  const normalized = plan.toLowerCase()
  // "edu", "free", and "individual" (Copilot Pro / personal seat) all
  // carry limited-quota traffic that's safe to use as the test pool.
  // User routing treats anything non-enterprise as edu — codex-5.3-xhigh
  // prod traffic + gpt-4.1/gpt-5-mini-xhigh test traffic both route to
  // these accounts, while enterprise-only traffic (gpt-5.4-xhigh,
  // claude-4.7-opus-high) stays on the enterprise pool.
  if (normalized === "edu" || normalized === "free" || normalized === "individual") return "edu"
  if (
    normalized === "enterprise" ||
    normalized === "pro" ||
    normalized === "business" ||
    normalized === "team"
  ) {
    return "prod"
  }
  return undefined
}

/**
 * Extract the `PoolConfig` from the top-level opencode config shape.
 * Tolerates missing / malformed values by returning `undefined`.
 */
export function extractPoolConfig(config?: {
  copilot?: { poolRouting?: unknown } | undefined
}): PoolConfig | undefined {
  const raw = config?.copilot?.poolRouting
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as Record<string, unknown>
  const out: PoolConfig = {}
  if (obj.pools && typeof obj.pools === "object") out.pools = obj.pools as PoolConfig["pools"]
  if (obj.models && typeof obj.models === "object") out.models = obj.models as PoolConfig["models"]
  if (Array.isArray(obj.xhighOnly)) out.xhighOnly = obj.xhighOnly as string[]
  return out
}
