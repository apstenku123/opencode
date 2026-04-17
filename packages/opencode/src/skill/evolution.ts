/**
 * Memento-style Read-Write Reflective Learning engine for skills.
 *
 * Direct port of `codex-rs/core/src/skills/evolution.rs`. The engine tracks
 * per-skill `SkillUtilityRecord{successes, failures, last_used, utility_rate}`
 * and a flat `tips: Tip[]` memory. After each tool/skill execution the caller
 * funnels feedback in via `processFeedback`, which returns one of:
 *
 *   - `RecordSuccess`  — utility bumped, no further action
 *   - `RecordTip`      — first failure or below `min_samples`, just store the tip
 *   - `OptimizeSkill`  — failure but `utility_rate >= utility_threshold`
 *   - `DiscoverNewSkill` — failure and `utility_rate < utility_threshold`
 *
 * Defaults match Rust:
 *   - `utility_threshold = 0.3`
 *   - `min_samples = 3`
 *   - `max_feedback_rounds = 2`
 *
 * State persists to `~/.local/share/opencode/skill-evolution.json` (Bun's
 * `xdg-state` resolves to platform-appropriate locations; we use the
 * `Global.Path.state` namespace).
 */

import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Context } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@/global"
import { InstanceState } from "@/effect"
import { Log } from "@/util"
import z from "zod"

const log = Log.create({ service: "skill.evolution" })

const DEFAULT_UTILITY_THRESHOLD = 0.3
const DEFAULT_MIN_SAMPLES = 3
const DEFAULT_MAX_FEEDBACK_ROUNDS = 2

// ---------------------------------------------------------------------------
// Schemas / types
// ---------------------------------------------------------------------------

export const Tip = z.object({
  task_summary: z.string(),
  lesson: z.string(),
  /** ISO-8601 timestamp. */
  created_at: z.string(),
})
export type Tip = z.infer<typeof Tip>

export const SkillUtilityRecord = z.object({
  skill_name: z.string(),
  successes: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  /** ISO-8601 timestamp. */
  last_used: z.string(),
  utility_rate: z.number(),
})
export type SkillUtilityRecord = z.infer<typeof SkillUtilityRecord>

export interface SkillExecutionFeedback {
  skillName: string
  taskQuery: string
  success: boolean
  errorSummary?: string
  /** Tool calls made during execution (just names is fine). */
  executionTrace: string[]
}

export type EvolutionAction =
  | { kind: "record_success"; skillName: string }
  | {
      kind: "record_tip"
      tip: Tip
    }
  | {
      kind: "optimize_skill"
      skillName: string
      suggestedChanges: string
      tip: Tip
    }
  | {
      kind: "discover_new_skill"
      oldSkillName: string
      suggestedNewSkill: string
      tip: Tip
    }

export interface EngineParams {
  utilityThreshold?: number
  minSamples?: number
  maxFeedbackRounds?: number
}

export interface PersistedState {
  utility_threshold: number
  min_samples: number
  max_feedback_rounds: number
  utility_table: Record<string, SkillUtilityRecord>
  tips: Tip[]
}

const PersistedStateSchema = z.object({
  utility_threshold: z.number().optional(),
  min_samples: z.number().int().optional(),
  max_feedback_rounds: z.number().int().optional(),
  utility_table: z.record(z.string(), SkillUtilityRecord).optional(),
  tips: z.array(Tip).optional(),
})

// ---------------------------------------------------------------------------
// Bus events
// ---------------------------------------------------------------------------

export namespace Event {
  /** Surfaced when the engine recommends an in-place edit for a skill. */
  export const EvolutionSuggested = BusEvent.define(
    "skill.evolution-suggested",
    z.object({
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("record_success"), skillName: z.string() }),
        z.object({ kind: z.literal("record_tip"), tip: Tip }),
        z.object({
          kind: z.literal("optimize_skill"),
          skillName: z.string(),
          suggestedChanges: z.string(),
          tip: Tip,
        }),
        z.object({
          kind: z.literal("discover_new_skill"),
          oldSkillName: z.string(),
          suggestedNewSkill: z.string(),
          tip: Tip,
        }),
      ]),
    }),
  )
}

