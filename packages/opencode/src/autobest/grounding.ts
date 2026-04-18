/**
 * Autobest grounding — round-2 port of `codex-rs/core/src/autobest_grounding.rs`.
 *
 * When Step A reports `complaint=true` (i.e. the assistant is missing
 * information), the grounding module dispatches one or more "search-like" MCP
 * tools in parallel to populate context for the next iteration.
 *
 * # Surface
 *
 * - {@link GroundingConfig} — tunables: `minIntervalTurns`, `maxAgents`,
 *   `preferredTools` (comma-separated substrings, case-insensitive).
 * - {@link GroundingOutcome} — discriminated union: `Skipped{reason}` /
 *   `Dispatched{agentsSpawned, toolsUsed, turn}`.
 * - {@link maybeDispatchGrounding} — entry point invoked from the autobest
 *   observer (Step A complaint path).
 * - {@link isSearchLikeToolName} — server / tool hint detector.
 * - {@link cooldownSkipReason} — produces the "cooldown N/M" string when within
 *   the rate-limit interval.
 * - {@link filterByPreferred} — substring filter over the configured allow-list.
 * - {@link buildGroundingQuery} — concise prompt template for tool dispatch.
 * - {@link computeResearchAgentCount} — agent count given tool inventory and caps.
 *
 * # Wiring (round 2)
 *
 * The autobest observer (see `session/autobest-observer.ts`) calls
 * {@link maybeDispatchGrounding} with the live MCP tool catalogue
 * (`MCP.Service.tools()`), the current cycle iteration, and the last grounding
 * turn (read from history). Successful dispatches return a new
 * `lastGroundingTurn` that the caller persists via the
 * `autobest.cycle.advance` history event.
 *
 * # Status
 *
 * - Pure / functional helpers fully ported (rate-limit, filter, query builder,
 *   tool-name detector, agent count).
 * - Dispatch is wired against a generic `dispatcher` callback so tests can
 *   substitute a mock; production wiring passes the AI-SDK `Tool.execute`
 *   from `MCP.Service.tools()`.
 *
 * # Defaults
 *
 * Match the Rust defaults at `autobest_grounding.rs::GroundingConfig::default`:
 * `minIntervalTurns = 8`, `maxAgents = 8`, `preferredTools = []`.
 */

import { Effect } from "effect"

// ---------------------------------------------------------------------------
// Config & outcome types
// ---------------------------------------------------------------------------

export interface GroundingConfig {
  /** Minimum number of turns between successive grounding dispatches.
   * `0` disables rate-limiting (fires every time). Default 8. */
  readonly minIntervalTurns: number
  /** Hard cap on parallel agents per dispatch. Default 8. */
  readonly maxAgents: number
  /** Optional case-insensitive substring allow-list applied to tool names.
   * When empty, all "search-like" tools are eligible. */
  readonly preferredTools: readonly string[]
}

export const DEFAULT_GROUNDING_CONFIG: GroundingConfig = {
  minIntervalTurns: 8,
  maxAgents: 8,
  preferredTools: [],
}

export type GroundingOutcome =
  | { readonly kind: "skipped"; readonly reason: string }
  | {
      readonly kind: "dispatched"
      readonly agentsSpawned: number
      readonly toolsUsed: readonly string[]
      readonly turn: number
    }

// ---------------------------------------------------------------------------
// Search-like tool detection — port of `is_search_like_tool_name`
// ---------------------------------------------------------------------------

/**
 * Server-name hints: any tool whose key contains one of these substrings is a
 * grounding candidate even if the bare tool name does not match a hint below.
 * Mirrors the table in `autobest_grounding.rs`.
 */
const SERVER_HINTS = [
  "perplexity",
  "exa",
  "tavily",
  "brave",
  "kagi",
  "serper",
  "searxng",
] as const

/**
 * Tool-name hints — the tail of the qualified key after the last `:` is
 * inspected for these substrings.
 */
const TOOL_HINTS = [
  "search",
  "research",
  "find_similar",
  "ask",
  "reasoning",
  "deep_research",
  "scholar",
  "pro",
] as const

/**
 * Determine whether `qualifiedName` ("server:tool" or any string containing
 * server / tool hints) refers to a search-like grounding tool. Case-insensitive.
 */
export function isSearchLikeToolName(qualifiedName: string): boolean {
  const lower = qualifiedName.toLowerCase()
  // Server-side match is sufficient.
  for (const hint of SERVER_HINTS) {
    if (lower.includes(hint)) return true
  }
  // Tool-name fallback: only match the tail (after the last separator).
  const tail = lower.includes(":") ? lower.slice(lower.lastIndexOf(":") + 1) : lower
  for (const hint of TOOL_HINTS) {
    if (tail.includes(hint)) return true
  }
  return false
}

