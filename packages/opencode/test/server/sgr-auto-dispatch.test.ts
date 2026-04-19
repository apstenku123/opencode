/**
 * SGR auto-dispatch regression coverage.
 *
 * Verifies that when `/turn/start` (or `SessionPrompt.prompt` + `loop`)
 * runs with a `json_schema` output format whose schema carries an
 * `x-opencode-dispatch` hint, the server:
 *   1. captures the structured payload on the assistant message, AND
 *   2. auto-invokes the named downstream tool (bash) through the normal
 *      `PreToolUse` + `PostToolUse` hook chain — so tests migrating
 *      away from skip-on-stall wrappers can assert both the structured
 *      output and the tool result without a second LLM round-trip.
 *
 * The test reuses the layer wiring pattern from `prompt-effect.test.ts`
 * (TestLLMServer, local `test` provider, Session/Prompt layers) so we
 * avoid bringing up the full HTTP server — the regression surface is
 * the runLoop, not the Hono route.
 */
import { NodeFileSystem } from "@effect/platform-node"
import { FetchHttpClient } from "effect/unstable/http"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config"
import { FileTime } from "../../src/file/time"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider as ProviderSvc } from "../../src/provider"
import { Env } from "../../src/env"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Question } from "../../src/question"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionSummary } from "../../src/session/summary"
import { Instruction } from "../../src/session/instruction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { AdaptiveHooks } from "../../src/session/adaptive"
import { SessionMemoryObserver } from "../../src/session/memory-observer"
import { SubagentRegistry } from "../../src/subagent/registry"
import * as Hook from "../../src/hook"
import type { HookEvent, HookResult } from "../../src/hook/types"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionStatus } from "../../src/session/status"
import { Skill } from "../../src/skill"
import { SkillEvolution } from "../../src/skill/evolution"
import { SystemPrompt } from "../../src/session/system"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool"
import { Truncate } from "../../src/tool"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { Format } from "../../src/format"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth"),
    authenticate: () => Effect.die("unexpected MCP auth"),
    finishAuth: () => Effect.die("unexpected MCP auth"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const filetime = Layer.succeed(
  FileTime.Service,
  FileTime.Service.of({
    read: () => Effect.void,
    get: () => Effect.succeed(undefined),
    assert: () => Effect.void,
    withLock: (_filepath, fn) => fn(),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const run = SessionRunState.layer.pipe(Layer.provide(status))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)

function makeLayer() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    Env.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.defaultLayer,
    Plugin.defaultLayer,
    Skill.defaultLayer,
    SkillEvolution.defaultLayer,
    Config.defaultLayer,
    ProviderSvc.defaultLayer,
    filetime,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
    Hook.defaultLayer,
  ).pipe(Layer.provideMerge(infra))
  const question = Question.layer.pipe(Layer.provideMerge(deps))
  const todo = Todo.layer.pipe(Layer.provideMerge(deps))
  const registry = ToolRegistry.layer.pipe(
    Layer.provide(Skill.defaultLayer),
    Layer.provide(SkillEvolution.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Format.defaultLayer),
    Layer.provideMerge(SubagentRegistry.defaultLayer),
    Layer.provideMerge(todo),
    Layer.provideMerge(question),
    Layer.provideMerge(deps),
  )
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provide(SessionRevert.defaultLayer),
      Layer.provide(summary),
      Layer.provideMerge(AdaptiveHooks.defaultLayer),
      Layer.provide(SessionMemoryObserver.defaultLayer),
      Layer.provideMerge(run),
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(SystemPrompt.defaultLayer),
      Layer.provideMerge(deps),
    ),
  ).pipe(Layer.provide(summary))
}

const it = testEffect(makeLayer())
const unix = process.platform !== "win32" ? it.live : it.live.skip

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: { ...cfg.provider.test.options, baseURL: url },
      },
    },
  }
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }

const bashPlanSchema = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute" },
    rationale: { type: "string" },
  },
  required: ["command"],
  "x-opencode-dispatch": {
    tool: "bash",
    args_from: "command",
    // Supply any tool-required args that aren't part of the SGR payload
    // (bash requires `description`; we synthesise a static one here
    // because the structured schema only carries `{command, rationale}`).
    args: { description: "auto-dispatched via SGR" },
  },
} as const

