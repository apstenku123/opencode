import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Cause } from "effect"
import { Bus } from "../../src/bus"
import { Guardian } from "../../src/subagent/guardian"
import { GuardianTestUtils } from "../../src/subagent/guardian-test-utils"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SubagentRegistry } from "../../src/subagent/registry"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import * as Hook from "../../src/hook"

const sid = (s: string) => SessionID.make(s)

/** All services guardian touches in its layer — compose a test harness. */
const harness = Layer.mergeAll(
  Guardian.layer,
  SubagentRegistry.layer,
  Question.layer,
  Session.layer,
  Bus.layer,
).pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(Hook.defaultLayer),
  Layer.provide(Question.defaultLayer),
  Layer.provide(SubagentRegistry.defaultLayer),
)

function run<A, E>(
  body: Effect.Effect<
    A,
    E,
    Guardian.Service | SubagentRegistry.Service | Question.Service | Session.Service | Bus.Service
  >,
) {
  return Effect.runPromise(
    provideTmpdirInstance(() =>
      body.pipe(Effect.scoped, Effect.provide(harness)),
    ).pipe(Effect.scoped, Effect.provide(CrossSpawnSpawner.defaultLayer)) as Effect.Effect<A, E>,
  )
}

describe("Guardian.decide", () => {
  test("top-level session → pass", () => {
    const req = GuardianTestUtils.makeRequest({ sessionID: "session_top" })
    const d = GuardianTestUtils.decideAgainst(req, undefined, [])
    expect(d.kind).toBe("pass")
    if (d.kind === "pass") expect(d.reason).toBe("top-level-session")
  })

  test("child with allow rule matching header → auto-approve first option", () => {
    const req = GuardianTestUtils.makeRequest({
      sessionID: "session_child",
      header: "read-file",
    })
    const d = GuardianTestUtils.decideAgainst(req, "session_parent", GuardianTestUtils.allowHeader("read-*"))
    expect(d.kind).toBe("auto-approve")
    if (d.kind === "auto-approve") {
      expect(d.parentID).toBe(sid("session_parent"))
      expect(d.reply).toEqual([["yes"]])
    }
  })

  test("child with deny rule → forward with deny-rule reason", () => {
    const req = GuardianTestUtils.makeRequest({
      sessionID: "session_child",
      header: "delete-everything",
    })
    const d = GuardianTestUtils.decideAgainst(
      req,
      "session_parent",
      GuardianTestUtils.denyHeader("delete-*"),
    )
    expect(d.kind).toBe("forward")
    if (d.kind === "forward") expect(d.reason).toBe("deny-rule")
  })

  test("child with no matching rule → forward with no-matching-rule reason", () => {
    const req = GuardianTestUtils.makeRequest({
      sessionID: "session_child",
      header: "custom-action",
    })
    const d = GuardianTestUtils.decideAgainst(req, "session_parent", [])
    expect(d.kind).toBe("forward")
    if (d.kind === "forward") expect(d.reason).toBe("no-matching-rule")
  })

  test("child with allow rule but zero options → forward with no-options", () => {
    const req = GuardianTestUtils.makeRequest({
      sessionID: "session_child",
      header: "ok",
      options: [],
    })
    const d = GuardianTestUtils.decideAgainst(req, "session_parent", GuardianTestUtils.allowHeader("ok"))
    expect(d.kind).toBe("forward")
    if (d.kind === "forward") expect(d.reason).toBe("no-options")
  })

  test("multi-question all-allow → auto-approve every question's first option", () => {
    const req = GuardianTestUtils.makeRequest({
      sessionID: "session_child",
      header: "q1",
    })
    const fullReq = { ...req, questions: [...req.questions, { ...req.questions[0], header: "q2" }] }
    const d = Guardian.decide({
      request: fullReq as Question.Request,
      parentID: sid("session_parent"),
      parentRuleset: GuardianTestUtils.allowHeader("*"),
    })
    expect(d.kind).toBe("auto-approve")
    if (d.kind === "auto-approve") expect(d.reply.length).toBe(2)
  })
})

