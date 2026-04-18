import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirInstance } from "../fixture/fixture"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

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
