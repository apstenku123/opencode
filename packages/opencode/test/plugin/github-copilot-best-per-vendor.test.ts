import { describe, expect, test } from "bun:test"
import { CopilotModels } from "@/plugin/github-copilot/models"

describe("CopilotModels.bestPerVendor", () => {
  test("returns highest-context model per vendor in stable display order", () => {
    const got = CopilotModels.bestPerVendor([
      { id: "gpt-5.4", vendor: "OpenAI", limits: { max_context_window_tokens: 272000, max_output_tokens: 128000 } },
      { id: "gpt-5.3", vendor: "OpenAI", limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 } },
      { id: "claude-opus-4.6", vendor: "Anthropic", limits: { max_context_window_tokens: 144000, max_output_tokens: 64000 } },
      { id: "claude-sonnet-4.0", vendor: "Anthropic", limits: { max_context_window_tokens: 200000, max_output_tokens: 32000 } },
      { id: "gemini-3.1-pro-preview", vendor: "Google", limits: { max_context_window_tokens: 128000, max_output_tokens: 64000 } },
    ])
    expect(got.map((b) => b.vendor)).toEqual(["OpenAI", "Anthropic", "Google"])
    expect(got[0].modelId).toBe("gpt-5.4")
    // Anthropic: claude-sonnet-4.0 has bigger context (200k > 144k) so it
    // wins this tier even though opus has the higher reasoning slot.
    expect(got[1].modelId).toBe("claude-sonnet-4.0")
    expect(got[2].modelId).toBe("gemini-3.1-pro-preview")
  })

  test("excludes embedding / mini / nano / fast / legacy models", () => {
    const got = CopilotModels.bestPerVendor([
      { id: "gpt-5-mini", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
      { id: "gpt-5-nano", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
      { id: "gpt-5-fast", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
      { id: "gpt-3.5-turbo", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
      { id: "gpt-4o-mini", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
      { id: "text-embedding-3-large", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
      { id: "goldeneye-foo", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
    ])
    expect(got).toEqual([])
  })

  test("skips xAI and other non-bucketed vendors", () => {
    const got = CopilotModels.bestPerVendor([
      { id: "grok-3", vendor: "xAI", limits: { max_context_window_tokens: 200000, max_output_tokens: 64000 } },
      { id: "deepseek-v3", vendor: "DeepSeek", limits: { max_context_window_tokens: 100000, max_output_tokens: 32000 } },
    ])
    expect(got).toEqual([])
  })

  test("Azure OpenAI vendor is bucketed under OpenAI", () => {
    const got = CopilotModels.bestPerVendor([
      { id: "gpt-5.4", vendor: "Azure OpenAI", limits: { max_context_window_tokens: 272000, max_output_tokens: 128000 } },
    ])
    expect(got[0].vendor).toBe("OpenAI")
    expect(got[0].modelId).toBe("gpt-5.4")
  })

  test("falls back to id-based bucketing when vendor field is missing", () => {
    const got = CopilotModels.bestPerVendor([
      { id: "gpt-5.4", limits: { max_context_window_tokens: 272000, max_output_tokens: 128000 } },
      { id: "claude-opus-4.6", limits: { max_context_window_tokens: 144000, max_output_tokens: 64000 } },
      { id: "gemini-3.1-pro-preview", limits: { max_context_window_tokens: 128000, max_output_tokens: 64000 } },
    ])
    expect(got.map((b) => b.vendor)).toEqual(["OpenAI", "Anthropic", "Google"])
  })

  test("reasoning-capable models beat non-reasoning siblings within a vendor", () => {
    const got = CopilotModels.bestPerVendor([
      {
        id: "gpt-5.0",
        vendor: "OpenAI",
        limits: { max_context_window_tokens: 1_000_000, max_output_tokens: 1_000_000 },
      },
      {
        id: "gpt-5.4",
        vendor: "OpenAI",
        capabilities_reasoning: true,
        limits: { max_context_window_tokens: 100_000, max_output_tokens: 100_000 },
      },
    ])
    expect(got[0].modelId).toBe("gpt-5.4")
  })

  test("lexical id wins as final tiebreaker", () => {
    const got = CopilotModels.bestPerVendor([
      { id: "gpt-5.3", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
      { id: "gpt-5.4", vendor: "OpenAI", limits: { max_context_window_tokens: 100, max_output_tokens: 100 } },
    ])
    expect(got[0].modelId).toBe("gpt-5.4")
  })
})

describe("CopilotModels.bestPerVendorFromModels (Model record adapter)", () => {
  test("derives capabilityish records from Model objects", () => {
    const got = CopilotModels.bestPerVendorFromModels({
      "gpt-5.4": {
        api: { id: "gpt-5.4" },
        family: "gpt",
        limit: { context: 272000, output: 128000 },
        capabilities: { reasoning: true },
      },
      "claude-opus": {
        api: { id: "claude-opus-4.6" },
        family: "claude",
        limit: { context: 144000, output: 64000 },
        capabilities: { reasoning: true },
      },
    })
    expect(got).toEqual([
      { vendor: "OpenAI", modelId: "gpt-5.4" },
      { vendor: "Anthropic", modelId: "claude-opus-4.6" },
    ])
  })
})
