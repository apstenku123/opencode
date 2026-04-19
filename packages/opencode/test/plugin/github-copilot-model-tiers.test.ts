import { describe, expect, test } from "bun:test"
import {
  bestTierForAccount,
  classifyModel,
  shouldPreferSecondarySubagentAccounts,
  topTierModels,
} from "@/plugin/github-copilot/model-tiers"

describe("model-tiers.classifyModel", () => {
  // Top tier — mirrors codex-rs/core/src/model_tiers.rs tests
  test("classifies gpt-5.4 as Top", () => {
    expect(classifyModel("gpt-5.4")).toBe("Top")
  })
  test("classifies claude-opus-4.6 as Top", () => {
    expect(classifyModel("claude-opus-4.6")).toBe("Top")
  })
  test("classifies claude-sonnet-4 as Top", () => {
    expect(classifyModel("claude-sonnet-4")).toBe("Top")
  })
  test("classifies gemini-2.5-pro as Top", () => {
    expect(classifyModel("gemini-2.5-pro")).toBe("Top")
  })
  test("classifies gemini-3.1-pro-preview as Top", () => {
    expect(classifyModel("gemini-3.1-pro-preview")).toBe("Top")
  })

  // Secondary tier
  test("classifies gpt-5.3-codex as Secondary", () => {
    expect(classifyModel("gpt-5.3-codex")).toBe("Secondary")
  })
  test("classifies gpt-5.2-codex as Secondary", () => {
    expect(classifyModel("gpt-5.2-codex")).toBe("Secondary")
  })
  test("classifies gpt-5.1 as Secondary", () => {
    expect(classifyModel("gpt-5.1")).toBe("Secondary")
  })
  test("classifies gpt-5-codex as Secondary", () => {
    expect(classifyModel("gpt-5-codex")).toBe("Secondary")
  })
  test("classifies gpt-5-mini as Secondary", () => {
    expect(classifyModel("gpt-5-mini")).toBe("Secondary")
  })
  test("classifies bare gpt-5 as Secondary", () => {
    expect(classifyModel("gpt-5")).toBe("Secondary")
  })
  test("classifies claude-haiku-3.5 as Secondary", () => {
    expect(classifyModel("claude-haiku-3.5")).toBe("Secondary")
  })
  test("classifies gemini-2-pro-preview as Secondary", () => {
    expect(classifyModel("gemini-2-pro-preview")).toBe("Secondary")
  })
  test("classifies gpt-oss-120b as Secondary", () => {
    expect(classifyModel("gpt-oss-120b")).toBe("Secondary")
  })
  test("classifies gpt-oss-20b as Secondary", () => {
    expect(classifyModel("gpt-oss-20b")).toBe("Secondary")
  })

  // Unknown tier
  test("classifies empty slug as Unknown", () => {
    expect(classifyModel("")).toBe("Unknown")
  })
  test("classifies arbitrary slug as Unknown", () => {
    expect(classifyModel("llama-3-70b")).toBe("Unknown")
    expect(classifyModel("mistral-large")).toBe("Unknown")
  })
})

describe("model-tiers.bestTierForAccount", () => {
  test("returns Top when mixed tiers present", () => {
    expect(bestTierForAccount(["gpt-5.3-codex", "gpt-5.4", "gpt-oss-20b"])).toBe("Top")
  })

  test("returns Secondary when no Top present", () => {
    expect(bestTierForAccount(["gpt-5.2-codex", "gpt-5.1"])).toBe("Secondary")
  })

  test("returns Unknown for empty list", () => {
    expect(bestTierForAccount([])).toBe("Unknown")
  })

  test("returns Unknown when all Unknown", () => {
    expect(bestTierForAccount(["llama-3-70b", "mistral-large"])).toBe("Unknown")
  })
})

describe("model-tiers.topTierModels", () => {
  test("filters to Top-tier slugs only", () => {
    expect(
      topTierModels([
        "gpt-5.4",
        "gpt-5.3-codex",
        "claude-opus-4.6",
        "gemini-3.1-pro-preview",
        "gpt-oss-20b",
      ]),
    ).toEqual(["gpt-5.4", "claude-opus-4.6", "gemini-3.1-pro-preview"])
  })

  test("returns empty when no Top-tier slugs", () => {
    expect(topTierModels(["gpt-5.3-codex", "gpt-5.1"])).toEqual([])
  })
})

describe("model-tiers.shouldPreferSecondarySubagentAccounts", () => {
  // Mirrors codex-rs/core/src/thread_manager_fork.rs secondary_account_routing_tests.
  test("prefers secondary for explicit secondary sub-agent model diverging from parent", () => {
    expect(shouldPreferSecondarySubagentAccounts("gpt-5.3-codex", "gpt-5.4")).toBe(true)
  })

  test("keeps inherited main model on default account routing", () => {
    expect(shouldPreferSecondarySubagentAccounts("gpt-5.3-codex", "gpt-5.3-codex")).toBe(false)
  })

  test("keeps top-tier sub-agent models on default account routing", () => {
    expect(shouldPreferSecondarySubagentAccounts("claude-opus-4.6", "gpt-5.4")).toBe(false)
  })

  test("falls back to default routing without a parent-model intent", () => {
    expect(shouldPreferSecondarySubagentAccounts("gpt-5.3-codex", null)).toBe(false)
    expect(shouldPreferSecondarySubagentAccounts("gpt-5.3-codex", undefined)).toBe(false)
    expect(shouldPreferSecondarySubagentAccounts("gpt-5.3-codex", "")).toBe(false)
  })

  test("returns false when requested model is missing", () => {
    expect(shouldPreferSecondarySubagentAccounts(null, "gpt-5.4")).toBe(false)
    expect(shouldPreferSecondarySubagentAccounts("", "gpt-5.4")).toBe(false)
  })

  test("unknown-tier requested model is never preferred-secondary", () => {
    expect(shouldPreferSecondarySubagentAccounts("llama-3-70b", "gpt-5.4")).toBe(false)
  })
})
