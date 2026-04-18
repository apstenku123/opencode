import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, Context } from "effect"
import { NamedError } from "@opencode-ai/shared/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Config } from "../config"
import { ConfigMarkdown } from "../config"
import { Glob } from "@opencode-ai/shared/util/glob"
import { Log } from "../util"
import { Discovery } from "./discovery"
import { Bm25Index } from "./bm25"
import { hybridRank, type HybridHit, type HybridWeights } from "./retrieval"
import { cosineSimilarity } from "@/embedding"
import { builtinSkillsEnabled, loadAllBuiltinSkills } from "./builtin"
import { buildRoutedRanking, type RouterKind, type RoutedSkill } from "./router"

const log = Log.create({ service: "skill" })
const EXTERNAL_DIRS = [".claude", ".agents"]
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

/**
 * Optional `dependencies.tools` block for env-var dependency resolution.
 * Mirrors Rust's `SkillMetadata.dependencies`. Fully optional — skills that
 * don't declare any deps remain backward-compatible with older parsers.
 */
export const Dependencies = z.object({
  tools: z
    .array(
      z.object({
        type: z.literal("env_var"),
        value: z.string(),
        description: z.string().optional(),
      }),
    )
    .optional(),
})
export type Dependencies = z.infer<typeof Dependencies>

/**
 * Provenance label for a registered skill. Lets callers (HTTP consumers, the
 * TUI sidebar) distinguish the bundled built-in pack from hand-authored and
 * auto-extracted skills without path-sniffing the `location` field.
 *
 *   - `builtin`  — shipped with the binary via `src/skill/builtin/*`.
 *   - `auto`     — written by the autoskill hot-insert pipeline into
 *                   `{data}/skills/auto/*.md`.
 *   - `project`  — discovered under the active project's `.claude/skills` or
 *                   `.agents/skills`, or through user-configured
 *                   `skills.paths` / `skills.urls`.
 */
export const Scope = z.enum(["builtin", "auto", "project"])
export type Scope = z.infer<typeof Scope>

export const Info = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
  content: z.string(),
  /** Provenance — see {@link Scope}. Defaults to `"project"` for discovered skills. */
  scope: Scope.optional(),
  /** Optional env-var dependencies declared in frontmatter. */
  dependencies: Dependencies.optional(),
})
export type Info = z.infer<typeof Info>

export const InvalidError = NamedError.create(
  "SkillInvalidError",
  z.object({
    path: z.string(),
    message: z.string().optional(),
    issues: z.custom<z.core.$ZodIssue[]>().optional(),
  }),
)

export const NameMismatchError = NamedError.create(
  "SkillNameMismatchError",
  z.object({
    path: z.string(),
    expected: z.string(),
    actual: z.string(),
  }),
)

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
  /** Lazily-built BM25 index. Invalidated to `null` on hot-insert. */
  bm25: Bm25Index | null
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
  /**
   * BM25 retrieval over the live skill list. Re-uses the cached BM25 index
   * (rebuilt lazily on first call and on every `notifyHotInserted`). Returns
   * the top-`topK` skills ranked by score; empty list when query produces no
   * matches (caller should fall back to substring `recommend()`).
   */
  readonly search: (query: string, topK?: number) => Effect.Effect<{ skill: Info; score: number }[]>
  /**
   * Hybrid BM25 ↔ embedding retrieval. When an `embedder` is supplied, the
   * final ranking blends BM25 with cosine similarity against a per-skill
   * TF-IDF / API embedding using configurable weights (default 0.4×BM25 +
   * 0.6×cosine). When `embedder` is `undefined`, the call degrades to the
   * same BM25-only path as {@link search} — the returned hits always carry
   * their component scores so the caller can inspect which channel fired.
   */
  readonly searchHybrid: (input: {
    query: string
    topK?: number
    weights?: HybridWeights
    embedder?: {
      embed: (text: string) => Float32Array
      embedBatch?: (texts: ReadonlyArray<string>) => Float32Array[]
    }
  }) => Effect.Effect<HybridHit[]>
  /**
   * Inject a freshly-extracted skill into the live registry without a disk
   * re-scan. Used by the autoskill hot-insert pipeline after it writes the
   * generated SKILL.md to `~/.local/share/opencode/skills/auto/<name>.md`.
   *
   * Subsequent `get`/`all`/`available` calls within the same session reflect
   * the insert. `notifyHotInserted` overlays the entry on top of the
   * disk-scanned state — it does not touch disk itself.
   */
  readonly notifyHotInserted: (skill: Info) => Effect.Effect<void>
  /**
   * Memento-style router search. Dispatches to
   * {@link buildRoutedRanking} with the configured kind
   * (`skills.router.kind`; defaults to `"bm25"` for parity). Returns the
   * scored `RoutedSkill` rows so callers can inspect each channel's
   * contribution. When the query produces no matches the list is empty;
   * callers typically fall back to substring `recommend()`.
   */
  readonly searchRouted: (input: {
    query: string
    topK?: number
    kind?: RouterKind
    /** Per-skill cosine scores (optional). Feeds the RRF / Boltzmann paths. */
    cosineScores?: ReadonlyMap<string, number>
    /** Per-skill historical success rate 0–1. Missing ⇒ 0. */
    utilityTable?: ReadonlyMap<string, number>
  }) => Effect.Effect<RoutedSkill[]>
}

