import { z } from "zod"
import type { Model } from "@opencode-ai/sdk/v2"

export namespace CopilotModels {
  export const schema = z.object({
    data: z.array(
      z.object({
        model_picker_enabled: z.boolean(),
        id: z.string(),
        name: z.string(),
        // every version looks like: `{model.id}-YYYY-MM-DD`
        version: z.string(),
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
    const data = await fetch(target, {
      headers,
      signal: AbortSignal.timeout(5_000),
    }).then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed to fetch models: ${res.status}`)
      }
      return schema.parse(await res.json())
    })

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