// ---------------------------------------------------------------------------
// Pure engine (no I/O)
// ---------------------------------------------------------------------------

export class SkillEvolutionEngine {
  private utilityThreshold: number
  private minSamples: number
  private maxRounds: number
  private table: Map<string, SkillUtilityRecord>
  private tips: Tip[]

  constructor(params?: EngineParams) {
    this.utilityThreshold = params?.utilityThreshold ?? DEFAULT_UTILITY_THRESHOLD
    this.minSamples = params?.minSamples ?? DEFAULT_MIN_SAMPLES
    this.maxRounds = params?.maxFeedbackRounds ?? DEFAULT_MAX_FEEDBACK_ROUNDS
    this.table = new Map()
    this.tips = []
  }

  static load(json: unknown): SkillEvolutionEngine {
    const parsed = PersistedStateSchema.safeParse(json)
    const data = parsed.success ? parsed.data : {}
    const engine = new SkillEvolutionEngine({
      utilityThreshold: data.utility_threshold,
      minSamples: data.min_samples,
      maxFeedbackRounds: data.max_feedback_rounds,
    })
    if (data.utility_table) {
      for (const [k, v] of Object.entries(data.utility_table)) {
        engine.table.set(k, v)
      }
    }
    if (data.tips) {
      engine.tips = data.tips.slice()
    }
    return engine
  }

  save(): PersistedState {
    return {
      utility_threshold: this.utilityThreshold,
      min_samples: this.minSamples,
      max_feedback_rounds: this.maxRounds,
      utility_table: Object.fromEntries(this.table.entries()),
      tips: this.tips.slice(),
    }
  }

  maxFeedbackRounds(): number {
    return this.maxRounds
  }

  utilityRate(skillName: string): number {
    return this.table.get(skillName)?.utility_rate ?? 0
  }

  utilityTable(): ReadonlyMap<string, SkillUtilityRecord> {
    return this.table
  }

  allTips(): readonly Tip[] {
    return this.tips
  }

  processFeedback(feedback: SkillExecutionFeedback): EvolutionAction {
    const now = new Date().toISOString()
    let record = this.table.get(feedback.skillName)
    if (!record) {
      record = {
        skill_name: feedback.skillName,
        successes: 0,
        failures: 0,
        last_used: now,
        utility_rate: 0,
      }
      this.table.set(feedback.skillName, record)
    }

    if (feedback.success) {
      record.successes += 1
      record.last_used = now
      record.utility_rate = recompute(record)
      return { kind: "record_success", skillName: feedback.skillName }
    }

    record.failures += 1
    record.last_used = now
    record.utility_rate = recompute(record)

    const lesson = feedback.errorSummary ?? "Skill execution failed without a detailed error."
    const tip: Tip = {
      task_summary: feedback.taskQuery,
      lesson,
      created_at: now,
    }
    this.tips.push(tip)

    const total = record.successes + record.failures
    if (total < this.minSamples) {
      return { kind: "record_tip", tip }
    }

    if (record.utility_rate >= this.utilityThreshold) {
      const traceSummary = feedback.executionTrace.length === 0 ? "(no trace available)" : feedback.executionTrace.join(" -> ")
      const suggestedChanges = `Skill '${feedback.skillName}' failed on task '${feedback.taskQuery}'. Trace: ${traceSummary}. Consider refining the skill's instructions to handle this case.`
      return {
        kind: "optimize_skill",
        skillName: feedback.skillName,
        suggestedChanges,
        tip,
      }
    }

    const utilityPct = (record.utility_rate * 100).toFixed(1)
    const thresholdPct = (this.utilityThreshold * 100).toFixed(0)
    const suggestedNewSkill =
      `# Replacement for ${feedback.skillName}\n\n` +
      `The previous skill had a utility rate of ${utilityPct}% over ${total} attempts, ` +
      `which is below the ${thresholdPct}% threshold.\n\n` +
      `## Suggested approach\n\n` +
      `Re-implement to address the recurring failure: ${feedback.errorSummary ?? "(unknown)"}\n`
    return {
      kind: "discover_new_skill",
      oldSkillName: feedback.skillName,
      suggestedNewSkill,
      tip,
    }
  }
}

