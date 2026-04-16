import { Installation } from "@/installation"

/**
 * Premium quota information for a Copilot account.
 */
export interface PremiumQuota {
  remaining: number
  total: number
  percent: number
  unlimited: boolean
}

/**
 * Quota info fetched from /copilot_internal/user.
 */
export interface CopilotQuotaInfo {
  login?: string
  plan?: string
  premium?: PremiumQuota
  resetDate?: string
  accessTypeSku?: string
  /** Dynamic API base URL from endpoints.api */
  apiBaseUrl?: string
}

interface QuotaSnapshot {
  entitlement: number
  remaining: number
  percent_remaining: number
  unlimited: boolean
}

interface UserResponse {
  login?: string
  copilot_plan?: string
  access_type_sku?: string
  quota_reset_date?: string
  quota_snapshots?: {
    premium_interactions?: QuotaSnapshot
    chat?: QuotaSnapshot
    completions?: QuotaSnapshot
  }
  endpoints?: {
    api?: string
  }
}

/**
 * Fetch user info and quota from the GitHub Copilot internal API.
 * Uses "token" auth (not Bearer) per GitHub API convention.
 */
export async function fetchCopilotQuota(token: string): Promise<CopilotQuotaInfo> {
  const resp = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
      "User-Agent": `opencode/${Installation.VERSION}`,
    },
  })

  if (!resp.ok) {
    throw new Error(`Copilot user API returned ${resp.status}: ${await resp.text()}`)
  }

  const data = (await resp.json()) as UserResponse

  const premium = data.quota_snapshots?.premium_interactions
    ? {
        remaining: data.quota_snapshots.premium_interactions.remaining,
        total: data.quota_snapshots.premium_interactions.entitlement,
        percent: data.quota_snapshots.premium_interactions.percent_remaining,
        unlimited: data.quota_snapshots.premium_interactions.unlimited,
      }
    : undefined

  return {
    login: data.login,
    plan: data.copilot_plan,
    premium,
    resetDate: data.quota_reset_date,
    accessTypeSku: data.access_type_sku,
    apiBaseUrl: data.endpoints?.api?.replace(/\/$/, ""),
  }
}

/**
 * Parse quota snapshot from response headers.
 * Copilot API returns headers like:
 *   x-quota-snapshot-premium_interactions: ent=300&ov=0.0&ovPerm=false&rem=99.6&rst=2026-04-01T00%3A00%3A00Z
 *   x-quota-snapshot-chat: ...
 *   x-quota-snapshot-completions: ...
 */
export function parseQuotaHeaders(headers: Headers | Record<string, string>): {
  premiumInteractions?: PremiumQuota
  chat?: PremiumQuota
  completions?: PremiumQuota
} {
  const get = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name)
    return (headers as Record<string, string>)[name] ?? null
  }

  return {
    premiumInteractions: parseQuotaSnapshotHeader(get("x-quota-snapshot-premium_interactions")),
    chat: parseQuotaSnapshotHeader(get("x-quota-snapshot-chat")),
    completions: parseQuotaSnapshotHeader(get("x-quota-snapshot-completions")),
  }
}

function parseQuotaSnapshotHeader(value: string | null): PremiumQuota | undefined {
  if (!value) return undefined
  try {
    const params = new URLSearchParams(value)
    const ent = parseFloat(params.get("ent") || "0")
    const rem = parseFloat(params.get("rem") || "0")
    const unlimited = ent === -1
    return {
      total: unlimited ? Infinity : ent,
      remaining: rem,
      percent: rem,
      unlimited,
    }
  } catch {
    return undefined
  }
}

/**
 * Select the best account token from multiple accounts based on quota remaining.
 * Returns the token with the most remaining premium requests.
 */
export async function selectBestToken(
  accounts: Array<{ key: string; token: string }>
): Promise<{ key: string; token: string; quota?: CopilotQuotaInfo } | undefined> {
  if (accounts.length === 0) return undefined
  if (accounts.length === 1) {
    try {
      const quota = await fetchCopilotQuota(accounts[0].token)
      return { ...accounts[0], quota }
    } catch {
      return accounts[0]
    }
  }

  // Fetch quota for all accounts in parallel
  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const quota = await fetchCopilotQuota(account.token)
      return { ...account, quota }
    })
  )

  const withQuota = results
    .filter((r): r is PromiseFulfilledResult<{ key: string; token: string; quota: CopilotQuotaInfo }> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((r) => r.quota.premium && (r.quota.premium.unlimited || r.quota.premium.remaining > 0))
    .sort((a, b) => {
      // Prefer unlimited accounts
      if (a.quota.premium?.unlimited && !b.quota.premium?.unlimited) return -1
      if (!a.quota.premium?.unlimited && b.quota.premium?.unlimited) return 1
      // Then by remaining quota
      return (b.quota.premium?.remaining ?? 0) - (a.quota.premium?.remaining ?? 0)
    })

  if (withQuota.length > 0) {
    // Random among top accounts to distribute load
    const idx = Math.floor(Math.random() * Math.min(withQuota.length, 3))
    return withQuota[idx]
  }

  // All exhausted - return first account
  const fulfilled = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value)
  return fulfilled[0] || accounts[0]
}

/**
 * Format a visual quota bar for display.
 */
export function formatQuotaBar(premium: PremiumQuota, resetDate?: string): string {
  if (premium.unlimited) return "Unlimited"
  const width = 16
  if (premium.total <= 0) return "\u2591".repeat(width)
  const filled = Math.round((premium.remaining / premium.total) * width)
  const bar = `[${"█".repeat(Math.min(filled, width))}${"░".repeat(width - Math.min(filled, width))}]`
  const pct = `${Math.round(premium.percent)}% left`
  return resetDate ? `${bar} ${pct} (resets ${resetDate})` : `${bar} ${pct}`
}
