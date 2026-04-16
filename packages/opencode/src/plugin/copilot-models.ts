import { Installation } from "@/installation"

const COPILOT_CLIENT_VERSION = "1.0.14"

/**
 * Known model info with premium multipliers (fallback when API unavailable).
 * Matches codex_git's COPILOT_MODELS constant.
 */
export const KNOWN_COPILOT_MODELS: CopilotModelInfo[] = [
  {
    id: "gpt-5.4",
    displayName: "GPT-5.4",
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    premiumMultiplier: 1.0,
    family: "gpt",
  },
  {
    id: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    supportsReasoning: true,
    premiumMultiplier: 1.0,
    family: "gpt",
  },
  {
    id: "claude-opus-4.6",
    displayName: "Claude Opus 4.6",
    contextWindow: 144_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    premiumMultiplier: 3.0,
    family: "claude",
  },
  {
    id: "gemini-3.1-pro-preview",
    displayName: "Gemini 3.1 Pro Preview",
    contextWindow: 128_000,
    maxOutputTokens: 64_000,
    supportsReasoning: true,
    premiumMultiplier: 1.0,
    family: "gemini",
  },
]

export interface CopilotModelInfo {
  id: string
  displayName: string
  contextWindow: number
  maxOutputTokens: number
  supportsReasoning: boolean
  premiumMultiplier: number
  family: string
  /** Model capabilities from API */
  capabilities?: {
    vision?: boolean
    tools?: boolean
    streaming?: boolean
  }
  /** Plan restrictions from API (e.g. ["copilot_enterprise_seat"]) */
  restrictedTo?: string[]
}

export interface CopilotModelCatalog {
  models: CopilotModelInfo[]
  fetchedAt: number
}

/**
 * Infer model family from model ID.
 */
function inferFamily(modelId: string): string {
  if (modelId.startsWith("claude-")) return "claude"
  if (modelId.startsWith("gpt-")) return "gpt"
  if (modelId.startsWith("o1-") || modelId.startsWith("o3-") || modelId.startsWith("o4-")) return "gpt"
  if (modelId.startsWith("gemini-")) return "gemini"
  return "other"
}

/**
 * Fetch the model catalog from the Copilot API.
 * Uses the same headers as the official Copilot CLI.
 */
export async function fetchModelCatalog(token: string, apiBaseUrl?: string): Promise<CopilotModelCatalog> {
  const baseUrl = apiBaseUrl || "https://api.individual.githubcopilot.com"
  const url = `${baseUrl}/models?client_version=${COPILOT_CLIENT_VERSION}`

  const term = process.env.TERM_PROGRAM || "unknown"
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Copilot-Integration-Id": "copilot-developer-cli",
      "Openai-Intent": "conversation-agent",
      "X-GitHub-Api-Version": "2026-01-09",
      "User-Agent": `copilot/${COPILOT_CLIENT_VERSION} (client/github/cli ${process.platform} ${process.version}) term/${term}`,
      Accept: "application/json",
    },
  })

  if (!resp.ok) {
    throw new Error(`Copilot models API returned ${resp.status}`)
  }

  const data = (await resp.json()) as { data?: any[] }
  const models: CopilotModelInfo[] = (data.data || []).map((m: any) => ({
    id: m.id || m.name || "",
    displayName: m.name || m.id || "",
    contextWindow: m.capabilities?.limits?.max_context_window_tokens || m.max_context_window_tokens || 128_000,
    maxOutputTokens: m.capabilities?.limits?.max_output_tokens || m.max_output_tokens || 16_384,
    supportsReasoning: m.capabilities?.supports?.reasoning ?? false,
    premiumMultiplier: m.premium_request_multiplier ?? 1.0,
    family: inferFamily(m.id || m.name || ""),
    capabilities: {
      vision: m.capabilities?.supports?.vision ?? false,
      tools: m.capabilities?.supports?.tool_calls ?? true,
      streaming: true,
    },
    restrictedTo: m.restricted_to || [],
  }))

  return { models, fetchedAt: Date.now() }
}