function recompute(r: SkillUtilityRecord): number {
  const total = r.successes + r.failures
  if (total === 0) return 0
  return r.successes / total
}

// ---------------------------------------------------------------------------
// Persistence helpers (free functions; safe to call without an Effect runtime)
// ---------------------------------------------------------------------------

export function statePath(): string {
  return path.join(Global.Path.state, "skill-evolution.json")
}

export async function loadFromDisk(): Promise<SkillEvolutionEngine> {
  try {
    const raw = await fs.readFile(statePath(), "utf8")
    return SkillEvolutionEngine.load(JSON.parse(raw))
  } catch {
    return new SkillEvolutionEngine()
  }
}

export async function saveToDisk(engine: SkillEvolutionEngine): Promise<void> {
  const file = statePath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(engine.save(), null, 2), "utf8")
}

// ---------------------------------------------------------------------------
// Effect Service (exposes onToolComplete + accessors).
// ---------------------------------------------------------------------------

export interface Interface {
  /** Funnel a tool/skill outcome into the engine. Fire-and-forget. */
  readonly onToolComplete: (input: {
    toolName: string
    success: boolean
    error?: string
    taskQuery?: string
    executionTrace?: string[]
  }) => Effect.Effect<EvolutionAction>
  readonly utilityRate: (skillName: string) => Effect.Effect<number>
  readonly snapshot: () => Effect.Effect<PersistedState>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillEvolution") {}

type State = {
  engine: SkillEvolutionEngine
  saveScheduled: boolean
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("SkillEvolution.state")(function* () {
        const engine = yield* Effect.promise(() => loadFromDisk())
        return { engine, saveScheduled: false }
      }),
    )

    const persistAsync = Effect.fn("SkillEvolution.persist")(function* () {
      const s = yield* InstanceState.get(state)
      if (s.saveScheduled) return
      s.saveScheduled = true
      // Microtask defer so a flurry of tool completions only writes once.
      Promise.resolve().then(async () => {
        try {
          await saveToDisk(s.engine)
        } catch (err) {
          log.warn("failed to persist skill evolution state", { err })
        } finally {
          s.saveScheduled = false
        }
      })
    })

    const onToolComplete = Effect.fn("SkillEvolution.onToolComplete")(function* (input: {
      toolName: string
      success: boolean
      error?: string
      taskQuery?: string
      executionTrace?: string[]
    }) {
      const s = yield* InstanceState.get(state)
      const action = s.engine.processFeedback({
        skillName: input.toolName,
        taskQuery: input.taskQuery ?? "",
        success: input.success,
        errorSummary: input.error,
        executionTrace: input.executionTrace ?? [],
      })

      // Surface non-trivial actions on the bus so the TUI / observers can
      // pick them up. RecordSuccess fires on every successful tool call —
      // skip publishing it to keep bus volume reasonable.
      if (action.kind !== "record_success") {
        yield* bus.publish(Event.EvolutionSuggested, { action })
      }

      switch (action.kind) {
        case "record_success":
          log.debug("recorded success", { skill: action.skillName })
          break
        case "record_tip":
          log.debug("recorded tip (insufficient samples)", { lesson: action.tip.lesson })
          break
        case "optimize_skill":
          log.warn("skill optimization suggested", {
            skill: action.skillName,
            suggestion: action.suggestedChanges,
          })
          break
        case "discover_new_skill":
          log.warn("new skill discovery suggested", {
            old_skill: action.oldSkillName,
          })
          break
      }

      yield* persistAsync()
      return action
    })

    const utilityRate = Effect.fn("SkillEvolution.utilityRate")(function* (skillName: string) {
      const s = yield* InstanceState.get(state)
      return s.engine.utilityRate(skillName)
    })

    const snapshot = Effect.fn("SkillEvolution.snapshot")(function* () {
      const s = yield* InstanceState.get(state)
      return s.engine.save()
    })

    return Service.of({ onToolComplete, utilityRate, snapshot })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SkillEvolution from "./evolution"
