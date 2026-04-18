import { afterEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_POOL_RULES,
  DEFAULT_XHIGH_ONLY,
  allowedModels,
  extractPoolConfig,
  gateModel,
  poolFor,
  poolForAccount,
} from "@/plugin/github-copilot/pool-routing"
import {
  getPoolRoutingConfig,
  policyPlan,
  preferPlan,
  resolveAccountPool,
  setPoolRoutingConfig,
} from "@/plugin/github-copilot/copilot"
import type { State } from "@/plugin/github-copilot/connections"
import type { CopilotAuth } from "@/plugin/github-copilot/auth"

afterEach(() => {
  // Reset module-level config so tests don't bleed state between cases.
  setPoolRoutingConfig(undefined)
})

describe("pool-routing defaults", () => {
  test("DEFAULT_POOL_RULES encodes codex edu + gpt/claude prod", () => {
    expect(DEFAULT_POOL_RULES["codex-5.3"]).toBe("edu")
    expect(DEFAULT_POOL_RULES["codex-5.3-xhigh"]).toBe("edu")
    expect(DEFAULT_POOL_RULES["gpt-5.4"]).toBe("prod")
    expect(DEFAULT_POOL_RULES["gpt-5.4-xhigh"]).toBe("prod")
    expect(DEFAULT_POOL_RULES["claude-4.7-opus-high"]).toBe("prod")
  })

  test("DEFAULT_XHIGH_ONLY includes gpt-5.4 + codex-5.3", () => {
    expect(DEFAULT_XHIGH_ONLY).toContain("gpt-5.4")
    expect(DEFAULT_XHIGH_ONLY).toContain("codex-5.3")
  })

  test("poolFor returns mapped pool or undefined", () => {
    expect(poolFor("codex-5.3-xhigh")).toBe("edu")
    expect(poolFor("gpt-5.4-xhigh")).toBe("prod")
    expect(poolFor("claude-4.7-opus-high")).toBe("prod")
    expect(poolFor("gpt-5-mini")).toBeUndefined()
    expect(poolFor("")).toBeUndefined()
  })

  test("allowedModels partitions defaults by pool", () => {
    const edu = allowedModels("edu")
    const prod = allowedModels("prod")
    expect(edu).toContain("codex-5.3-xhigh")
    expect(edu).not.toContain("gpt-5.4-xhigh")
    expect(prod).toContain("gpt-5.4-xhigh")
    expect(prod).toContain("claude-4.7-opus-high")
  })
})

describe("pool-routing gateModel", () => {
  test("allows xhigh variants of gated families", () => {
    const r = gateModel("gpt-5.4-xhigh")
    expect(r.allow).toBe(true)
    expect(r.pool).toBe("prod")
    expect(r.reason).toBeUndefined()
  })

  test("rejects bare gpt-5.4 with actionable reason", () => {
    const r = gateModel("gpt-5.4")
    expect(r.allow).toBe(false)
    expect(r.reason).toMatch(/only xhigh variants permitted for gpt-5\.4/i)
  })

  test("rejects non-xhigh variants of codex-5.3 (e.g. codex-5.3-medium)", () => {
    const r = gateModel("codex-5.3-medium")
    expect(r.allow).toBe(false)
    expect(r.reason).toMatch(/only xhigh variants permitted for codex-5\.3/i)
  })

  test("allows bare codex-5.3-xhigh", () => {
    const r = gateModel("codex-5.3-xhigh")
    expect(r.allow).toBe(true)
    expect(r.pool).toBe("edu")
  })

  test("allows unmapped / non-gated models with pool=undefined", () => {
    const r = gateModel("gpt-5-mini")
    expect(r.allow).toBe(true)
    expect(r.pool).toBeUndefined()
  })

  test("xhighOnly override via config replaces defaults", () => {
    const cfg = { xhighOnly: [] }
    const r = gateModel("gpt-5.4", cfg)
    expect(r.allow).toBe(true)
  })
})

describe("pool-routing poolForAccount", () => {
  test("edu plan → edu pool", () => {
    expect(poolForAccount({ key: "github-copilot#edu", plan: "edu" })).toBe("edu")
    expect(poolForAccount({ key: "github-copilot#free", plan: "free" })).toBe("edu")
  })

  test("enterprise / pro / business / team → prod", () => {
    expect(poolForAccount({ key: "k", plan: "enterprise" })).toBe("prod")
    expect(poolForAccount({ key: "k", plan: "pro" })).toBe("prod")
    expect(poolForAccount({ key: "k", plan: "business" })).toBe("prod")
    expect(poolForAccount({ key: "k", plan: "team" })).toBe("prod")
  })

  test("explicit pool membership overrides plan", () => {
    const cfg = { pools: { edu: ["github-copilot#pilot"] } }
    expect(poolForAccount({ key: "github-copilot#pilot", plan: "enterprise", cfg })).toBe("edu")
  })

  test("unknown plan returns undefined", () => {
    expect(poolForAccount({ key: "k", plan: "unknown" })).toBeUndefined()
    expect(poolForAccount({ key: "k" })).toBeUndefined()
  })
})

