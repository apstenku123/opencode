import { z } from "zod"
import type { Model } from "@opencode-ai/sdk/v2"
import { HttpClient } from "@/http/client"

export namespace CopilotModels {
  export const schema = z.object({
    data: z.array(
      z.object({
        model_picker_enabled: z.boolean(),
        id: z.string(),
        name: z.string(),
        // every version looks like: `{model.id}-YYYY-MM-DD`
        version: z.string(),
        // Vendor name (e.g. "OpenAI", "Anthropic", "Google", "Azure OpenAI", "xAI").
        vendor: z.string().optional(),
        supported_endpoints: z.array(z.string()).optional(),
        billing: z
          .object({
            restricted_to: z.array(z.string()).optional(),
            multiplier: z.number().optional(),
          })
          .optional(),
        capabilities: z.object({
          family: z.string(),
          limits: z.object({
            max_context_window_tokens: z.number(),
            max_output_tokens: z.number(),
            max_prompt_tokens: z.number(),
            vision: z
              .object({
                max_prompt_image_size: z.number(),
                max_prompt_images: z.number(),
                supported_media_types: z.array(z.string()),
              })
              .optional(),
          }),
          supports: z.object({
            adaptive_thinking: z.boolean().optional(),
            max_thinking_budget: z.number().optional(),
            min_thinking_budget: z.number().optional(),
            reasoning_effort: z.array(z.string()).optional(),
            streaming: z.boolean(),
            structured_outputs: z.boolean().optional(),
            tool_calls: z.boolean(),
            vision: z.boolean().optional(),
          }),
        }),
      }),
    ),
  })

  type Item = z.infer<typeof schema>["data"][number]

  /**
   * Bundled fallback catalog — mirrors Rust `COPILOT_MODELS` in
   * `github-copilot/src/lib.rs:53-99`. Used to canonicalize/recognize
   * known Copilot model IDs when `/models` cannot be reached.
   */
  export const BUNDLED: Array<{
    id: string
    display_name: string
    context_window: number
    max_output_tokens: number
    supports_reasoning: boolean
    premium_multiplier: number
  }> = [
    {
      id: "gpt-5.4",
      display_name: "GPT-5.4",
      context_window: 272_000,
      max_output_tokens: 128_000,
      supports_reasoning: true,
      premium_multiplier: 1.0,
    },
    {
      id: "gpt-5.3-codex",
      display_name: "GPT-5.3 Codex",
      context_window: 272_000,
      max_output_tokens: 128_000,
      supports_reasoning: true,
      premium_multiplier: 1.0,
    },
    {
      id: "claude-opus-4.6",
      display_name: "Claude Opus 4.6",
      context_window: 144_000,
      max_output_tokens: 64_000,
      supports_reasoning: true,
      premium_multiplier: 3.0,
    },
    {
      id: "gemini-3.1-pro-preview",
      display_name: "Gemini 3.1 Pro Preview",
      context_window: 128_000,
      max_output_tokens: 64_000,
      supports_reasoning: true,
      premium_multiplier: 1.0,
    },
  ]

  /**
   * Normalize Copilot model ID (mirrors Rust `canonicalize_copilot_model_id`
   * in `github-copilot/src/lib.rs:101-116`). Returns `undefined` when the
   * raw ID contains characters that aren't valid for Copilot model slugs.
   */
  export function canonicalize(modelId: string): string | undefined {
    const trimmed = modelId.trim()
    if (!trimmed) return undefined
    const canonical = trimmed === "gemini-3-pro-preview" ? "gemini-3.1-pro-preview" : trimmed
    const valid = /^[a-z0-9\-._]+$/.test(canonical)
    return valid ? canonical : undefined
  }

  /**
   * Pick the highest-capability model per vendor from a /models catalog.
   * Mirrors Rust `CopilotModelCatalog::best_per_vendor` in
   * `github-copilot/src/models.rs:92-161`.
   *
   * Ranking within a vendor (highest wins):
   *   1. reasoning support (true > false)
   *   2. context window (larger)
   *   3. max output tokens (larger)
   *   4. lexical id (later string-sorts wins as a stable tiebreaker, so
   *      `gpt-5.4 > gpt-5.3`)
   *
   * Vendors are bucketed by:
   *   - "OpenAI" / "Azure OpenAI" → "OpenAI"
   *   - "Anthropic" → "Anthropic"
   *   - "Google" → "Google"
   *   - everything else (xAI etc) → skipped
   *
   * Output preserves a stable display order: OpenAI, Anthropic, Google.
   * Embeddings, legacy `gpt-3.5`, `gpt-4o-mini`, `goldeneye`, and any
   * `-mini` / `-nano` / `-fast` slug variants are excluded.
   */
  export type BestVendor = { vendor: string; modelId: string }

