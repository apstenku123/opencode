import { InstallationVersion } from "@/installation/version"
import { HttpClient } from "@/http/client"

export type Premium = {
  used: number
  total: number
  remaining: number
  percent: number
  unlimited: boolean
}

export type Quota = {
  login?: string
  plan?: string
  sku?: string
  api?: string
  premium?: Premium
  resetDate?: string
}

// Matches Rust `github-copilot/src/quota.rs::QuotaSnapshot`
type Snapshot = {
  entitlement?: number
  remaining?: number
  percent_remaining?: number
  unlimited?: boolean
}

// Matches Rust `QuotaSnapshots` — a keyed object, NOT an array.
type Snapshots = {
  premium_interactions?: Snapshot
  chat?: Snapshot
  completions?: Snapshot
}

type Payload = {
  // Rust uses `login` (not `user_login`). Accept both for resiliency.
  login?: string
  user_login?: string
  copilot_plan?: string
  access_type_sku?: string
  endpoints?: { api?: string }
  // Rust exposes `quota_reset_date` at the top level.
  quota_reset_date?: string
  quota_snapshots?: Snapshots
}

export function premium(input: Payload) {
  const snap = input.quota_snapshots?.premium_interactions
  if (!snap) return
  const remaining = typeof snap.remaining === "number" ? snap.remaining : undefined
  const total = typeof snap.entitlement === "number" ? snap.entitlement : undefined
  if (remaining === undefined || total === undefined) return
  const used = Math.max(total - remaining, 0)
  const unlimited = snap.unlimited === true
  const pct =
    typeof snap.percent_remaining === "number"
      ? snap.percent_remaining > 1 // Rust expresses as 0-100; TS historically used 0-1
        ? snap.percent_remaining / 100
        : snap.percent_remaining
      : total === 0
        ? 0
        : remaining / total
  return {
    used,
    total,
    remaining,
    percent: pct,
    unlimited,
  } satisfies Premium
}

export function parse(input: Payload): Quota {
  const login = typeof input.login === "string" ? input.login : typeof input.user_login === "string" ? input.user_login : undefined
  return {
    login,
    plan: typeof input.copilot_plan === "string" ? input.copilot_plan : undefined,
    sku: typeof input.access_type_sku === "string" ? input.access_type_sku : undefined,
    api: typeof input.endpoints?.api === "string" ? input.endpoints.api : undefined,
    premium: premium(input),
    resetDate: typeof input.quota_reset_date === "string" ? input.quota_reset_date : undefined,
  }
}

export async function fetchQuota(token: string, enterpriseUrl?: string, proxy?: { url?: string; token?: string }) {
  const target = proxy?.url
    ? new URL("/copilot_internal/user", proxy.url).href
    : "https://api.github.com/copilot_internal/user"
  // Route through the shared HTTP client so corporate CA bundles + the
  // unified timeout policy apply; keep the caller-facing error surface
  // (plain `Error("Failed to fetch quota: <status>")`) for existing tests.
  const res = await HttpClient.request(target, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": `opencode/${InstallationVersion}`,
      ...(enterpriseUrl ? { "X-GitHub-Enterprise-Host": enterpriseUrl } : {}),
      ...(proxy?.token ? { "x-copilot-proxy-token": proxy.token } : {}),
    },
    retry: false,
    throwOnError: false,
    timeoutMs: 10_000,
  })
  if (!res.ok) throw new Error(`Failed to fetch quota: ${res.status}`)
  return parse((await res.json()) as Payload)
}

export function formatQuotaBar(input: Premium, resetDate?: string) {
  const width = 10
  const filled = Math.max(0, Math.min(width, Math.round(input.percent * width)))
  const bar = `${"#".repeat(filled)}${"-".repeat(width - filled)}`
  const pct = Math.round(input.percent * 100)
  const tail = resetDate ? ` reset ${resetDate}` : ""
  return `[${bar}] ${input.remaining}/${input.total} ${pct}%${tail}`
}

export function classifyPlan(input: Pick<Quota, "plan" | "sku">) {
  const text = `${input.sku ?? ""} ${input.plan ?? ""}`.toLowerCase()
  if (!text.trim()) return "unknown"
  if (text.includes("edu")) return "edu"
  if (text.includes("enterprise")) return "enterprise"
  if (text.includes("business")) return "business"
  if (text.includes("team")) return "team"
  if (text.includes("individual")) return "individual"
  if (text.includes("free")) return "free"
  return "unknown"
}
