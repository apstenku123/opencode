/**
 * SessionMemoryObserver wiring tests.
 *
 * These exercise the round-3 integration surface:
 *   - `buildHooksConfig` maps config toggles onto `MemoryHooksConfig`.
 *   - `makeObserverOptions` composes session + config + memory into an
 *     `AdaptiveHooks.Observer` shape the turn loop can register.
 *
 * Live-session wiring (ensureRegistered → adaptive.runPreIteration) is
 * covered by the existing prompt-effect integration tests; here we stay
 * at the unit-level seams so the round-3 change is verifiable without a
 * live LLM.
 */

import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { SessionMemoryObserver } from "../../src/session/memory-observer"
import { DEFAULT_HOOKS_CONFIG } from "../../src/memory/turn-hooks"
import type { Memory } from "../../src/memory"
import type { Session } from "../../src/session"
import type { Config } from "../../src/config"

describe("SessionMemoryObserver.buildHooksConfig", () => {
  test("returns the defaults when config.memories is absent", () => {
    expect(SessionMemoryObserver.buildHooksConfig(undefined)).toEqual(DEFAULT_HOOKS_CONFIG)
    expect(SessionMemoryObserver.buildHooksConfig({})).toEqual(DEFAULT_HOOKS_CONFIG)
  })

  test("merges partial overrides onto the defaults", () => {
    const out = SessionMemoryObserver.buildHooksConfig({
      memories: { enabled: true, retrievalTopK: 8 },
    })
    expect(out.enabled).toBe(true)
    expect(out.retrievalTopK).toBe(8)
    // Other knobs stay at defaults.
    expect(out.retrievalEnabled).toBe(DEFAULT_HOOKS_CONFIG.retrievalEnabled)
    expect(out.extractionEnabled).toBe(DEFAULT_HOOKS_CONFIG.extractionEnabled)
    expect(out.retrievalMinScore).toBe(DEFAULT_HOOKS_CONFIG.retrievalMinScore)
  })

  test("opt-in preserves defaults for per-phase flags — memories disabled by default", () => {
    const out = SessionMemoryObserver.buildHooksConfig({ memories: { enabled: false } })
    expect(out.enabled).toBe(false)
  })
})

describe("SessionMemoryObserver.resolveModelSpec", () => {
  test("prefers the phase-specific slot when set", () => {
    const cfg = { model: "anthropic/claude-sonnet", memories: { extractionModel: "openai/gpt-4.1" } }
    expect(SessionMemoryObserver.resolveModelSpec(cfg, "extraction")).toBe("openai/gpt-4.1")
  })

  test("falls back to session default model for extraction + rerank", () => {
    const cfg = { model: "anthropic/claude-sonnet", memories: {} }
    expect(SessionMemoryObserver.resolveModelSpec(cfg, "extraction")).toBe("anthropic/claude-sonnet")
    expect(SessionMemoryObserver.resolveModelSpec(cfg, "rerank")).toBe("anthropic/claude-sonnet")
  })

  test("does NOT fall back to default for polish / querySynth", () => {
    const cfg = { model: "anthropic/claude-sonnet", memories: {} }
    expect(SessionMemoryObserver.resolveModelSpec(cfg, "polish")).toBeUndefined()
    expect(SessionMemoryObserver.resolveModelSpec(cfg, "querySynth")).toBeUndefined()
  })

  test("returns undefined when both slots are empty", () => {
    expect(SessionMemoryObserver.resolveModelSpec(undefined, "extraction")).toBeUndefined()
    expect(SessionMemoryObserver.resolveModelSpec({}, "extraction")).toBeUndefined()
    expect(
      SessionMemoryObserver.resolveModelSpec({ memories: { extractionModel: "  " } }, "extraction"),
    ).toBeUndefined()
  })
})

