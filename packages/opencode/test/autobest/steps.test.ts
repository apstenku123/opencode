import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  assistantIgnoredPlan,
  decideEmptyFollowup,
  isStepA,
  isStepB,
  isStepC,
  isStepD,
  runStepB,
  runSteps,
  runStepsEffect,
  shouldSubmit,
  type CompactWindow,
  type CompactWindowReader,
} from "@/autobest/steps"
import type { Candidate, CycleState } from "@/autobest"

const cands = (...keys: string[]): Candidate[] =>
  keys.map((key, i) => ({ key, score: Math.max(1, 100 - i) }))

const window = (input: Partial<CompactWindow> & Pick<CompactWindow, "actionItems">): CompactWindow => ({
  id: input.id ?? 1,
  snippet: input.snippet,
  actionItems: input.actionItems,
  completed: input.completed ?? [],
  planFilePath: input.planFilePath,
})

describe("autobest/steps - Step B plan check", () => {
  test("returns undefined when no compact window provided", () => {
    expect(runStepB(undefined)).toBeUndefined()
  })

  test("flags empty action_items as no-plan", () => {
    const out = runStepB(window({ actionItems: [] }))
    expect(out?.hasPlan).toBe(false)
  })

  test("returns the first unfinished item", () => {
    const out = runStepB(
      window({
        id: 7,
        actionItems: ["- write the test", "- ship the patch"],
        completed: ["- write the test"],
        snippet: "plan...",
      }),
    )
    expect(out?.hasPlan).toBe(true)
    expect(out?.nextItem).toBe("- ship the patch")
    expect(out?.windowID).toBe(7)
    expect(out?.snippet).toBe("plan...")
  })

  test("normalises item formatting when matching completion set", () => {
    const out = runStepB(
      window({
        actionItems: ["1. write the test", "2. ship the patch"],
        // Variation in bullet formatting must still match.
        completed: ["* WRITE the test"],
      }),
    )
    expect(out?.hasPlan).toBe(true)
    expect(out?.nextItem).toBe("2. ship the patch")
  })

  test("reports has_plan with no nextItem when everything is complete", () => {
    const out = runStepB(
      window({
        actionItems: ["- a", "- b"],
        completed: ["- a", "- b"],
      }),
    )
    expect(out?.hasPlan).toBe(true)
    expect(out?.nextItem).toBeUndefined()
  })
})

describe("autobest/steps - decideEmptyFollowup (Step C / D)", () => {
  test("first empty turn dispatches the 'And what's next?' prompt", () => {
    const out = decideEmptyFollowup({ iteration: 0, maxIterations: 3 })
    expect(out.kind).toBe("c")
    expect(out.kind === "c" && out.action).toBe("And what's next?")
    expect(out.reason).toBe("ask_what_next")
  })

  test("second empty turn after whatNextAsked terminates", () => {
    const cycle: CycleState = { iteration: 1, stepKind: "c", whatNextAsked: true }
    const out = decideEmptyFollowup({ cycle, iteration: 1, maxIterations: 3 })
    expect(out.kind).toBe("d")
    expect(out.kind === "d" && out.resultingAction).toBeNull()
    expect(out.reason).toBe("what_next_already_asked")
  })

  test("max iterations forces terminal kind=d", () => {
    const out = decideEmptyFollowup({ iteration: 3, maxIterations: 3 })
    expect(out.kind).toBe("d")
    expect(out.reason).toBe("max_iterations")
  })

  test("askWhereIsPlanOnEmpty switches the C variant", () => {
    const out = decideEmptyFollowup({ iteration: 0, maxIterations: 3, askWhereIsPlanOnEmpty: true })
    expect(out.kind).toBe("c")
    expect(out.kind === "c" && out.action).toBe("Where is the plan?")
    expect(out.reason).toBe("ask_where_is_plan")
  })

  test("where-is-plan only fires once before falling back to what-next", () => {
    const first = decideEmptyFollowup({ iteration: 0, maxIterations: 3, askWhereIsPlanOnEmpty: true })
    expect(first.kind).toBe("c")
    expect(first.kind === "c" && first.reason).toBe("ask_where_is_plan")

    const cycle: CycleState = { iteration: 1, stepKind: "c", whereIsPlanAsked: true }
    const second = decideEmptyFollowup({ cycle, iteration: 1, maxIterations: 3, askWhereIsPlanOnEmpty: true })
    expect(second.kind).toBe("c")
    expect(second.kind === "c" && second.action).toBe("And what's next?")
    expect(second.reason).toBe("ask_what_next")
  })
})

