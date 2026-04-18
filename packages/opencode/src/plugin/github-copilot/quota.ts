import { InstallationVersion } from "@/installation/version"
import { HttpClient } from "@/http/client"

export type Premium = {
  used: number
  total: number
  remaining: number
  percent: number
}

export type Quota = {
  login?: string
  plan?: string
  sku?: string
  api?: string
  premium?: Premium
  resetDate?: string
}

type Snap = {
  quota_id?: string
  remaining?: number
  total?: number
  percent_remaining?: number
  reset_date?: string
}

type Payload = {
  user_login?: string
  copilot_plan?: string
  access_type_sku?: string
  endpoints?: { api?: string }
  entitlements?: { premium_requests?: number }
  quota_snapshots?: Snap[]
}

export function premium(input: Payload) {
  const total = input.entitlements?.premium_requests
  const snap = input.quota_snapshots?.find((item) => item.quota_id === "premium_requests")
  if (!snap) return
  if (typeof total !== "number") return
  if (typeof snap.remaining !== "number") return
  const remaining = snap.remaining
  const used = Math.max(total - remaining, 0)
  return {
    used,
    total,
    remaining,
    percent: typeof snap.percent_remaining === "number" ? snap.percent_remaining : total === 0 ? 0 : remaining / total,
  } satisfies Premium
}

export function parse(input: Payload): Quota {
  return {
    login: typeof input.user_login === "string" ? input.user_login : undefined,
    plan: typeof input.copilot_plan === "string" ? input.copilot_plan : undefined,
    sku: typeof input.access_type_sku === "string" ? input.access_type_sku : undefined,
    api: typeof input.endpoints?.api === "string" ? input.endpoints.api : undefined,
    premium: premium(input),
    resetDate: input.quota_snapshots?.find((item) => item.quota_id === "premium_requests")?.reset_date,
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