const add = Effect.fnUntraced(function* (
  state: State,
  match: string,
  bus: Bus.Interface,
  scope: Scope = "project",
  /**
   * Pre-loaded markdown source. When provided the frontmatter parser runs
   * against this string directly instead of re-reading the file at `match`.
   * Required for the built-in pack (whose `location` is a synthetic
   * `/$bunfs/root/...` path embedded at bundle time).
   */
  preloaded?: string,
) {
  const md = yield* Effect.tryPromise({
    try: () =>
      preloaded !== undefined
        ? Promise.resolve(ConfigMarkdown.parseString(preloaded, match))
        : ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return

  // `name` + `description` are required; `dependencies` follows the strict
  // `{tools:[{type:"env_var",...}]}` shape. Legacy builtin markdown uses a
  // flat `dependencies: [docker]` array — we accept that by parsing
  // dependencies separately and silently dropping the field if it doesn't
  // conform. This keeps the builtin pack loadable without forcing a
  // frontmatter migration.
  const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
  if (!parsed.success) return
  const depsParsed = Dependencies.optional().safeParse((md.data as any)?.dependencies)
  const dependencies = depsParsed.success ? depsParsed.data : undefined

  if (state.skills[parsed.data.name]) {
    log.warn("duplicate skill name", {
      name: parsed.data.name,
      existing: state.skills[parsed.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[parsed.data.name] = {
    name: parsed.data.name,
    description: parsed.data.description,
    location: match,
    content: md.content,
    scope,
    dependencies,
  }
})

const scan = Effect.fnUntraced(function* (
  state: State,
  bus: Bus.Interface,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
    }),
  )

  yield* Effect.forEach(matches, (match) => add(state, match, bus), {
    concurrency: "unbounded",
    discard: true,
  })
})

/**
 * Register the 8 bundled built-in skills into the live state. Pure
 * filesystem-free path: reads the markdown via `Bun.file()` relative to
 * `src/skill/builtin/` and hands each entry to `add()` so it shares the
 * same frontmatter validator as disk-discovered skills.
 */
const registerBuiltinSkills = Effect.fnUntraced(function* (state: State, bus: Bus.Interface) {
  const bundle = yield* Effect.tryPromise({
    try: () => loadAllBuiltinSkills(),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        log.error("failed to load builtin skills", { err })
        return [] as Awaited<ReturnType<typeof loadAllBuiltinSkills>>
      }),
    ),
  )
  for (const entry of bundle) {
    // The `add()` helper parses the markdown frontmatter and writes into
    // `state.skills`. We hand it both the bundle path (for display/logging)
    // and the pre-loaded markdown body so the filesystem parser is
    // bypassed — the synthetic `/$bunfs/root/...` location is never
    // openable at runtime.
    yield* add(state, entry.location, bus, "builtin", entry.content)
  }
  log.info("registered builtin skills", { count: bundle.length, names: bundle.map((s) => s.name) })
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  config: Config.Interface,
  discovery: Discovery.Interface,
  bus: Bus.Interface,
  fsys: AppFileSystem.Interface,
  directory: string,
  worktree: string,
) {
  if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
    for (const dir of EXTERNAL_DIRS) {
      const root = path.join(Global.Path.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, bus, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, bus, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, bus, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()

  // Built-in skill bundle — opt-in via `skills.builtin: true` or override
  // via `OPENCODE_DISABLE_BUILTIN_SKILLS=1`. Skills parsed from the
  // embedded markdown are registered under their declared frontmatter
  // name; any disk-discovered skill with the same name overrides.
  if (builtinSkillsEnabled(cfg.skills?.builtin)) {
    yield* registerBuiltinSkills(state, bus)
  }

  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      log.warn("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, bus, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      state.dirs.add(dir)
      yield* scan(state, bus, dir, SKILL_PATTERN)
    }
  }

  log.info("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* (ctx) {
        const s: State = { skills: {}, dirs: new Set(), bm25: null }
        yield* loadSkills(s, config, discovery, bus, fsys, ctx.directory, ctx.worktree)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const all = Effect.fn("Skill.all")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.skills)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      const s = yield* InstanceState.get(state)
      return Array.from(s.dirs)
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    const notifyHotInserted = Effect.fn("Skill.notifyHotInserted")(function* (skill: Info) {
      const s = yield* InstanceState.get(state)
      // Mid-turn safe overlay: the `State` record is held by reference inside
      // ScopedCache so direct mutation is visible to every subsequent get/all.
      // We intentionally do **not** emit a parse error if the name collides
      // — a hot-insert is allowed to replace a stale auto-extracted skill
      // with a freshly regenerated one.
      s.skills[skill.name] = skill
      s.dirs.add(path.dirname(skill.location))
      // Invalidate the BM25 index so the next `search()` rebuilds it with
      // the new skill in scope. Cheap to defer — most turns never search.
      s.bm25 = null
      log.info("hot-inserted skill", { name: skill.name, location: skill.location })
    })

    const search = Effect.fn("Skill.search")(function* (query: string, topK: number = 5) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills)
      if (list.length === 0) return []
      if (!s.bm25) s.bm25 = Bm25Index.build(list)
      const hits = s.bm25.search(query, topK)
      const byName = new Map(list.map((sk) => [sk.name, sk]))
      const result: { skill: Info; score: number }[] = []
      for (const hit of hits) {
        const sk = byName.get(hit.skillName)
        if (sk) result.push({ skill: sk, score: hit.score })
      }
      return result
    })

    const searchHybrid = Effect.fn("Skill.searchHybrid")(function* (input: {
      query: string
      topK?: number
      weights?: HybridWeights
      embedder?: {
        embed: (text: string) => Float32Array
        embedBatch?: (texts: ReadonlyArray<string>) => Float32Array[]
      }
    }) {
      const topK = input.topK ?? 5
      const pool = Math.max(topK * 3, 10)
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills)
      if (list.length === 0) return [] as HybridHit[]
      if (!s.bm25) s.bm25 = Bm25Index.build(list)
      const bm25Hits = s.bm25.search(input.query, pool)

      // Candidate pool: BM25 hits, or full corpus capped at `pool` when BM25
      // returns nothing (cold-start semantic fallback).
      const byName = new Map(list.map((sk) => [sk.name, sk]))
      const candidates: Info[] = bm25Hits.length > 0
        ? bm25Hits.map((h) => byName.get(h.skillName)).filter((v): v is Info => v !== undefined)
        : list.slice(0, pool)

      const cosineScores = new Map<string, number>()
      if (input.embedder && candidates.length > 0) {
        try {
          const qVec = input.embedder.embed(input.query)
          if (qVec.length > 0) {
            const texts = candidates.map((c) => `${c.name}\n${c.description}\n${c.content}`)
            const docVecs = input.embedder.embedBatch
              ? input.embedder.embedBatch(texts)
              : texts.map((t) => input.embedder!.embed(t))
            if (docVecs.length === candidates.length) {
              candidates.forEach((skill, i) => {
                const vec = docVecs[i]
                if (!vec) return
                cosineScores.set(skill.name, cosineSimilarity(qVec, vec))
              })
            }
          }
        } catch (err) {
          log.warn("hybrid embedder failed", { err })
        }
      }

      return hybridRank(list, bm25Hits, cosineScores, topK, input.weights)
    })

    const searchRouted = Effect.fn("Skill.searchRouted")(function* (input: {
      query: string
      topK?: number
      kind?: RouterKind
      cosineScores?: ReadonlyMap<string, number>
      utilityTable?: ReadonlyMap<string, number>
    }) {
      const s = yield* InstanceState.get(state)
      const list = Object.values(s.skills)
      if (list.length === 0) return [] as RoutedSkill[]
      if (!s.bm25) s.bm25 = Bm25Index.build(list)
      const cfg = yield* config.get()
      const routerCfg = cfg.skills?.router ?? {}
      const kind = input.kind ?? routerCfg.kind ?? "bm25"
      return buildRoutedRanking({
        skills: list,
        query: input.query,
        bm25: s.bm25,
        cosineScores: input.cosineScores,
        utilityTable: input.utilityTable,
        kind,
        config: {
          utilityWeight: routerCfg.utilityWeight,
          temperature: routerCfg.temperature,
          minScoreThreshold: routerCfg.minScoreThreshold,
          maxCandidates: input.topK ?? routerCfg.maxCandidates,
        },
      })
    })

    return Service.of({ get, all, dirs, available, notifyHotInserted, search, searchHybrid, searchRouted })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  if (list.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...list
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${pathToFileURL(skill.location).href}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...list
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export * as Skill from "."