/**
 * Filter `tools` to those whose name contains at least one entry from
 * `preferred` (substring, case-insensitive). When `preferred` is empty,
 * returns the input unchanged.
 *
 * Mirrors `filter_by_preferred` from `autobest_grounding.rs`.
 */
export function filterByPreferred(tools: readonly string[], preferred: readonly string[]): string[] {
  if (preferred.length === 0) return [...tools]
  const norm = preferred.map((p) => p.trim().toLowerCase()).filter(Boolean)
  if (norm.length === 0) return [...tools]
  return tools.filter((name) => {
    const lower = name.toLowerCase()
    return norm.some((p) => lower.includes(p))
  })
}

// ---------------------------------------------------------------------------
// Rate-limit / cooldown — port of `cooldown_skip_reason`
// ---------------------------------------------------------------------------

/**
 * If we should skip dispatch because the cooldown window has not yet elapsed,
 * return the descriptive `"cooldown N/M"` reason string. Returns `undefined`
 * when dispatch should proceed.
 *
 * Special cases:
 *   - `minIntervalTurns === 0` → never skip.
 *   - `lastGroundingTurn === undefined` → first ever dispatch, never skip.
 *   - `currentTurn === 0` → never skip (Rust special-case for the very first turn).
 */
export function cooldownSkipReason(input: {
  currentTurn: number
  lastGroundingTurn?: number
  minIntervalTurns: number
}): string | undefined {
  if (input.minIntervalTurns === 0) return undefined
  if (input.currentTurn === 0) return undefined
  if (input.lastGroundingTurn === undefined) return undefined
  const elapsed = input.currentTurn - input.lastGroundingTurn
  if (elapsed >= input.minIntervalTurns) return undefined
  return `cooldown ${elapsed}/${input.minIntervalTurns}`
}

// ---------------------------------------------------------------------------
// Query template — port of `build_grounding_query`
// ---------------------------------------------------------------------------

const QUERY_TEMPLATE = `You are grounding a follow-up turn for an AI assistant. The assistant complained about missing information.

Complaint reason: {{REASON}}

Recent assistant tail (truncated):
{{TAIL}}

Use the tool to find the most relevant authoritative sources / data needed to address the complaint. Prefer concrete API references, code snippets, and primary documentation. Return a concise summary suitable for re-injection into the next turn.`

/**
 * Build the dispatch query passed to each grounding tool.
 *
 * Truncates the supplied `tail` to `maxTailLen` characters (no UTF-8 byte
 * arithmetic — tools do not have the same 6 KB hard limit Step A enforces;
 * a generous character cap is sufficient).
 */
export function buildGroundingQuery(input: {
  complaintReason: string
  tail?: string
  maxTailLen?: number
}): string {
  const tail = (input.tail ?? "").slice(-(input.maxTailLen ?? 4_000))
  return QUERY_TEMPLATE.replace("{{REASON}}", input.complaintReason || "(unspecified)").replace(
    "{{TAIL}}",
    tail || "(none)",
  )
}

// ---------------------------------------------------------------------------
// Agent-count target — port of `compute_research_agent_count`
// ---------------------------------------------------------------------------

/**
 * Compute the desired number of parallel research agents.
 *
 * Mirror of Rust:
 *   - target = 8 (configurable via `maxAgents`).
 *   - capped by `agentMaxThreads` if supplied.
 *   - capped by `toolCount * 2` to avoid spinning more agents than tools can
 *     usefully serve.
 *   - floor of 1 when at least one tool is present.
 */
export function computeResearchAgentCount(input: {
  toolCount: number
  maxAgents?: number
  agentMaxThreads?: number
}): number {
  if (input.toolCount <= 0) return 0
  const target = input.maxAgents ?? DEFAULT_GROUNDING_CONFIG.maxAgents
  let n = target
  if (typeof input.agentMaxThreads === "number" && input.agentMaxThreads > 0) {
    n = Math.min(n, input.agentMaxThreads)
  }
  n = Math.min(n, input.toolCount * 2)
  return Math.max(1, n)
}

// ---------------------------------------------------------------------------
// Static prefix table (legacy compatibility)
// ---------------------------------------------------------------------------

/**
 * Filter a `Record<toolName, anything>` map to entries whose names look like
 * grounding tools. Static counterpart to live `MCP.Service.tools()` discovery —
 * exposed for tests and for callers without a live MCP catalogue.
 */