describe("SessionMemoryObserver.makeObserverOptions", () => {
  const stubMemory = {} as Memory.Interface

  const stubConfig = (cfg: any): Config.Interface =>
    ({
      get: () => Effect.succeed(cfg),
    }) as unknown as Config.Interface

  const stubSession = (msgs: any[]): Session.Interface =>
    ({
      messages: () => Effect.succeed(msgs),
    }) as unknown as Session.Interface

  test("resolveUserPrompt returns newest user text", () =>
    Effect.gen(function* () {
      const opts = SessionMemoryObserver.makeObserverOptions({
        memory: stubMemory,
        session: stubSession([
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "first user" }],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "assistant reply" }],
          },
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "most recent user question" }],
          },
        ]),
        config: stubConfig({}),
      })
      const out = yield* opts.resolveUserPrompt("ses-1" as any)
      expect(out).toBe("most recent user question")
    }).pipe(Effect.runPromise))

  test("resolveUserPrompt returns null when no user text present", () =>
    Effect.gen(function* () {
      const opts = SessionMemoryObserver.makeObserverOptions({
        memory: stubMemory,
        session: stubSession([]),
        config: stubConfig({}),
      })
      const out = yield* opts.resolveUserPrompt("ses-1" as any)
      expect(out).toBeNull()
    }).pipe(Effect.runPromise))

  test("resolveTurn returns null when no assistant turn exists", () =>
    Effect.gen(function* () {
      const opts = SessionMemoryObserver.makeObserverOptions({
        memory: stubMemory,
        session: stubSession([
          { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
        ]),
        config: stubConfig({}),
      })
      const out = yield* opts.resolveTurn("ses-1" as any)
      expect(out).toBeNull()
    }).pipe(Effect.runPromise))

  test("resolveTurn collects trailing assistant summary + preceding user msgs", () =>
    Effect.gen(function* () {
      const opts = SessionMemoryObserver.makeObserverOptions({
        memory: stubMemory,
        session: stubSession([
          { info: { role: "user" }, parts: [{ type: "text", text: "first" }] },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "old turn" }],
          },
          { info: { role: "user" }, parts: [{ type: "text", text: "second" }] },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "latest assistant turn" }],
          },
        ]),
        config: stubConfig({}),
      })
      const out = yield* opts.resolveTurn("ses-1" as any)
      expect(out).not.toBeNull()
      expect(out!.turnSummary).toContain("latest assistant turn")
    }).pipe(Effect.runPromise))

  test("config() honours memories.enabled override", () =>
    Effect.gen(function* () {
      const opts = SessionMemoryObserver.makeObserverOptions({
        memory: stubMemory,
        session: stubSession([]),
        config: stubConfig({ memories: { enabled: true } }),
      })
      const cfg = yield* opts.config()
      expect(cfg.enabled).toBe(true)
      expect(cfg.retrievalEnabled).toBe(DEFAULT_HOOKS_CONFIG.retrievalEnabled)
    }).pipe(Effect.runPromise))

  test("wires provided bridges onto extractionModel / rerankModel / polishModel / querySynthModel", () => {
    const extract = () => Effect.succeed("raw")
    const rerank = () => Effect.succeed("{}")
    const polish = () => Effect.succeed("{}")
    const querySynth = () => Effect.succeed("query")
    const opts = SessionMemoryObserver.makeObserverOptions({
      memory: stubMemory,
      session: stubSession([]),
      config: stubConfig({}),
      bridges: {
        extraction: extract as any,
        rerank: rerank as any,
        polish: polish as any,
        querySynth: querySynth as any,
      },
    })
    expect(opts.extractionModel).toBe(extract as any)
    expect(opts.rerankModel).toBe(rerank as any)
    expect(opts.polishModel).toBe(polish as any)
    expect(opts.querySynthModel).toBe(querySynth as any)
  })

  test("omitting bridges leaves all model slots undefined (no-LLM short-circuit)", () => {
    const opts = SessionMemoryObserver.makeObserverOptions({
      memory: stubMemory,
      session: stubSession([]),
      config: stubConfig({}),
    })
    expect(opts.extractionModel).toBeUndefined()
    expect(opts.rerankModel).toBeUndefined()
    expect(opts.polishModel).toBeUndefined()
    expect(opts.querySynthModel).toBeUndefined()
  })
})