describe("autobest/steps - runSteps orchestration", () => {
  test("Step A wins when candidates are present", () => {
    const dec = runSteps({ stepACandidates: cands("rerun-test", "tighten-repro"), maxIterations: 3 })
    expect(isStepA(dec)).toBe(true)
    expect(dec.kind === "a" && dec.action).toBe("rerun-test")
    expect(shouldSubmit(dec)).toBe(true)
  })

  test("Step B fires when Step A empty and compact window has unfinished items", () => {
    const dec = runSteps({
      stepACandidates: [],
      compactWindow: window({
        actionItems: ["- finish refactor", "- bump version"],
        completed: ["- finish refactor"],
      }),
      maxIterations: 3,
    })
    expect(isStepB(dec)).toBe(true)
    expect(dec.kind === "b" && dec.action).toBe("- bump version")
    expect(dec.kind === "b" && dec.reason).toBe("plan_step_skipped")
    expect(shouldSubmit(dec)).toBe(true)
  })

  test("Step C fires when Step A empty AND no compact window", () => {
    const dec = runSteps({ stepACandidates: [], maxIterations: 3 })
    expect(isStepC(dec)).toBe(true)
    expect(dec.kind === "c" && dec.action).toBe("And what's next?")
    expect(shouldSubmit(dec)).toBe(true)
  })

  test("Step D fires once whatNextAsked && Step A empty", () => {
    const cycle: CycleState = { iteration: 1, stepKind: "c", whatNextAsked: true }
    const dec = runSteps({ stepACandidates: [], cycle, maxIterations: 3 })
    expect(isStepD(dec)).toBe(true)
    expect(dec.kind === "d" && dec.resultingAction).toBeNull()
    expect(shouldSubmit(dec)).toBe(false)
  })

  test("Step D fires when iteration reaches maxIterations", () => {
    const cycle: CycleState = { iteration: 3, stepKind: "a" }
    const dec = runSteps({ stepACandidates: [], cycle, maxIterations: 3 })
    expect(isStepD(dec)).toBe(true)
    expect(dec.reason).toBe("max_iterations")
  })

  test("Step B compact window with no unfinished items falls through to C", () => {
    const dec = runSteps({
      stepACandidates: [],
      compactWindow: window({ actionItems: ["a", "b"], completed: ["a", "b"] }),
      maxIterations: 3,
    })
    expect(isStepC(dec)).toBe(true)
    expect(dec.kind === "c" && dec.action).toBe("And what's next?")
  })

  test("Step C only fires once per cycle (deterministic A→C→D progression)", () => {
    let cycle: CycleState | undefined = undefined

    const first = runSteps({ stepACandidates: [], cycle, maxIterations: 3 })
    expect(first.kind).toBe("c")
    cycle = { iteration: 1, stepKind: "c", whatNextAsked: true }

    const second = runSteps({ stepACandidates: [], cycle, maxIterations: 3 })
    expect(second.kind).toBe("d")
  })

  test("askWhereIsPlanOnEmpty yields deterministic C -> C -> D cycle", () => {
    const first = runSteps({ stepACandidates: [], maxIterations: 3, askWhereIsPlanOnEmpty: true })
    expect(first.kind).toBe("c")
    expect(first.kind === "c" && first.reason).toBe("ask_where_is_plan")

    const second = runSteps({
      stepACandidates: [],
      maxIterations: 3,
      askWhereIsPlanOnEmpty: true,
      cycle: { iteration: 1, stepKind: "c", whereIsPlanAsked: true },
    })
    expect(second.kind).toBe("c")
    expect(second.kind === "c" && second.reason).toBe("ask_what_next")

    const third = runSteps({
      stepACandidates: [],
      maxIterations: 3,
      askWhereIsPlanOnEmpty: true,
      cycle: { iteration: 2, stepKind: "c", whereIsPlanAsked: true, whatNextAsked: true },
    })
    expect(third.kind).toBe("d")
    expect(third.reason).toBe("what_next_already_asked")
  })
})