describe("pool-routing extractPoolConfig", () => {
  test("returns undefined when no copilot config", () => {
    expect(extractPoolConfig(undefined)).toBeUndefined()
    expect(extractPoolConfig({})).toBeUndefined()
  })

  test("parses well-formed config shape", () => {
    const cfg = extractPoolConfig({
      copilot: {
        poolRouting: {
          pools: { edu: ["github-copilot#x"], prod: ["github-copilot#y"] },
          models: { "foo-model": "edu" },
          xhighOnly: ["foo"],
        },
      },
    })
    expect(cfg?.pools?.edu).toEqual(["github-copilot#x"])
    expect(cfg?.models?.["foo-model"]).toBe("edu")
    expect(cfg?.xhighOnly).toEqual(["foo"])
  })
})

describe("copilot.policyPlan delegates to pool-routing", () => {
  test("maps codex-5.3-xhigh to edu pool (new)", () => {
    expect(policyPlan("codex-5.3-xhigh")).toBe("edu")
  })

  test("maps gpt-5.4-xhigh to prod pool (new)", () => {
    expect(policyPlan("gpt-5.4-xhigh")).toBe("prod")
  })

  test("preserves legacy substring behaviour for unmapped models", () => {
    expect(policyPlan("gpt-5-enterprise")).toBe("enterprise")
    expect(policyPlan("gpt-5-business")).toBe("business")
    expect(policyPlan("gpt-4.1-edu")).toBe("edu")
    expect(policyPlan("gpt-5-mini")).toBeUndefined()
  })
})

describe("copilot.preferPlan narrows to pool", () => {
  const auths: CopilotAuth[] = [
    { key: "github-copilot", label: "Primary", refresh: "a", access: "a", expires: 0 },
    { key: "github-copilot#edu", label: "Edu", refresh: "b", access: "b", expires: 0 },
    { key: "github-copilot#enterprise", label: "Ent", refresh: "c", access: "c", expires: 0 },
  ]
  const state: State = {
    version: 1,
    connections: {
      "github-copilot": { plan: "free" },
      "github-copilot#edu": { plan: "edu" },
      "github-copilot#enterprise": { plan: "enterprise" },
    },
  }

  test("codex-5.3-xhigh narrows to edu pool members (edu + free)", () => {
    const picked = preferPlan(state, auths, "codex-5.3-xhigh").map((a) => a.key)
    expect(picked).toContain("github-copilot#edu")
    expect(picked).toContain("github-copilot")
    expect(picked).not.toContain("github-copilot#enterprise")
  })

  test("gpt-5.4-xhigh narrows to prod pool", () => {
    const picked = preferPlan(state, auths, "gpt-5.4-xhigh").map((a) => a.key)
    expect(picked).toEqual(["github-copilot#enterprise"])
  })

  test("legacy substring (gpt-4.1-edu) keeps working", () => {
    const picked = preferPlan(state, auths, "gpt-4.1-edu").map((a) => a.key)
    expect(picked).toEqual(["github-copilot#edu"])
  })

  test("explicit config override: pin primary to edu pool", () => {
    setPoolRoutingConfig({ pools: { edu: ["github-copilot"] } })
    const picked = preferPlan(state, auths, "codex-5.3-xhigh").map((a) => a.key)
    // Primary is now pinned to edu by config; free-plan default also maps to edu.
    expect(picked).toContain("github-copilot")
    expect(picked).toContain("github-copilot#edu")
  })
})

describe("copilot.resolveAccountPool", () => {
  test("derives pool from plan + config", () => {
    const state: State = {
      version: 1,
      connections: {
        "github-copilot#edu": { plan: "edu" },
        "github-copilot#ent": { plan: "enterprise" },
      },
    }
    expect(resolveAccountPool(state, "github-copilot#edu")).toBe("edu")
    expect(resolveAccountPool(state, "github-copilot#ent")).toBe("prod")
  })

  test("config-pinned override wins over plan", () => {
    setPoolRoutingConfig({ pools: { edu: ["github-copilot#ent"] } })
    const state: State = {
      version: 1,
      connections: { "github-copilot#ent": { plan: "enterprise" } },
    }
    expect(resolveAccountPool(state, "github-copilot#ent")).toBe("edu")
  })
})

describe("copilot setPoolRoutingConfig / getPoolRoutingConfig", () => {
  test("round-trips through module-level ref", () => {
    expect(getPoolRoutingConfig()).toBeUndefined()
    setPoolRoutingConfig({ xhighOnly: ["foo"] })
    expect(getPoolRoutingConfig()?.xhighOnly).toEqual(["foo"])
  })
})
