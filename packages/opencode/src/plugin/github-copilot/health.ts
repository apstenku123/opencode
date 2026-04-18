/**
 * Account health triage.
 *
 * Mirrors Rust `check_account_statuses` in
 * `github-copilot/src/lib.rs:212-264` plus the `AccountStatus` shape from
 * `lib.rs:196-209`. Each connection is classified into one of four health
 * tiers:
 *
 *   - `"healthy"`     — quota OK, premium remaining (or unlimited)
 *   - `"deactivated"` — 401/403 from `/copilot_internal/user`
 *   - `"rateLimited"` — 429 from `/copilot_internal/user` *or* a non-zero
 *                       `exhaustedUntil` cooldown still in the future
 *   - `"networkError"` — DNS/timeout/5xx; transient, account is NOT poisoned
 *
 * Used by `providers accounts` (CLI) and exposed via the new
 * `accounts --json` envelope so external tooling can read status without
 * scraping the human-readable output.
 */
import type { CopilotAuth } from "./auth"
import type { State } from "./connections"
import { proxy } from "./connections"
import { fetchQuota, type Premium } from "./quota"

export type AccountHealth = "healthy" | "deactivated" | "rateLimited" | "networkError"

export type AccountStatusInfo = {
  key: string
  label: string
  login?: string
  health: AccountHealth
  /** Empty when `health === "healthy"`. */
  reason?: string
  /** From `/copilot_internal/user.quota_snapshots[premium].reset_date`. */
  resetDate?: string
  /** Premium quota snapshot when available (mirrors Rust `info.premium`). */
  premium?: Premium
}

/**
 * Classify a thrown `fetchQuota` error into one of the health buckets.
 * Mirrors `CopilotError::is_auth_error / is_rate_limited / is_network_error`
 * (`github-copilot/src/error.rs:27-64`).
 */
export function classifyHealthError(err: unknown): {
  health: Exclude<AccountHealth, "healthy">
  reason: string
} {
  const message = err instanceof Error ? err.message : String(err ?? "unknown error")
  // `fetchQuota` throws `Failed to fetch quota: <status>` on non-2xx responses.
  const match = message.match(/Failed to fetch quota: (\d{3})/)
  if (match) {
    const status = Number(match[1])
    if (status === 401 || status === 403) {
      return { health: "deactivated", reason: `auth failed (${status})` }
    }
    if (status === 429) {
      return { health: "rateLimited", reason: "rate limited (429)" }
    }
    if (status >= 500) {
      return { health: "networkError", reason: `network error: ${message}` }
    }
    return { health: "networkError", reason: `network error: ${message}` }
  }
  // No status → DNS / timeout / connection refused.
  return { health: "networkError", reason: `network error: ${message}` }
}

/**
 * Health-check a single account. The `now` parameter is injectable so
 * `selectAccount`'s pseudo-random spread (and tests) can pin the clock.
 */
export async function checkAccountStatus(input: {
  auth: CopilotAuth
  state: State
  now?: number
}): Promise<AccountStatusInfo> {
  const { auth, state } = input
  const now = input.now ?? Date.now()
  const cd = state.connections[auth.key]?.exhaustedUntil
  // Persisted cooldown takes precedence over a fresh probe — if we know the
  // account is in 429-cooldown there is no point spending a network call.
  if (cd && cd > now) {
    return {
      key: auth.key,
      label: auth.label,
      login: state.connections[auth.key]?.login,
      health: "rateLimited",
      reason: "in cooldown",
    }
  }
  if (state.connections[auth.key]?.deactivated) {
    return {
      key: auth.key,
      label: auth.label,
      login: state.connections[auth.key]?.login,
      health: "deactivated",
      reason: "marked deactivated",
    }
  }
  try {
    const cfg = proxy(state, auth.key)
    const quota = await fetchQuota(auth.refresh, auth.enterpriseUrl, cfg.url ? cfg : undefined)
    const exhausted =
      !!quota.premium && quota.premium.total > 0 && quota.premium.remaining <= 0
    return {
      key: auth.key,
      label: auth.label,
      login: quota.login ?? state.connections[auth.key]?.login,
      health: exhausted ? "rateLimited" : "healthy",
      reason: exhausted ? "0 premium remaining" : undefined,
      resetDate: quota.resetDate,
      premium: quota.premium,
    }
  } catch (err) {
    const triage = classifyHealthError(err)
    return {
      key: auth.key,
      label: auth.label,
      login: state.connections[auth.key]?.login,
      health: triage.health,
      reason: triage.reason,
    }
  }
}

/**
 * Health-check every configured Copilot account in parallel. Mirrors
 * `check_account_statuses` (`lib.rs:212-264`) which iterates serially in
 * Rust; we run concurrently because each call is bounded by the
 * `fetchQuota` timeout and there is no shared mutable state.
 */
export async function checkAccountStatuses(input: {
  auths: CopilotAuth[]
  state: State
  now?: number
}): Promise<AccountStatusInfo[]> {
  return Promise.all(input.auths.map((auth) => checkAccountStatus({ auth, state: input.state, now: input.now })))
}