  type Capabilityish = {
    id: string
    vendor?: string
    family?: string
    capabilities?: { supports?: { reasoning_effort?: string[]; adaptive_thinking?: boolean } }
    capabilities_reasoning?: boolean
    limits?: { max_context_window_tokens?: number; max_output_tokens?: number }
  }

  function vendorBucket(input: Capabilityish): "OpenAI" | "Anthropic" | "Google" | undefined {
    const text = `${input.vendor ?? ""} ${input.family ?? ""} ${input.id}`.toLowerCase()
    if (text.includes("anthropic") || text.includes("claude")) return "Anthropic"
    if (text.includes("google") || text.includes("gemini")) return "Google"
    if (text.includes("openai") || text.includes("azure") || text.includes("gpt")) return "OpenAI"
    return undefined
  }

  function reasoningOrdinal(input: Capabilityish): number {
    if (input.capabilities_reasoning) return 1
    const sup = input.capabilities?.supports
    if (sup?.adaptive_thinking) return 1
    if (sup?.reasoning_effort && sup.reasoning_effort.length > 0) return 1
    return 0
  }

  function isExcluded(id: string): boolean {
    const lower = id.toLowerCase()
    return (
      lower.includes("embedding") ||
      lower.includes("gpt-3.5") ||
      lower.includes("gpt-4o-mini") ||
      lower.includes("goldeneye") ||
      lower.includes("-mini") ||
      lower.includes("-nano") ||
      lower.includes("-fast")
    )
  }

  export function bestPerVendor(items: Capabilityish[]): BestVendor[] {
    const byVendor = new Map<string, Capabilityish>()
    for (const m of items) {
      if (isExcluded(m.id)) continue
      const vendor = vendorBucket(m)
      if (!vendor) continue
      const cur = byVendor.get(vendor)
      if (!cur) {
        byVendor.set(vendor, m)
        continue
      }
      const mr = reasoningOrdinal(m)
      const cr = reasoningOrdinal(cur)
      if (mr !== cr) {
        if (mr > cr) byVendor.set(vendor, m)
        continue
      }
      const mc = m.limits?.max_context_window_tokens ?? 0
      const cc = cur.limits?.max_context_window_tokens ?? 0
      if (mc !== cc) {
        if (mc > cc) byVendor.set(vendor, m)
        continue
      }
      const mo = m.limits?.max_output_tokens ?? 0
      const co = cur.limits?.max_output_tokens ?? 0
      if (mo !== co) {
        if (mo > co) byVendor.set(vendor, m)
        continue
      }
      // Final tiebreaker: lexical id descending (gpt-5.4 wins over gpt-5.3).
      if (m.id > cur.id) byVendor.set(vendor, m)
    }
    const order = (v: string) => (v === "OpenAI" ? 0 : v === "Anthropic" ? 1 : v === "Google" ? 2 : 3)
    return [...byVendor.entries()]
      .sort(([a], [b]) => order(a) - order(b))
      .map(([vendor, m]) => ({ vendor, modelId: m.id }))
  }

  /**
   * Adapter: derive `Capabilityish` records from a `Record<string, Model>`
   * (the shape produced by `CopilotModels.get`). Lets `bestPerVendor` run
   * over the same model catalog the runtime/dispatch layer sees.
   */
  export function bestPerVendorFromModels(
    models: Record<string, { api: { id: string }; family?: string; limit?: { context: number; output: number }; capabilities?: { reasoning?: boolean } }>,
  ): BestVendor[] {
    const items: Capabilityish[] = Object.values(models).map((m) => ({
      id: m.api.id,
      family: m.family,
      capabilities_reasoning: !!m.capabilities?.reasoning,
      limits: {
        max_context_window_tokens: m.limit?.context,
        max_output_tokens: m.limit?.output,
      },
    }))
    return bestPerVendor(items)
  }

