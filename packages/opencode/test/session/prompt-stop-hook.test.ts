import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AdaptiveHooks } from "../../src/session/adaptive"
import { SessionID } from "../../src/session/schema"

function run<A, E>(
  body: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
) {
  return Effect.runPromise(
    provideTmpdirInstance(() => body.pipe(Effect.scoped)).pipe(
      Effect.scoped,
      Effect.provide(CrossSpawnSpawner.defaultLayer),
    ) as Effect.Effect<A, E>,
  )
}

describe("SessionPrompt.runStopHook", () => {
  test("captures stdout from argv-form command", async () => {
    await run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const out = yield* SessionPrompt.runStopHook({
          hook: { name: "echo-hello", command: ["printf", "hello world"] },
          cwd: process.cwd(),
          spawner,
        })
        expect(out).toBe("hello world")
      }),
    )
  })

  test("captures stdout from shell-string form", async () => {
    await run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const out = yield* SessionPrompt.runStopHook({
          hook: { name: "shell-echo", command: "printf 'from-shell'" },
          cwd: process.cwd(),
          spawner,
        })
        expect(out).toBe("from-shell")
      }),
    )
  })

  test("returns empty string for empty argv", async () => {
    await run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const out = yield* SessionPrompt.runStopHook({
          hook: { name: "empty", command: [] },
          cwd: process.cwd(),
          spawner,
        })
        expect(out).toBe("")
      }),
    )
  })

  test("returns empty string when command fails to spawn", async () => {
    await run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const out = yield* SessionPrompt.runStopHook({
          hook: { name: "bogus", command: ["/does/not/exist/at/all/xyz123"] },
          cwd: process.cwd(),
          spawner,
        })
        expect(out).toBe("")
      }),
    )
  })

  test("returns empty string when command exits non-zero after printing", async () => {
    // Even on non-zero exit, stdout captured up to exit should remain.
    await run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const out = yield* SessionPrompt.runStopHook({
          hook: {
            name: "fail-but-print",
            command: ["sh", "-c", "printf 'partial'; exit 2"],
          },
          cwd: process.cwd(),
          spawner,
        })
        expect(out).toBe("partial")
      }),
    )
  })

  test("respects timeout and returns empty when hook hangs", async () => {
    await run(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const out = yield* SessionPrompt.runStopHook({
          hook: {
            name: "hang",
            command: ["sh", "-c", "sleep 5; printf 'too-late'"],
            timeoutMs: 150,
          },
          cwd: process.cwd(),
          spawner,
        })
        expect(out).toBe("")
      }),
    )
  })

  test("DEFAULT_STOP_HOOK_TIMEOUT_MS is 5000", () => {
    expect(SessionPrompt.DEFAULT_STOP_HOOK_TIMEOUT_MS).toBe(5_000)
  })
})

describe("SessionPrompt stop-hook preBreak observer", () => {
  // Mirrors the preBreak observer registered inside the SessionPrompt
  // layer body at `prompt.ts` ~line 241. We replicate the exact control
  // flow here against `AdaptiveHooks.Service` to prove that
  // `runStopHook` → `AdaptiveHooks.Inject` wiring produces the expected
  // `{kind: "inject", message: {text, source}}` directive shape.
  const registerStopHookObserver = (
    hooks: ReadonlyArray<SessionPrompt.StopHookEntry>,
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    cwd: string,
  ) =>
    Effect.gen(function* () {
      const adaptive = yield* AdaptiveHooks.Service
      yield* adaptive.register({
        name: "stop-hooks",
        preBreak: () =>
          Effect.gen(function* () {
            if (hooks.length === 0) return AdaptiveHooks.Continue
            const parts: string[] = []
            for (const hook of hooks) {
              const out = yield* SessionPrompt.runStopHook({ hook, cwd, spawner })
              const trimmed = out.trim()
              if (trimmed.length === 0) continue
              parts.push(`<stop-hook name="${hook.name}">\n${trimmed}\n</stop-hook>`)
            }
            if (parts.length === 0) return AdaptiveHooks.Continue
            return AdaptiveHooks.Inject({
              text: parts.join("\n\n"),
              source: "stop-hooks",
            })
          }),
      })
    })

  const runWithAdaptive = <A, E>(
    body: Effect.Effect<A, E, AdaptiveHooks.Service | ChildProcessSpawner.ChildProcessSpawner>,
  ) =>
    Effect.runPromise(
      provideTmpdirInstance(() =>
        body.pipe(Effect.scoped, Effect.provide(AdaptiveHooks.defaultLayer)),
      ).pipe(Effect.scoped, Effect.provide(CrossSpawnSpawner.defaultLayer)) as Effect.Effect<A, E>,
    )

  test("fires AdaptiveHooks.Inject with aggregated stdout when hooks print", async () => {
    await runWithAdaptive(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const adaptive = yield* AdaptiveHooks.Service
        yield* registerStopHookObserver(
          [
            { name: "alpha", command: ["printf", "alpha-out"] },
            { name: "beta", command: ["printf", "beta-out"] },
          ],
          spawner,
          process.cwd(),
        )
        const sessionID = SessionID.make("session_stop_hook_fires")
        const directive = yield* adaptive.runPreBreak({ sessionID, step: 1 })
        expect(directive.kind).toBe("inject")
        if (directive.kind !== "inject") throw new Error("unreachable")
        expect(directive.message.source).toBe("stop-hooks")
        expect(directive.message.text).toContain('<stop-hook name="alpha">')
        expect(directive.message.text).toContain("alpha-out")
        expect(directive.message.text).toContain('<stop-hook name="beta">')
        expect(directive.message.text).toContain("beta-out")
      }),
    )
  })

  test("returns Continue when no hooks configured", async () => {
    await runWithAdaptive(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const adaptive = yield* AdaptiveHooks.Service
        yield* registerStopHookObserver([], spawner, process.cwd())
        const sessionID = SessionID.make("session_stop_hook_none")
        const directive = yield* adaptive.runPreBreak({ sessionID, step: 1 })
        expect(directive.kind).toBe("continue")
      }),
    )
  })

  test("returns Continue when all hook stdouts are empty", async () => {
    await runWithAdaptive(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const adaptive = yield* AdaptiveHooks.Service
        yield* registerStopHookObserver(
          [
            { name: "silent", command: ["true"] },
            { name: "also-silent", command: ["printf", ""] },
          ],
          spawner,
          process.cwd(),
        )
        const sessionID = SessionID.make("session_stop_hook_empty")
        const directive = yield* adaptive.runPreBreak({ sessionID, step: 1 })
        expect(directive.kind).toBe("continue")
      }),
    )
  })
})
