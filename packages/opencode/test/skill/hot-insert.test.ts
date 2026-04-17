import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import fs from "fs/promises"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Skill } from "../../src/skill"
import { maybeAutoExtractSkill, autoSkillsDir, Event as SkillEvent } from "../../src/skill/hook"
import type { MessageV2 } from "../../src/session/message-v2"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

// Layer merges Skill + Bus + Config services. Skill.defaultLayer already
// composes Bus/Config internally for its own needs, but the hook module
// depends on them being in the R channel of the calling test effect too,
// so we merge them in at the top.
const testLayer = Layer.mergeAll(
  Skill.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(testLayer)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function shellParts(n: number): MessageV2.Part[] {
  return Array.from({ length: n }).map(
    (_, i) =>
      ({
        type: "tool",
        tool: "bash",
        callID: String(i),
        id: `p${i}` as any,
        messageID: "m1" as any,
        sessionID: "s1" as any,
        state: {
          status: "completed",
          input: { command: `cargo test --step ${i}` },
          output: "ok",
          title: `step-${i}`,
          metadata: {},
          time: { start: 0, end: 1 },
        },
      }) satisfies MessageV2.Part,
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("skill/hot-insert", () => {
  it.live("writes SKILL.md to disk and overlays via notifyHotInserted", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const before = yield* (yield* Skill.Service).all()
          expect(before.length).toBe(0)

          yield* maybeAutoExtractSkill({
            turnId: "turn-1",
            userPrompt: "Run the three-step build verification",
            modelResponse: "done",
            parts: shellParts(5),
            isSubAgent: false,
          })

          const after = yield* (yield* Skill.Service).all()
          expect(after.length).toBe(1)
          const info = after[0]
          expect(info.name.length).toBeGreaterThan(0)
          expect(info.location.startsWith(autoSkillsDir())).toBe(true)

          const onDisk = yield* Effect.promise(() => fs.readFile(info.location, "utf8"))
          expect(onDisk).toContain("## Steps")
          expect(onDisk).toContain(info.name)

          // Cleanup: remove the written artifact so repeated test runs don't
          // accumulate stale skills in $XDG_DATA/opencode/skills/auto.
          yield* Effect.promise(() => fs.rm(info.location).catch(() => undefined))
        }),
      { git: true },
    ),
  )

  it.live("publishes Skill.Event.HotInserted via the bus", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const bus = yield* Bus.Service
          const seen = yield* Deferred.make<{
            name: string
            confidence: number
          }>()
          const unsubscribe = yield* bus.subscribeCallback(SkillEvent.HotInserted, (event) => {
            Effect.runFork(
              Deferred.succeed(seen, {
                name: event.properties.skill.name,
                confidence: event.properties.confidence,
              }),
            )
          })

          yield* maybeAutoExtractSkill({
            turnId: "turn-2",
            userPrompt: "Port a three-step refactor",
            modelResponse: "done",
            parts: shellParts(5),
            isSubAgent: false,
          })

          const event = yield* Deferred.await(seen).pipe(Effect.timeout("3 seconds"))
          expect(event.name.length).toBeGreaterThan(0)
          expect(event.confidence).toBeGreaterThan(0.5)

          unsubscribe()

          const after = yield* (yield* Skill.Service).all()
          for (const s of after) {
            yield* Effect.promise(() => fs.rm(s.location).catch(() => undefined))
          }
        }),
      { git: true },
    ),
  )

  it.live("no-op when autoskill config flag is false", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* maybeAutoExtractSkill({
            turnId: "turn-3",
            userPrompt: "Should not extract",
            modelResponse: "done",
            parts: shellParts(5),
            isSubAgent: false,
          })
          const skills = yield* (yield* Skill.Service).all()
          expect(skills.length).toBe(0)
        }),
      { git: true, config: { autoskill: false } },
    ),
  )

  it.live("no-op for sub-agent sessions", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* maybeAutoExtractSkill({
            turnId: "turn-4",
            userPrompt: "Spawned child work",
            modelResponse: "done",
            parts: shellParts(5),
            isSubAgent: true,
          })
          const skills = yield* (yield* Skill.Service).all()
          expect(skills.length).toBe(0)
        }),
      { git: true },
    ),
  )

  it.live("no-op when tool-call count below threshold", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          yield* maybeAutoExtractSkill({
            turnId: "turn-5",
            userPrompt: "Too few calls",
            modelResponse: "done",
            parts: shellParts(2),
            isSubAgent: false,
          })
          const skills = yield* (yield* Skill.Service).all()
          expect(skills.length).toBe(0)
        }),
      { git: true },
    ),
  )
})