export function collectAvailableSearchToolsFromMap<T>(
  tools: Record<string, T>,
  preferred: readonly string[] = [],
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [name, value] of Object.entries(tools)) {
    if (!isSearchLikeToolName(name)) continue
    out[name] = value
  }
  if (preferred.length === 0) return out
  const filteredKeys = new Set(filterByPreferred(Object.keys(out), preferred))
  const final: Record<string, T> = {}
  for (const k of filteredKeys) final[k] = out[k]
  return final
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Per-tool dispatch hook. Tests substitute a stub; production wiring passes
 * a function that invokes the underlying AI-SDK `Tool.execute` and discards
 * the result (grounding is fire-and-forget — the next iteration sees the
 * captured context via the tool's own state pipeline).
 */
export type Dispatcher = (toolName: string, query: string) => Effect.Effect<void>

export interface MaybeDispatchInput {
  readonly currentTurn: number
  readonly lastGroundingTurn?: number
  readonly complaintReason: string
  readonly tail?: string
  readonly tools: readonly string[]
  readonly config?: Partial<GroundingConfig>
  readonly agentMaxThreads?: number
  readonly dispatcher?: Dispatcher
}

/**
 * Top-level entry point. Returns a {@link GroundingOutcome} describing whether
 * dispatch fired, was skipped, or had no eligible tools.
 *
 * Skipped reasons:
 *   - `"cooldown N/M"` — within rate-limit window.
 *   - `"no_search_tools"` — no MCP tool matched `isSearchLikeToolName`.
 *   - `"preferred_filter_empty"` — `preferred_tools` excluded everything.
 *
 * Dispatch is fire-and-forget: any per-tool failure inside `dispatcher` is
 * swallowed and counted (no exception escapes this function).
 */
export function maybeDispatchGrounding(input: MaybeDispatchInput): Effect.Effect<GroundingOutcome> {
  return Effect.gen(function* () {
    const cfg: GroundingConfig = {
      minIntervalTurns: input.config?.minIntervalTurns ?? DEFAULT_GROUNDING_CONFIG.minIntervalTurns,
      maxAgents: input.config?.maxAgents ?? DEFAULT_GROUNDING_CONFIG.maxAgents,
      preferredTools: input.config?.preferredTools ?? DEFAULT_GROUNDING_CONFIG.preferredTools,
    }

    const cooldown = cooldownSkipReason({
      currentTurn: input.currentTurn,
      lastGroundingTurn: input.lastGroundingTurn,
      minIntervalTurns: cfg.minIntervalTurns,
    })
    if (cooldown) return { kind: "skipped", reason: cooldown } satisfies GroundingOutcome

    const eligible = input.tools.filter(isSearchLikeToolName)
    if (eligible.length === 0) return { kind: "skipped", reason: "no_search_tools" } satisfies GroundingOutcome

    const filtered = filterByPreferred(eligible, cfg.preferredTools)
    if (filtered.length === 0)
      return { kind: "skipped", reason: "preferred_filter_empty" } satisfies GroundingOutcome

    const agentTarget = computeResearchAgentCount({
      toolCount: filtered.length,
      maxAgents: cfg.maxAgents,
      agentMaxThreads: input.agentMaxThreads,
    })
    if (agentTarget === 0) return { kind: "skipped", reason: "no_agents" } satisfies GroundingOutcome

    const selected = filtered.slice(0, agentTarget)
    const query = buildGroundingQuery({
      complaintReason: input.complaintReason,
      tail: input.tail,
    })

    const dispatcher = input.dispatcher

    if (dispatcher) {
      // Fire-and-forget: collect into Effect.all but ignore failures so a
      // single tool's error does not poison the whole dispatch.
      yield* Effect.forEach(
        selected,
        (toolName) => dispatcher(toolName, query).pipe(Effect.catch(() => Effect.void)),
        { concurrency: "unbounded", discard: true },
      )
    }

    return {
      kind: "dispatched",
      agentsSpawned: selected.length,
      toolsUsed: selected,
      turn: input.currentTurn,
    } satisfies GroundingOutcome
  })
}

// ---------------------------------------------------------------------------
// Production wiring helpers
// ---------------------------------------------------------------------------

/**
 * Build a {@link Dispatcher} that drives tools obtained from
 * `MCP.Service.tools()` (AI-SDK Tool map). The query is passed via the
 * tool's standard input schema; tools that do not accept a string `query`
 * field are invoked with `{ query }` and the result is discarded.
 *
 * Failures inside the underlying tool are swallowed — grounding is best-effort.
 */
export function dispatcherFromAiTools(tools: Record<string, { execute?: (args: any, opts?: any) => unknown }>): Dispatcher {
  return (toolName, query) =>
    Effect.tryPromise({
      try: async () => {
        const tool = tools[toolName]
        if (!tool || typeof tool.execute !== "function") return
        const out = tool.execute({ query }, { toolCallId: `grounding:${toolName}:${Date.now()}`, messages: [] })
        if (out && typeof (out as Promise<unknown>).then === "function") {
          await out
        }
      },
      catch: (err) => err,
    }).pipe(Effect.catch(() => Effect.void))
}

// ---------------------------------------------------------------------------
// Real MCP wiring (round 3)
// ---------------------------------------------------------------------------

/**
 * Shape of the MCP service surface this module consumes. Limited to `tools()`
 * because grounding is otherwise decoupled from the rest of the MCP lifecycle.
 * Kept structural to simplify testing — callers can pass any object matching
 * this shape, e.g. a mock or the real `MCP.Service`.
 */
export interface McpInterface {
  readonly tools: () => Effect.Effect<Record<string, { execute?: (args: any, opts?: any) => unknown }>>
}

/**
 * Build a {@link Dispatcher} from a live `MCP.Service`-shaped interface.
 * Internally calls `mcp.tools()` on each dispatch (cheap — it just reads the
 * cached AI-SDK tool map) and forwards to {@link dispatcherFromAiTools}.
 *
 * The returned dispatcher honours the same failure-swallowing contract as
 * {@link dispatcherFromAiTools}; grounding is fire-and-forget.
 *
 * # Filtering
 *
 * This dispatcher does NOT re-filter by {@link isSearchLikeToolName} — that
 * filter is applied at the {@link maybeDispatchGrounding} layer against the
 * **candidate tool list** provided by the caller, so only search-like tools
 * ever reach this dispatcher. Callers must pass the pre-filtered tool-name
 * list to `maybeDispatchGrounding` (see `session/autobest-observer.ts`).
 */
export function dispatcherFromMcp(mcp: McpInterface): Dispatcher {
  return (toolName, query) =>
    Effect.gen(function* () {
      const tools = yield* mcp.tools()
      yield* dispatcherFromAiTools(tools)(toolName, query)
    }).pipe(Effect.catch(() => Effect.void))
}

/**
 * Surface the list of search-like tool names from an `MCP.Service`-shaped
 * interface. Used by the observer to build the `tools` argument for
 * {@link maybeDispatchGrounding}.
 */
export function listSearchToolsFromMcp(mcp: McpInterface): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const tools = yield* mcp.tools()
    return Object.keys(tools).filter(isSearchLikeToolName)
  }).pipe(Effect.catch(() => Effect.succeed([] as string[])))
}