describe("autobest/steps - assistantIgnoredPlan", () => {
  test("returns true when tail does not mention the item", () => {
    expect(assistantIgnoredPlan("- deploy the branch", "I wrote tests and stopped.")).toBe(true)
  })

  test("returns false when tail mentions the item verbatim", () => {
    expect(assistantIgnoredPlan("- deploy the branch", "next I will deploy the branch now")).toBe(false)
  })

  test("returns false for short plan items to avoid false positives", () => {
    expect(assistantIgnoredPlan("- go", "anything")).toBe(false)
    expect(assistantIgnoredPlan("1. do x", "z")).toBe(false)
  })

  test("strips bullet/number prefixes before matching", () => {
    expect(assistantIgnoredPlan("1. write docs", "I will write docs tomorrow")).toBe(false)
    expect(assistantIgnoredPlan("* write docs", "unrelated")).toBe(true)
  })
})

describe("autobest/steps - runStepsEffect", () => {
  const readerFor = (window?: CompactWindow): CompactWindowReader =>
    () => Effect.succeed(window)

  test("Step A wins when candidates are present (effect variant)", async () => {
    const dec = await Effect.runPromise(
      runStepsEffect({
        sessionID: "s",
        stepACandidates: cands("rerun-test"),
        maxIterations: 3,
      }),
    )
    expect(dec.kind).toBe("a")
    expect(dec.kind === "a" && dec.action).toBe("rerun-test")
  })

  test("Step B fires when plan item is unmentioned in tail", async () => {
    const dec = await Effect.runPromise(
      runStepsEffect({
        sessionID: "s",
        stepACandidates: [],
        maxIterations: 3,
        compactReader: readerFor({
          id: 1,
          actionItems: ["deploy the branch", "update changelog"],
          completed: [],
        }),
        assistantTail: "I wrote tests and then stopped.",
      }),
    )
    expect(dec.kind).toBe("b")
    expect(dec.kind === "b" && dec.action).toBe("deploy the branch")
    expect(dec.kind === "b" && dec.reason).toBe("plan_step_skipped")
  })

  test("Step B falls through to C when tail already mentions next plan item", async () => {
    const dec = await Effect.runPromise(
      runStepsEffect({
        sessionID: "s",
        stepACandidates: [],
        maxIterations: 3,
        compactReader: readerFor({
          id: 1,
          actionItems: ["deploy the branch"],
          completed: [],
        }),
        assistantTail: "I will deploy the branch next.",
      }),
    )
    expect(dec.kind).toBe("c")
  })

  test("Step C fires when no compact reader is supplied", async () => {
    const dec = await Effect.runPromise(
      runStepsEffect({ sessionID: "s", stepACandidates: [], maxIterations: 3 }),
    )
    expect(dec.kind).toBe("c")
  })

  test("Step D fires once cycle.whatNextAsked=true (effect variant)", async () => {
    const cycle: CycleState = { iteration: 1, stepKind: "c", whatNextAsked: true }
    const dec = await Effect.runPromise(
      runStepsEffect({ sessionID: "s", stepACandidates: [], cycle, maxIterations: 3 }),
    )
    expect(dec.kind).toBe("d")
  })

  test("effect path preserves where-is-plan -> what-next -> done ordering", async () => {
    const first = await Effect.runPromise(
      runStepsEffect({ sessionID: "s", stepACandidates: [], maxIterations: 3, askWhereIsPlanOnEmpty: true }),
    )
    expect(first.kind).toBe("c")
    expect(first.kind === "c" && first.reason).toBe("ask_where_is_plan")

    const second = await Effect.runPromise(
      runStepsEffect({
        sessionID: "s",
        stepACandidates: [],
        maxIterations: 3,
        askWhereIsPlanOnEmpty: true,
        cycle: { iteration: 1, stepKind: "c", whereIsPlanAsked: true },
      }),
    )
    expect(second.kind).toBe("c")
    expect(second.kind === "c" && second.reason).toBe("ask_what_next")

    const third = await Effect.runPromise(
      runStepsEffect({
        sessionID: "s",
        stepACandidates: [],
        maxIterations: 3,
        askWhereIsPlanOnEmpty: true,
        cycle: { iteration: 2, stepKind: "c", whereIsPlanAsked: true, whatNextAsked: true },
      }),
    )
    expect(third.kind).toBe("d")
    expect(third.reason).toBe("what_next_already_asked")
  })

  test("compactReader failure is swallowed and treated as undefined window", async () => {
    const failing: CompactWindowReader = () => Effect.fail(new Error("boom") as never)
    const dec = await Effect.runPromise(
      runStepsEffect({
        sessionID: "s",
        stepACandidates: [],
        maxIterations: 3,
        compactReader: failing,
        assistantTail: "x",
      }),
    )
    // Falls through to Step C when no window available.
    expect(dec.kind).toBe("c")
  })
})
