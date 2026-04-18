/**
 * Tests for SessionStart / SessionEnd lifecycle hook dispatch.
 *
 * Round 7 Stream 2 — `Session.Service.create` fires `SessionStart` through
 * `Hook.Service.dispatch` after `Event.Created`, and `Session.Service.remove`
 * fires `SessionEnd` after `Event.Deleted`. In-process hooks registered via
 * {@link Hook.Service.register} receive the full `HookPayload` including
 * `session_id`, `cwd`, and a rollout-path mirror on the event (when present).
 */
import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { Session } from "../../src/session"
import * as Hook from "../../src/hook"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import type { HookPayload, HookResult } from "../../src/hook/types"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

interface Captured {
  readonly payload: HookPayload
}

describe("Session lifecycle hooks", () => {
  test("creating a session dispatches SessionStart with sessionID + cwd + rolloutPath", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const hooks = yield* Hook.Service
            const sessions = yield* Session.Service

            const captured: Captured[] = []
            const off = yield* hooks.register({
              name: "test:session-start",
              event: "SessionStart",
              run: (payload) =>
                Effect.sync<HookResult>(() => {
                  captured.push({ payload })
                  return {
                    kind: "success",
                    decision_interrupt: false,
                    suppress_output: false,
                  }
                }),
            })

            try {
              const info = yield* sessions.create({ title: "hook-start" })
              return { info, captured }
            } finally {
              off()
            }
          }),
        )

        const { info, captured } = result
        expect(captured).toHaveLength(1)
        const [only] = captured
        expect(only.payload.session_id).toBe(info.id)
        expect(only.payload.cwd).toBe(info.directory)
        expect(only.payload.hook_event.hook_event_name).toBe("SessionStart")
        if (only.payload.hook_event.hook_event_name === "SessionStart") {
          expect(only.payload.hook_event.rolloutPath).toBe(info.rolloutPath!)
        }
        expect(only.payload.transcript_path).toBe(info.rolloutPath)

        await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(info.id)))
      },
    })
  })

  test("removing a session dispatches SessionEnd with reason + rolloutPath", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const result = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const hooks = yield* Hook.Service
            const sessions = yield* Session.Service

            const info = yield* sessions.create({ title: "hook-end" })

            const captured: Captured[] = []
            const off = yield* hooks.register({
              name: "test:session-end",
              event: "SessionEnd",
              run: (payload) =>
                Effect.sync<HookResult>(() => {
                  captured.push({ payload })
                  return {
                    kind: "success",
                    decision_interrupt: false,
                    suppress_output: false,
                  }
                }),
            })

            try {
              yield* sessions.remove(info.id)
            } finally {
              off()
            }
            return { info, captured }
          }),
        )

        const { info, captured } = result
        expect(captured).toHaveLength(1)
        const [only] = captured
        expect(only.payload.session_id).toBe(info.id)
        expect(only.payload.cwd).toBe(info.directory)
        expect(only.payload.hook_event.hook_event_name).toBe("SessionEnd")
        if (only.payload.hook_event.hook_event_name === "SessionEnd") {
          expect(only.payload.hook_event.reason).toBe("removed")
          expect(only.payload.hook_event.rolloutPath).toBe(info.rolloutPath!)
        }
        expect(only.payload.transcript_path).toBe(info.rolloutPath)
      },
    })
  })

  test("a registered hook that throws does not prevent session creation", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const info = await AppRuntime.runPromise(
          Effect.gen(function* () {
            const hooks = yield* Hook.Service
            const sessions = yield* Session.Service

            const off = yield* hooks.register({
              name: "test:session-start-throws",
              event: "SessionStart",
              run: () => Effect.die(new Error("hook exploded")),
            })

            try {
              return yield* sessions.create({ title: "hook-start-throws" })
            } finally {
              off()
            }
          }),
        )

        expect(info.id).toBeDefined()
        await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(info.id)))
      },
    })
  })
})