describe("Guardian live bus subscription", () => {
  test("auto-approves child question when parent ruleset allows", async () => {
    await run(
      Effect.gen(function* () {
        const registry = yield* SubagentRegistry.Service
        const sessions = yield* Session.Service
        const q = yield* Question.Service
        yield* Guardian.Service // force layer build so bus subscription is active

        const parent = yield* sessions.create({
          title: "parent",
          permission: GuardianTestUtils.allowHeader("approve-*"),
        })
        const child = yield* sessions.create({ parentID: parent.id, title: "child" })
        yield* registry.spawn(parent.id, child.id)

        const asking = yield* Effect.forkChild(
          q.ask({
            sessionID: child.id,
            questions: [
              {
                question: "may I proceed?",
                header: "approve-edit",
                options: [
                  { label: "yes", description: "" },
                  { label: "no", description: "" },
                ],
              },
            ] as Question.Info[],
          }),
        )

        const answers = yield* Fiber.join(asking)
        expect(answers.length).toBe(1)
        expect(answers[0]).toEqual(["yes"])

        const stats = yield* Guardian.Service.use((g) => g.stats())
        expect(stats.autoApproved).toBeGreaterThanOrEqual(1)
      }),
    )
  })

  test("forwards question when parent ruleset has no match", async () => {
    await run(
      Effect.gen(function* () {
        const registry = yield* SubagentRegistry.Service
        const sessions = yield* Session.Service
        const q = yield* Question.Service
        const bus = yield* Bus.Service
        yield* Guardian.Service

        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "child" })
        yield* registry.spawn(parent.id, child.id)

        const events: unknown[] = []
        const off = yield* bus.subscribeCallback(Question.Event.ForwardedToParent, (evt) => {
          events.push(evt.properties)
        })

        const asking = yield* Effect.forkChild(
          q.ask({
            sessionID: child.id,
            questions: [
              {
                question: "unusual request",
                header: "unusual",
                options: [{ label: "ok", description: "" }],
              },
            ] as Question.Info[],
          }),
        )

        // Give the bus one tick to deliver to the guardian + our subscriber.
        yield* Effect.sleep("50 millis")

        // Parent replies manually (simulating UI response). We need the id.
        const list = yield* q.list()
        expect(list.length).toBe(1)
        yield* q.reply({ requestID: list[0].id, answers: [["ok"]] })

        const answers = yield* Fiber.join(asking)
        expect(answers[0]).toEqual(["ok"])
        expect(events.length).toBe(1)

        off()
      }),
    )
  })

  test("reject cascade: forwarded request rejected by parent propagates RejectedError to child", async () => {
    await run(
      Effect.gen(function* () {
        const registry = yield* SubagentRegistry.Service
        const sessions = yield* Session.Service
        const q = yield* Question.Service
        yield* Guardian.Service

        const parent = yield* sessions.create({ title: "parent" })
        const child = yield* sessions.create({ parentID: parent.id, title: "child" })
        yield* registry.spawn(parent.id, child.id)

        const asking = yield* Effect.forkChild(
          Effect.exit(
            q.ask({
              sessionID: child.id,
              questions: [
                {
                  question: "danger?",
                  header: "danger",
                  options: [{ label: "go", description: "" }],
                },
              ] as Question.Info[],
            }),
          ),
        )

        // Let guardian see the question and forward it.
        yield* Effect.sleep("50 millis")

        const list = yield* q.list()
        expect(list.length).toBe(1)
        yield* q.reject(list[0].id)

        const exit = yield* Fiber.join(asking)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const squashed = Cause.squash(exit.cause) as Question.RejectedError
          expect(squashed._tag).toBe("QuestionRejectedError")
        }

        const stats = yield* Guardian.Service.use((g) => g.stats())
        expect(stats.forwarded).toBeGreaterThanOrEqual(1)
      }),
    )
  })
})