  /**
   * Drop any model whose `billing.restricted_to` plan list excludes `plan`.
   * Empty/missing `restricted_to` means the model is unrestricted.
   * Pass an empty/unknown plan to skip filtering (mirrors Rust
   * `CopilotModelCatalog::retain_for_plan` in `models.rs:174-180`).
   */
  export function retainForPlan(items: Item[], plan: string | undefined): Item[] {
    if (!plan) return items
    if (plan === "unknown" || plan === "no_sku_field") return items
    return items.filter((m) => {
      const restricted = m.billing?.restricted_to ?? []
      if (restricted.length === 0) return true
      return restricted.includes(plan)
    })
  }

  function build(key: string, remote: Item, url: string, prev?: Model): Model {
    const reasoning =
      !!remote.capabilities.supports.adaptive_thinking ||
      !!remote.capabilities.supports.reasoning_effort?.length ||
      remote.capabilities.supports.max_thinking_budget !== undefined ||
      remote.capabilities.supports.min_thinking_budget !== undefined
    const image =
      (remote.capabilities.supports.vision ?? false) ||
      (remote.capabilities.limits.vision?.supported_media_types ?? []).some((item) => item.startsWith("image/"))

    const isMsgApi = remote.supported_endpoints?.includes("/v1/messages")

    return {
      id: key,
      providerID: "github-copilot",
      api: {
        id: remote.id,
        url: isMsgApi ? `${url}/v1` : url,
        npm: isMsgApi ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot",
      },
      // API response wins
      status: "active",
      limit: {
        context: remote.capabilities.limits.max_context_window_tokens,
        input: remote.capabilities.limits.max_prompt_tokens,
        output: remote.capabilities.limits.max_output_tokens,
      },
      capabilities: {
        temperature: prev?.capabilities.temperature ?? true,
        reasoning: prev?.capabilities.reasoning ?? reasoning,
        attachment: prev?.capabilities.attachment ?? true,
        toolcall: remote.capabilities.supports.tool_calls,
        input: {
          text: true,
          audio: false,
          image,
          video: false,
          pdf: false,
        },
        output: {
          text: true,
          audio: false,
          image: false,
          video: false,
          pdf: false,
        },
        interleaved: false,
      },
      // existing wins
      family: prev?.family ?? remote.capabilities.family,
      name: prev?.name ?? remote.name,
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      },
      options: prev?.options ?? {},
      headers: prev?.headers ?? {},
      release_date:
        prev?.release_date ??
        (remote.version.startsWith(`${remote.id}-`) ? remote.version.slice(remote.id.length + 1) : remote.version),
      variants: prev?.variants ?? {},
    }
  }

  export async function get(
    baseURL: string,
    headers: HeadersInit = {},
    existing: Record<string, Model> = {},
    proxyUrl?: string,
    plan?: string,
  ): Promise<Record<string, Model>> {
    const target = proxyUrl ? new URL("/models", proxyUrl).href : `${baseURL}/models`
    // Shared HTTP client: picks up NODE_EXTRA_CA_CERTS automatically and
    // applies the unified timeout; we intentionally disable retry here
    // since the caller (`aliasModels`) already has a fallback catalog.
    const res = await HttpClient.request(target, {
      headers,
      retry: false,
      throwOnError: false,
      timeoutMs: 5_000,
    })
    if (!res.ok) {
      throw new Error(`Failed to fetch models: ${res.status}`)
    }
    const data = schema.parse(await res.json())

    const result = { ...existing }
    const gated = retainForPlan(data.data, plan)
    const remote = new Map(gated.filter((m) => m.model_picker_enabled).map((m) => [m.id, m] as const))

    // prune existing models whose api.id isn't in the endpoint response
    for (const [key, model] of Object.entries(result)) {
      const m = remote.get(model.api.id)
      if (!m) {
        delete result[key]
        continue
      }
      result[key] = build(key, m, baseURL, model)
    }

    // add new endpoint models not already keyed in result
    for (const [id, m] of remote) {
      if (id in result) continue
      result[id] = build(id, m, baseURL)
    }

    return result
  }
}