// ---------------------------------------------------------------------------
// History-event persistence
// ---------------------------------------------------------------------------

/**
 * `autobest.grounding` history event shape. Mirrors the entry in
 * `history/index.ts` Event union. Duplicated structurally here to keep the
 * grounding module free of a hard dependency on history's type tree — the
 * observer casts to the history `Event` union when persisting.
 */
export interface GroundingEvent {
  readonly ts: number
  readonly type: "autobest.grounding"
  readonly sessionID: string
  readonly outcome: "skipped" | "dispatched"
  readonly reason?: string
  readonly agentsSpawned?: number
  readonly toolsUsed?: string[]
  readonly turn: number
}

/**
 * Build a `autobest.grounding` history event for a {@link GroundingOutcome}.
 * Use alongside {@link maybeDispatchGrounding}:
 *
 * ```
 * const outcome = yield* maybeDispatchGrounding({ ... })
 * yield* Effect.promise(() => History.append(sessionID, buildGroundingEvent({
 *   sessionID,
 *   outcome,
 *   currentTurn,
 * })))
 * ```
 *
 * For `skipped` outcomes the `turn` field carries the **current** turn rather
 * than a dispatch turn — this lets cooldown accounting advance correctly
 * (i.e. "last attempt was at turn N" regardless of outcome).
 */
export function buildGroundingEvent(input: {
  sessionID: string
  outcome: GroundingOutcome
  currentTurn: number
  ts?: number
}): GroundingEvent {
  const ts = input.ts ?? Date.now()
  if (input.outcome.kind === "skipped") {
    return {
      ts,
      type: "autobest.grounding",
      sessionID: input.sessionID,
      outcome: "skipped",
      reason: input.outcome.reason,
      turn: input.currentTurn,
    }
  }
  return {
    ts,
    type: "autobest.grounding",
    sessionID: input.sessionID,
    outcome: "dispatched",
    agentsSpawned: input.outcome.agentsSpawned,
    toolsUsed: [...input.outcome.toolsUsed],
    turn: input.outcome.turn,
  }
}

/**
 * Walk a sequence of `autobest.grounding` events newest-first and return
 * the turn of the most recent **dispatched** event. `skipped` events do NOT
 * count — cooldown only advances when we actually fired tools.
 *
 * Used by the observer to hydrate `lastGroundingTurn` from history at the
 * start of each Step A iteration.
 */
export function lastDispatchedGroundingTurn(events: readonly GroundingEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!
    if (ev.outcome === "dispatched") return ev.turn
  }
  return undefined
}
