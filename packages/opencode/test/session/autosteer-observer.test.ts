import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionAutosteer } from "../../src/session/autosteer"
import { SessionAutosteerObserver } from "../../src/session/autosteer-observer"
import { AdaptiveHooks } from "../../src/session/adaptive"
import { MessageID, PartID } from "../../src/session/schema"

const projectRoot = path.join(__dirname, "../..")

function createSession(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

/**
 * Build a minimal assistant MessageV2 with a single text part.
 *
 * `seq` controls the ascending message/part IDs so the `MessageV2.stream`
 * iterator yields messages newest-first in the order we appended.
 */
async function appendAssistantText(sessionID: SessionNs.Info["id"], text: string) {
  const messageID = MessageID.ascending()
  await updateMessage({
    id: messageID,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID: MessageID.ascending(),
    modelID: "test" as never,
    providerID: "test" as never,
    mode: "",
    agent: "test",
    path: { cwd: projectRoot, root: projectRoot },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Info)
  const partID = PartID.ascending()
  await updatePart({
    id: partID,
    sessionID,
    messageID,
    type: "text",
    text,
  } as unknown as MessageV2.Part)
  return { messageID, partID }
}

function evaluateSession(sessionID: SessionNs.Info["id"]) {
  return AppRuntime.runPromise(
    SessionAutosteerObserver.Service.use((svc) => svc.evaluateSession(sessionID as any)),
  )
}

function getCount(sessionID: SessionNs.Info["id"]) {
  return AppRuntime.runPromise(
    SessionAutosteerObserver.Service.use((svc) => svc.getCount(sessionID as any)),
  )
}

describe("SessionAutosteerObserver", () => {
  test("single healthy assistant message → no nudge, counter stays 0", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createSession({})
        await appendAssistantText(session.id, "```\nEdited foo.ts\n```")
        const out = await evaluateSession(session.id)
        expect(out.stagnant).toBe(false)
        expect(out.nudge).toBe(false)
        expect(await getCount(session.id)).toBe(0)
      },
    })
  })

  test("single planning-only reply → stagnant but no nudge yet", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createSession({})
        await appendAssistantText(session.id, "My plan is to refactor the world.")
        const out = await evaluateSession(session.id)
        expect(out.stagnant).toBe(true)
        expect(out.nudge).toBe(false)
        expect(out.count).toBe(1)
      },
    })
  })

  test("two consecutive planning-only replies trigger nudge injection", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createSession({})
        // First stagnant reply.
        await appendAssistantText(session.id, "My plan is to refactor the world.")
        const first = await evaluateSession(session.id)
        expect(first.nudge).toBe(false)
        expect(first.count).toBe(1)

        // Second stagnant reply — should fire nudge and reset counter to 0.
        await appendAssistantText(session.id, "Here's my plan: refactor the world again.")
        const second = await evaluateSession(session.id)
        expect(second.stagnant).toBe(true)
        expect(second.nudge).toBe(true)
        expect(second.count).toBe(0)

        // A user message with the canned nudge text should now be present.
        const items: MessageV2.WithParts[] = []
        for (const item of MessageV2.stream(session.id)) items.push(item)
        const userMsgs = items.filter((i) => i.info.role === "user")
        const nudged = userMsgs.some((m) =>
          m.parts.some((p) => p.type === "text" && p.text === SessionAutosteer.NUDGE_TEXT),
        )
        expect(nudged).toBe(true)
      },
    })
  })

  test("runtime override forces autosteering off regardless of config default", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createSession({})
        // Disable via override.
        await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.setEnabledOverride(false)),
        )
        await appendAssistantText(session.id, "My plan is to refactor.")
        await appendAssistantText(session.id, "Here's my plan: refactor.")
        const out = await evaluateSession(session.id)
        expect(out.nudge).toBe(false)
        expect(out.stagnant).toBe(false)
        // Restore so the next test sees the default ON state.
        await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.setEnabledOverride(undefined)),
        )
      },
    })
  })

  test("cumulative nudge counter accumulates across nudges", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createSession({})
        await appendAssistantText(session.id, "My plan is to refactor.")
        await evaluateSession(session.id)
        await appendAssistantText(session.id, "Here's my plan: refactor again.")
        const second = await evaluateSession(session.id)
        expect(second.nudge).toBe(true)

        const total = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.cumulativeNudgeCount()),
        )
        expect(total).toBeGreaterThanOrEqual(1)

        const perSession = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.perSessionNudgeCounts()),
        )
        expect(perSession.get(session.id as any)).toBeGreaterThanOrEqual(1)
      },
    })
  })

  test("isEnabled returns the effective value", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        // Default config has autosteering enabled (or unset → defaults true).
        const before = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.isEnabled()),
        )
        expect(typeof before).toBe("boolean")

        await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.setEnabledOverride(false)),
        )
        const off = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.isEnabled()),
        )
        expect(off).toBe(false)

        await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.setEnabledOverride(true)),
        )
        const on = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.isEnabled()),
        )
        expect(on).toBe(true)

        await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.setEnabledOverride(undefined)),
        )
      },
    })
  })

  test("registered postIteration observer emits Inject directive on nudge", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createSession({})
        // First stagnant reply — postIteration fires once and increments
        // the detection counter but no nudge (count: 1 < trigger: 2).
        await appendAssistantText(session.id, "My plan is to refactor.")
        const first = await AppRuntime.runPromise(
          AdaptiveHooks.Service.use((svc) =>
            svc.runPostIteration({
              sessionID: session.id as any,
              step: 1,
              defaultOutcome: "continue",
            }),
          ),
        )
        expect(first.kind).toBe("continue")

        // Second stagnant reply — postIteration crosses the trigger and
        // emits Inject via the autosteer observer. The runLoop (not this
        // observer) owns the appendUserText side-effect.
        await appendAssistantText(session.id, "Here's my plan: refactor again.")
        const merged = await AppRuntime.runPromise(
          AdaptiveHooks.Service.use((svc) =>
            svc.runPostIteration({
              sessionID: session.id as any,
              step: 2,
              defaultOutcome: "continue",
            }),
          ),
        )
        expect(merged.kind).toBe("inject")
        if (merged.kind === "inject") {
          expect(merged.message.source).toBe("autosteer:nudge")
          expect(merged.message.text).toBe(SessionAutosteer.NUDGE_TEXT)
        }
      },
    })
  })

  test("healthy reply between two stagnant replies prevents nudge", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await createSession({})
        await appendAssistantText(session.id, "My plan is to refactor.")
        expect((await evaluateSession(session.id)).count).toBe(1)
        await appendAssistantText(session.id, "```\nEdited src/foo.ts\n```")
        const healthy = await evaluateSession(session.id)
        expect(healthy.nudge).toBe(false)
        expect(healthy.count).toBe(0)
        await appendAssistantText(session.id, "Here's my plan again.")
        const again = await evaluateSession(session.id)
        // Counter starts over from 0 because prior healthy reset it.
        expect(again.nudge).toBe(false)
        expect(again.count).toBe(1)
      },
    })
  })
})
