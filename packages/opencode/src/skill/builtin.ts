/**
 * Bundled (built-in) skills — starter set shipped with the binary.
 *
 * Port of `codex-rs/core/src/skills/builtin.rs` (36 LOC) which uses the Rust
 * `include_str!` macro to compile SKILL.md files directly into the binary.
 *
 * In TypeScript we can't `include_str!`, so each SKILL.md lives under
 * `src/skill/builtin/<name>/SKILL.md` and we load it at module init via
 * `Bun.file()` relative to `import.meta.dir`. The content is read once per
 * process — subsequent calls return the cached string.
 *
 * # Skills in this bundle (8 total, parity with Rust)
 *
 *   - `bm25-kb-search` — BM25 KB search patterns
 *   - `copilot-account-failover` — account pool + 429 recovery
 *   - `copilot-rate-limit-tuning` — conservative retry strategy
 *   - `docker-cross-build` — musl cross-compile via zig CC
 *   - `fix-rust-compilation` — Rust E0xxx error recipes
 *   - `guardian-approval-routing` — guardian review flow
 *   - `multi-agent-lifecycle` — sub-agent spawn/wait/close/resume
 *   - `upstream-merge-thin-hooks` — fork merge strategy
 *
 * Each skill's content is the *raw* markdown file (including YAML
 * frontmatter). The caller (`skill/index.ts::Skill.Service`) parses it
 * via `ConfigMarkdown.parse` just like any disk-discovered skill.
 *
 * # Disabling the bundle
 *
 * Set `skills.builtin: false` in config (or `OPENCODE_DISABLE_BUILTIN_SKILLS=1`
 * env var) to opt out. Off by default today; flip to on once validation
 * passes.
 */

import path from "path"
import { Flag } from "@/flag/flag"

/** Canonical list of bundled skill names (order = registration order). */
export const BUILTIN_SKILL_NAMES = [
  "bm25-kb-search",
  "copilot-account-failover",
  "copilot-rate-limit-tuning",
  "docker-cross-build",
  "fix-rust-compilation",
  "guardian-approval-routing",
  "multi-agent-lifecycle",
  "upstream-merge-thin-hooks",
] as const

export type BuiltinSkillName = (typeof BUILTIN_SKILL_NAMES)[number]

/**
 * A lazily-resolved builtin skill descriptor. `content` is the raw
 * `SKILL.md` text (frontmatter + body). `location` is a synthetic pseudo
 * path used only for display/logging — it is **not** a real filesystem
 * path the loader should re-scan.
 */
export interface BuiltinSkill {
  readonly name: BuiltinSkillName
  readonly location: string
  readonly content: string
}

const cache = new Map<BuiltinSkillName, BuiltinSkill>()

/**
 * Resolve the on-disk path of a bundled skill's `SKILL.md`. Stays a pure
 * file-path computation so tests can assert exact locations.
 */
export function builtinSkillPath(name: BuiltinSkillName): string {
  return path.join(import.meta.dir, "builtin", name, "SKILL.md")
}

/**
 * Read and cache a single bundled skill. Throws (via the Bun.file error
 * pipeline) when the underlying file is missing — treat that as a
 * compile-time invariant violation, not a runtime condition.
 */
export async function loadBuiltinSkill(name: BuiltinSkillName): Promise<BuiltinSkill> {
  const existing = cache.get(name)
  if (existing) return existing
  const location = builtinSkillPath(name)
  const content = await Bun.file(location).text()
  const entry: BuiltinSkill = { name, location, content }
  cache.set(name, entry)
  return entry
}

/**
 * Read and cache all 8 bundled skills. Safe to call repeatedly — the
 * cache is process-global.
 */
export async function loadAllBuiltinSkills(): Promise<BuiltinSkill[]> {
  const out: BuiltinSkill[] = []
  for (const name of BUILTIN_SKILL_NAMES) {
    out.push(await loadBuiltinSkill(name))
  }
  return out
}

/**
 * Whether the builtin skill pack is enabled for this process. Env var
 * `OPENCODE_DISABLE_BUILTIN_SKILLS=1` takes priority over the config flag
 * so CI / ad-hoc runs can opt out without touching config.
 */
export function builtinSkillsEnabled(configFlag: boolean | undefined): boolean {
  if (Flag.OPENCODE_DISABLE_BUILTIN_SKILLS) return false
  // Default: disabled until the router validates cleanly in user corpora.
  return configFlag === true
}

export * as BuiltinSkills from "./builtin"
