import { PlanExitTool } from "./plan"
import { Session } from "../session"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TaskWaitTool } from "./task-wait"
import { TaskSendInputTool } from "./task-send-input"
import { TaskCloseTool } from "./task-close"
import { TaskListTool } from "./task-list"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { SkillSearchTool } from "./skill-search"
import * as Tool from "./tool"
import { Config } from "../config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "../provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@opencode-ai/shared/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { SkillEvolution } from "@/skill/evolution"
import { Permission } from "@/permission"
import { SubagentRegistry } from "@/subagent/registry"
import * as Hook from "@/hook"

const log = Log.create({ service: "tool.registry" })

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>
  /**
   * Look up a tool by `id` against the registry's builtin+custom list.
   * Returns `undefined` when the tool does not exist — callers may fall
   * through to an error path.
   *
   * The returned `Tool.Def` is the *raw* definition (not wrapped with
   * PreToolUse/PostToolUse dispatch). Callers that want hooks to fire
   * around `execute()` should route through `ToolRegistry.tools()` or
   * use {@link dispatchByName} which wraps in the same way.
   */
  readonly byName: (id: string) => Effect.Effect<Tool.Def | undefined>
  /**
   * Resolve tool `id`, invoke its `execute(args, ctx)`, and ensure
   * PreToolUse + PostToolUse hooks fire around the call exactly like
   * a normal provider-driven invocation. Used by SGR auto-dispatch to
   * run a downstream tool after a schema-guided-reasoning response is
   * captured without round-tripping through the LLM.
   */
  readonly dispatchByName: (
    id: string,
    args: unknown,
    ctx: Tool.Context,
  ) => Effect.Effect<Tool.ExecuteResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Plugin.Service
  | Question.Service
  | Todo.Service
  | Agent.Service
  | Skill.Service
  | SkillEvolution.Service
  | Session.Service
  | Provider.Service
  | LSP.Service
  | FileTime.Service
  | Instruction.Service
  | AppFileSystem.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Ripgrep.Service
  | Format.Service
  | Truncate.Service
  | SubagentRegistry.Service
  | Hook.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const evolution = yield* SkillEvolution.Service
    const truncate = yield* Truncate.Service
    const hooks = yield* Hook.Service

    const invalid = yield* InvalidTool
    const task = yield* TaskTool
    const taskWait = yield* TaskWaitTool
    const taskSendInput = yield* TaskSendInputTool
    const taskClose = yield* TaskCloseTool
    const taskList = yield* TaskListTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const bash = yield* BashTool
    const codesearch = yield* CodeSearchTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const skillsearchtool = yield* SkillSearchTool
    const agent = yield* Agent.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          return {
            id,
            parameters: z.object(def.args),
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => toolCtx.ask(req),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(result, {}, info)
                return {
                  title: "",
                  output: out.truncated ? out.content : result,
                  metadata: {
                    truncated: out.truncated,
                    outputPath: out.truncated ? out.outputPath : undefined,
                  },
                }
              }),
          }
        }

        const dirs = yield* config.directories()
        const matches = dirs.flatMap((dir) =>
          Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
        )
        if (matches.length) yield* config.waitForDependencies()
        for (const match of matches) {
          const namespace = path.basename(match, path.extname(match))
          const mod = yield* Effect.promise(
            () => import(process.platform === "win32" ? match : pathToFileURL(match).href),
          )
          for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
            custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
          }
        }

        const plugins = yield* plugin.list()
        for (const p of plugins) {
          for (const [id, def] of Object.entries(p.tool ?? {})) {
            custom.push(fromPlugin(id, def))
          }
        }

        yield* config.get()
        const questionEnabled =
          ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          bash: Tool.init(bash),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          task_wait: Tool.init(taskWait),
          task_send_input: Tool.init(taskSendInput),
          task_close: Tool.init(taskClose),
          task_list: Tool.init(taskList),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          search: Tool.init(websearch),
          code: Tool.init(codesearch),
          skill: Tool.init(skilltool),
          skill_search: Tool.init(skillsearchtool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            ...(questionEnabled ? [tool.question] : []),
            tool.bash,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.task_wait,
            tool.task_send_input,
            tool.task_close,
            tool.task_list,
            tool.fetch,
            tool.todo,
            tool.search,
            tool.code,
            tool.skill,
            tool.skill_search,
            tool.patch,
            ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
            ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const filtered = (yield* all()).filter((tool) => {
        if (tool.id === CodeSearchTool.id || tool.id === WebSearchTool.id) {
          return input.providerID === ProviderID.opencode || Flag.OPENCODE_ENABLE_EXA
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          return {
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            execute: wrapWithHooks(tool),
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    // Decorate the underlying execute to fan tool outcomes into the
    // skill evolution engine. Fire-and-forget — never let a bookkeeping
    // failure abort the user-facing tool call.
    //
    // Additionally dispatches `PreToolUse` / `PostToolUse` hook events
    // around every tool invocation. Mirrors `codex-rs/hooks/src/command_hook.rs`
    // decision semantics — a PreToolUse `FailedAbort` or
    // `permissionDecision: "deny"` short-circuits execute with an
    // `AbortError`; `permissionDecision: "ask"` forwards to
    // `Permission.Service` via `ctx.ask`; `permissionDecision: "allow"`
    // (or unset) proceeds. A PreToolUse `updatedInput` replaces the
    // forwarded args. A PostToolUse `updatedMCPToolOutput` replaces the
    // captured output string.
    function wrapWithHooks(tool: Tool.Def): Tool.Def["execute"] {
      return (args, ctx) =>
        Effect.gen(function* () {
          // ---- PreToolUse ----------------------------------------------
          const pre = yield* hooks
            .dispatch({
              event: {
                hook_event_name: "PreToolUse",
                tool_name: tool.id,
                tool_input: args,
                tool_use_id: ctx.callID,
              },
              sessionID: ctx.sessionID,
            })
            .pipe(
              Effect.catchCause(() =>
                Effect.succeed<Hook.HookDispatchResult>({
                  outcome: "continue",
                  responses: [],
                }),
              ),
            )

          if (pre.outcome === "abort") {
            const err = new Error(pre.abortReason ?? `PreToolUse hook aborted '${tool.id}'`)
            err.name = "AbortError"
            return yield* Effect.die(err)
          }

          if (pre.decisionBehavior === "deny") {
            const err = new Error(pre.decisionMessage ?? `PreToolUse hook denied '${tool.id}'`)
            err.name = "AbortError"
            return yield* Effect.die(err)
          }

          if (pre.decisionBehavior === "ask") {
            yield* ctx.ask({
              permission: tool.id,
              patterns: ["*"],
              always: ["*"],
              metadata: { hookReason: pre.decisionMessage ?? "hook requests user approval" },
            })
          }

          // PreToolUse may replace the tool input.
          const effectiveArgs = pre.updatedInput !== undefined ? (pre.updatedInput as typeof args) : args

          // ---- execute -------------------------------------------------
          const result = yield* tool.execute(effectiveArgs, ctx).pipe(
            Effect.tapDefect((cause) =>
              evolution
                .onToolComplete({
                  toolName: tool.id,
                  success: false,
                  error: String(cause),
                })
                .pipe(Effect.ignore),
            ),
          )
          yield* evolution.onToolComplete({ toolName: tool.id, success: true }).pipe(Effect.ignore)

          // ---- PostToolUse ---------------------------------------------
          const callID = ctx.callID ?? ""
          const post = yield* hooks
            .dispatch({
              event: {
                hook_event_name: "PostToolUse",
                tool_name: tool.id,
                tool_input: effectiveArgs,
                tool_response: result.output,
                tool_use_id: callID,
              },
              sessionID: ctx.sessionID,
            })
            .pipe(
              Effect.catchCause(() =>
                Effect.succeed<Hook.HookDispatchResult>({
                  outcome: "continue",
                  responses: [],
                }),
              ),
            )

          if (post.updatedOutput !== undefined && typeof post.updatedOutput === "string") {
            return { ...result, output: post.updatedOutput }
          }

          return result
        })
    }

    const byName: Interface["byName"] = Effect.fn("ToolRegistry.byName")(function* (id) {
      const list = yield* all()
      return list.find((t) => t.id === id)
    })

    const dispatchByName: Interface["dispatchByName"] = Effect.fn("ToolRegistry.dispatchByName")(function* (
      id,
      args,
      ctx,
    ) {
      const tool = yield* byName(id)
      if (!tool) {
        const err = new Error(`tool '${id}' not found in registry`)
        err.name = "NotFoundError"
        return yield* Effect.die(err)
      }
      // Validate args against the tool's parameter schema so malformed
      // SGR payloads fail loudly here instead of inside the tool body.
      const parseResult = tool.parameters.safeParse(args)
      if (!parseResult.success) {
        const err = new Error(
          tool.formatValidationError
            ? tool.formatValidationError(parseResult.error)
            : `invalid arguments for tool '${id}': ${parseResult.error.message}`,
        )
        err.name = "ValidationError"
        return yield* Effect.die(err)
      }
      return yield* wrapWithHooks(tool)(parseResult.data, ctx)
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    return Service.of({ ids, all, named, tools, byName, dispatchByName })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(SkillEvolution.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(FileTime.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(SubagentRegistry.defaultLayer),
  ).pipe(Layer.provideMerge(Hook.defaultLayer)),
)