unix(
  "SGR auto-dispatch invokes bash after capturing structured payload",
  () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const hooks = yield* Hook.Service

          const seen: Array<{ phase: HookEvent["hook_event_name"]; tool?: string }> = []
          yield* hooks.register({
            name: "sgr-pre",
            event: "PreToolUse",
            run: (payload) =>
              Effect.sync(() => {
                const ev = payload.hook_event
                if (ev.hook_event_name === "PreToolUse") seen.push({ phase: "PreToolUse", tool: ev.tool_name })
                return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
              }),
          })
          yield* hooks.register({
            name: "sgr-post",
            event: "PostToolUse",
            run: (payload) =>
              Effect.sync(() => {
                const ev = payload.hook_event
                if (ev.hook_event_name === "PostToolUse") seen.push({ phase: "PostToolUse", tool: ev.tool_name })
                return { kind: "success", decision_interrupt: false, suppress_output: false } as HookResult
              }),
          })

          const session = yield* sessions.create({
            title: "SGR",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          // Queue the provider's tool-choice="required" response: return
          // a StructuredOutput call whose input matches our schema.
          yield* llm.tool("StructuredOutput", {
            command: "printf 'sgr-ok'",
            rationale: "echo a known token",
          })

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "echo sgr-ok via bash" }],
            format: {
              type: "json_schema",
              schema: bashPlanSchema as Record<string, any>,
              retryCount: 0,
            },
            model: ref,
          })

          const latest = yield* MessageV2.filterCompactedEffect(session.id)
          const assistant = latest.findLast((m) => m.info.role === "assistant")
          if (!assistant) throw new Error("no assistant message")

          // Structured output survives on message.info.structured.
          if (assistant.info.role !== "assistant") throw new Error("not assistant")
          expect(assistant.info.structured).toEqual({
            command: "printf 'sgr-ok'",
            rationale: "echo a known token",
          })

          // A bash tool part should have been auto-dispatched and completed.
          const bashPart = assistant.parts.find(
            (p): p is CompletedToolPart =>
              p.type === "tool" && p.tool === "bash" && p.state.status === "completed",
          )
          expect(bashPart).toBeDefined()
          if (!bashPart) return
          expect(bashPart.state.input.command).toBe("printf 'sgr-ok'")
          expect(bashPart.state.output).toContain("sgr-ok")

          // Hook chain fired end-to-end for the auto-dispatched tool.
          const bashEvents = seen.filter((e) => e.tool === "bash")
          expect(bashEvents.map((e) => e.phase)).toEqual(["PreToolUse", "PostToolUse"])
        }),
      { git: true, config: providerCfg },
    ),
  60_000,
)

unix(
  "SGR auto-dispatch is skipped when hint is absent",
  () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: "SGR no-hint",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* llm.tool("StructuredOutput", { answer: 42 })

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "just answer" }],
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: { answer: { type: "number" } },
                required: ["answer"],
              },
              retryCount: 0,
            },
            model: ref,
          })

          const latest = yield* MessageV2.filterCompactedEffect(session.id)
          const assistant = latest.findLast((m) => m.info.role === "assistant")
          if (!assistant || assistant.info.role !== "assistant") throw new Error("no assistant")
          expect(assistant.info.structured).toEqual({ answer: 42 })

          // No bash tool part — hint absent, no auto-dispatch.
          const bashPart = assistant.parts.find((p) => p.type === "tool" && p.tool === "bash")
          expect(bashPart).toBeUndefined()
        }),
      { git: true, config: providerCfg },
    ),
  60_000,
)

unix(
  "SGR auto-dispatch respects auto_dispatch: false opt-out",
  () =>
    provideTmpdirServer(
      ({ llm }) =>
        Effect.gen(function* () {
          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({
            title: "SGR opt-out",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* llm.tool("StructuredOutput", { command: "echo nope" })

          yield* prompt.prompt({
            sessionID: session.id,
            agent: "build",
            parts: [{ type: "text", text: "plan only" }],
            format: {
              type: "json_schema",
              schema: {
                type: "object",
                properties: { command: { type: "string" } },
                required: ["command"],
                "x-opencode-dispatch": {
                  tool: "bash",
                  args_from: "command",
                  auto_dispatch: false,
                },
              },
              retryCount: 0,
            },
            model: ref,
          })

          const latest = yield* MessageV2.filterCompactedEffect(session.id)
          const assistant = latest.findLast((m) => m.info.role === "assistant")
          if (!assistant || assistant.info.role !== "assistant") throw new Error("no assistant")
          expect(assistant.info.structured).toEqual({ command: "echo nope" })
          const bashPart = assistant.parts.find((p) => p.type === "tool" && p.tool === "bash")
          expect(bashPart).toBeUndefined()
        }),
      { git: true, config: providerCfg },
    ),
  60_000,
)