/**
 * Fetch model catalog with plan-based filtering.
 * First queries /copilot_internal/user to get the plan SKU,
 * then filters models that are restricted to plans the account doesn't have.
 */
export async function fetchModelCatalogWithDiscovery(
  oauthToken: string,
): Promise<{ catalog: CopilotModelCatalog; apiBaseUrl?: string; planSku?: string }> {
  // Step 1: Get plan info and dynamic API base
  let planSku: string | undefined
  let apiBaseUrl: string | undefined

  try {
    const resp = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${oauthToken}`,
        Accept: "application/json",
        "User-Agent": `opencode/${Installation.VERSION}`,
      },
    })
    if (resp.ok) {
      const data = (await resp.json()) as any
      planSku = data.access_type_sku
      apiBaseUrl = data.endpoints?.api?.replace(/\/$/, "")
    }
  } catch {}

  // Step 2: Fetch models
  const catalog = await fetchModelCatalog(oauthToken, apiBaseUrl)

  // Step 3: Filter by plan if we have SKU info
  if (planSku) {
    catalog.models = catalog.models.filter((m) => {
      if (!m.restrictedTo || m.restrictedTo.length === 0) return true
      return m.restrictedTo.includes(planSku!)
    })
  }

  return { catalog, apiBaseUrl, planSku }
}

/**
 * Get the best available model from a specific family.
 * Prefers models with:
 * 1. Reasoning support
 * 2. Largest context window
 * 3. Lowest premium multiplier (cost efficiency)
 */
export function getBestModelByFamily(
  catalog: CopilotModelCatalog,
  family: string,
): CopilotModelInfo | undefined {
  const familyModels = catalog.models.filter((m) => m.family === family)
  if (familyModels.length === 0) return undefined

  return familyModels.sort((a, b) => {
    // Prefer reasoning support
    if (a.supportsReasoning !== b.supportsReasoning) return a.supportsReasoning ? -1 : 1
    // Prefer larger context
    if (a.contextWindow !== b.contextWindow) return b.contextWindow - a.contextWindow
    // Prefer lower cost
    return a.premiumMultiplier - b.premiumMultiplier
  })[0]
}

/**
 * Get the overall best model (lowest multiplier with reasoning).
 */
export function getBestOverallModel(catalog: CopilotModelCatalog): CopilotModelInfo | undefined {
  const withReasoning = catalog.models.filter((m) => m.supportsReasoning)
  if (withReasoning.length === 0) return catalog.models[0]

  return withReasoning.sort((a, b) => {
    // Prefer 1x multiplier models
    if (a.premiumMultiplier !== b.premiumMultiplier) return a.premiumMultiplier - b.premiumMultiplier
    // Then largest context
    return b.contextWindow - a.contextWindow
  })[0]
}

// Cache for model catalog (refresh every 30 minutes)
let cachedCatalog: { catalog: CopilotModelCatalog; apiBaseUrl?: string } | undefined
const CACHE_TTL_MS = 30 * 60 * 1000

export async function getCachedModelCatalog(
  oauthToken: string,
): Promise<{ catalog: CopilotModelCatalog; apiBaseUrl?: string }> {
  const now = Date.now()
  if (cachedCatalog && now - cachedCatalog.catalog.fetchedAt < CACHE_TTL_MS) {
    return cachedCatalog
  }

  try {
    const result = await fetchModelCatalogWithDiscovery(oauthToken)
    cachedCatalog = { catalog: result.catalog, apiBaseUrl: result.apiBaseUrl }
    return cachedCatalog
  } catch {
    // Return cached if available, otherwise use known models
    if (cachedCatalog) return cachedCatalog
    return {
      catalog: { models: KNOWN_COPILOT_MODELS, fetchedAt: now },
    }
  }
}
