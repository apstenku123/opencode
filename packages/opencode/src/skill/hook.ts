/**
 * Autoskill hot-insert orchestration.
 *
 * Port of `codex-rs/core/src/skills/auto_extract.rs`. The public entry point
 * `maybeAutoExtractSkill` is called from `session/processor.ts` at turn end
 * (fire-and-forget). It:
 *
 *   1. Runs the pure heuristic extractor in `skill/extractor.ts` over the
 *      turn's MessageV2 parts.
 *   2. Filters candidates by `confidence >= 0.5` (matches Rust).
 *   3. Persists each surviving candidate to
 *      `~/.local/share/opencode/skills/auto/<name>.md` (the TS equivalent of
 *      Rust's `codex_home/skills` dir).
 *   4. Overlays the new skill onto the live `Skill.Service` via
 *      `notifyHotInserted` so the next turn's system-prompt skills block
 *      immediately sees it.
 *   5. Emits a `Skill.Event.HotInserted` bus event for TUI / observer
 *      subscribers.
 *
 * Failure is intentionally swallowed — autoskill must never fail a user
 * turn. All errors are logged at `warn` level.
 */

import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Effect } from "effect"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { Global } from "@/global"
import { Log } from "@/util"
import type { MessageV2 } from "@/session/message-v2"
import { Service as SkillService, Info as SkillInfo } from "./index"
import {
  collectToolCallsFromParts,
  extractFromTurn,
  type ExtractedSkillCandidate,
} from "./extractor"

const log = Log.create({ service: "skill.hook" })

const CONFIDENCE_THRESHOLD = 0.5

/**
 * Root directory for auto-extracted skills. Mirrors Rust's default of
 * `{codex_home}/skills`, scoped under the `auto/` subdir so hand-authored
 * skills in the same root aren't mixed with LLM-free extractions.
 */
export function autoSkillsDir(): string {
  return path.join(Global.Path.data, "skills", "auto")
}

// ---------------------------------------------------------------------------
// Bus event definition
// ---------------------------------------------------------------------------

export namespace Event {
  export const HotInserted = BusEvent.define(
    "skill.hot-inserted",
    z.object({
      skill: SkillInfo,
      /** Confidence reported by the extractor. */
      confidence: z.number(),
      /** Stable identifier of the turn that produced this skill. */
      sourceTurnId: z.string(),
    }),
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface HookInput {
  /** Stable identifier for the turn (used as `sourceTurnId`). */
  turnId: string
  /** Text the user sent that triggered this turn. */
  userPrompt: string
  /** Final assistant response text (currently unused; reserved). */
  modelResponse: string
  /** All MessageV2 parts produced during the turn, in order. */
  parts: MessageV2.Part[]
  /**
   * `true` if this turn belongs to a sub-agent (spawned task) session.
   * Matches Rust's `is_sub_agent` gate: sub-agents run scaffolded prompts
   * that would produce garbage skill names.
   */
  isSubAgent: boolean
}

/**
 * Heuristic gate: in the absence of a full `maybe_auto_extract_skill`
 * orchestration entry point that takes the whole `Session`, we wrap the
 * extraction + persistence + publish behind this single function. Callers
 * are expected to invoke it fire-and-forget at turn end.
 *
 * Required layers: `Config.Service`, `Skill.Service`, `Bus.Service`.
 */
export const maybeAutoExtractSkill = Effect.fn("Skill.maybeAutoExtractSkill")(function* (input: HookInput) {
  // Gate 1: sub-agent skip (Rust parity).
  if (input.isSubAgent) return

  // Gate 2: config flag. Default ON to match Rust's `unwrap_or(true)`.
  const config = yield* Config.Service
  const cfg = yield* config.get()
  if (cfg.autoskill === false) return

  const toolCalls = collectToolCallsFromParts(input.parts)
  const candidates = extractFromTurn({
    turnId: input.turnId,
    userPrompt: input.userPrompt,
    modelResponse: input.modelResponse,
    toolCalls,
  })
  if (candidates.length === 0) return

  const skill = yield* SkillService
  const bus = yield* Bus.Service

  for (const candidate of candidates) {
    if (candidate.confidence < CONFIDENCE_THRESHOLD) continue

    // Rust skips if the library already has the name; replicate via the
    // runtime overlay. We treat the overlay as authoritative — if the name
    // is already present we decline to overwrite, which also dodges
    // clobbering an identical auto-extract from an earlier turn.
    const existing = yield* skill.get(candidate.suggestedName)
    if (existing) continue

    const filePath = path.join(autoSkillsDir(), `${candidate.suggestedName}.md`)
    const written = yield* Effect.promise(() => writeSkillFile(filePath, candidate)).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          log.warn("failed to persist auto-extracted skill", { name: candidate.suggestedName, err })
          return false as const
        }),
      ),
    )
    if (!written) continue

    const info: SkillInfo = {
      name: candidate.suggestedName,
      description: candidate.suggestedDescription,
      location: filePath,
      content: candidate.content,
      scope: "auto",
    }

    yield* skill.notifyHotInserted(info)
    yield* bus.publish(Event.HotInserted, {
      skill: info,
      confidence: candidate.confidence,
      sourceTurnId: candidate.sourceTurnId,
    })
    log.info("auto-extracted skill persisted", {
      name: info.name,
      confidence: candidate.confidence,
      path: filePath,
    })
  }
})

async function writeSkillFile(filePath: string, candidate: ExtractedSkillCandidate): Promise<true> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, candidate.content, { encoding: "utf8" })
  return true
}

export * as SkillHook from "./hook"
