import { describe, expect, test } from "bun:test"
import { SkillEvolutionEngine } from "../../src/skill/evolution"

describe("skill/evolution", () => {
  test("RecordSuccess on a successful feedback", () => {
    const engine = new SkillEvolutionEngine()
    const action = engine.processFeedback({
      skillName: "shell",
      taskQuery: "ls",
      success: true,
      executionTrace: [],
    })
    expect(action.kind).toBe("record_success")
    expect(engine.utilityRate("shell")).toBe(1)
  })

  test("RecordTip on first failure (below min_samples)", () => {
    const engine = new SkillEvolutionEngine()
    const action = engine.processFeedback({
      skillName: "shell",
      taskQuery: "rm -rf /",
      success: false,
      errorSummary: "permission denied",
      executionTrace: [],
    })
    expect(action.kind).toBe("record_tip")
    if (action.kind === "record_tip") {
      expect(action.tip.lesson).toContain("permission denied")
    }
    expect(engine.utilityRate("shell")).toBe(0)
  })

  test("OptimizeSkill once min_samples is reached and utility >= threshold", () => {
    // Custom params so we can drive thresholds in 3 calls.
    const engine = new SkillEvolutionEngine({ utilityThreshold: 0.3, minSamples: 3 })
    engine.processFeedback({ skillName: "grep", taskQuery: "x", success: true, executionTrace: [] })
    engine.processFeedback({ skillName: "grep", taskQuery: "y", success: true, executionTrace: [] })
    const action = engine.processFeedback({
      skillName: "grep",
      taskQuery: "z",
      success: false,
      errorSummary: "no matches",
      executionTrace: ["grep -R foo ."],
    })
    // 2/3 = 0.67 >= 0.3 → optimize
    expect(action.kind).toBe("optimize_skill")
    if (action.kind === "optimize_skill") {
      expect(action.skillName).toBe("grep")
      expect(action.suggestedChanges).toContain("Trace: grep -R foo .")
    }
  })

  test("DiscoverNewSkill when utility falls below threshold", () => {
    const engine = new SkillEvolutionEngine({ utilityThreshold: 0.5, minSamples: 3 })
    // 0/3 utility → below 0.5
    engine.processFeedback({ skillName: "lsp", taskQuery: "a", success: false, errorSummary: "e1", executionTrace: [] })
    engine.processFeedback({ skillName: "lsp", taskQuery: "b", success: false, errorSummary: "e2", executionTrace: [] })
    const action = engine.processFeedback({
      skillName: "lsp",
      taskQuery: "c",
      success: false,
      errorSummary: "third failure",
      executionTrace: [],
    })
    expect(action.kind).toBe("discover_new_skill")
    if (action.kind === "discover_new_skill") {
      expect(action.suggestedNewSkill).toContain("Replacement for lsp")
      expect(action.suggestedNewSkill).toContain("third failure")
    }
  })

  test("save/load round-trip preserves table + tips", () => {
    const engine = new SkillEvolutionEngine({ utilityThreshold: 0.4, minSamples: 2 })
    engine.processFeedback({ skillName: "rg", taskQuery: "x", success: true, executionTrace: [] })
    engine.processFeedback({ skillName: "rg", taskQuery: "y", success: false, errorSummary: "boom", executionTrace: [] })
    const dump = engine.save()
    const restored = SkillEvolutionEngine.load(dump)
    expect(restored.utilityRate("rg")).toBeCloseTo(0.5)
    expect(restored.allTips().length).toBe(1)
    expect(restored.allTips()[0].lesson).toBe("boom")
  })

  test("load is tolerant of garbage JSON", () => {
    const engine = SkillEvolutionEngine.load({ random: "junk" })
    expect(engine.utilityRate("anything")).toBe(0)
    expect(engine.allTips().length).toBe(0)
  })
})
