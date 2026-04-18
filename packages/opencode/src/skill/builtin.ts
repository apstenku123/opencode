/**
 * Bundled (built-in) skills — starter set shipped with the binary.
 *
 * Port of `codex-rs/core/src/skills/builtin.rs` (36 LOC) which uses the Rust
 * `include_str!` macro to compile SKILL.md files directly into the binary.
 *
 * In TypeScript + Bun's single-exec bundle we use import attributes with
 * the `text` type so Bun inlines each SKILL.md's UTF-8 content as a string
 * at compile time. This matches Rust's `include_str!` — no runtime `fs`
 * access, no reliance on `import.meta.dir`, works identically in dev (`bun
 * run`) and in the single-exec binary (`/$bunfs/root/...`).
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

// Inline each SKILL.md at bundle time. Bun's `text` import attribute reads
// the file during the build and embeds the UTF-8 bytes as a string — the
// same mechanism used by `codex-rs` via `include_str!`. No runtime fs access.
import bm25KbSearch from "./builtin/bm25-kb-search/SKILL.md" with { type: "text" }
import copilotAccountFailover from "./builtin/copilot-account-failover/SKILL.md" with { type: "text" }
import copilotRateLimitTuning from "./builtin/copilot-rate-limit-tuning/SKILL.md" with { type: "text" }
import dockerCrossBuild from "./builtin/docker-cross-build/SKILL.md" with { type: "text" }
import fixRustCompilation from "./builtin/fix-rust-compilation/SKILL.md" with { type: "text" }
import guardianApprovalRouting from "./builtin/guardian-approval-routing/SKILL.md" with { type: "text" }
import multiAgentLifecycle from "./builtin/multi-agent-lifecycle/SKILL.md" with { type: "text" }
import upstreamMergeThinHooks from "./builtin/upstream-merge-thin-hooks/SKILL.md" with { type: "text" }

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

/** Bundle-embedded raw markdown keyed by canonical skill name. */
const BUILTIN_SKILL_CONTENT: Record<BuiltinSkillName, string> = {
  "bm25-kb-search": bm25KbSearch,
  "copilot-account-failover": copilotAccountFailover,
  "copilot-rate-limit-tuning": copilotRateLimitTuning,
  "docker-cross-build": dockerCrossBuild,
  "fix-rust-compilation": fixRustCompilation,
  "guardian-approval-routing": guardianApprovalRouting,
  "multi-agent-lifecycle": multiAgentLifecycle,
  "upstream-merge-thin-hooks": upstreamMergeThinHooks,
}

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
 * Resolve the on-disk path of a bundled skill's `SKILL.md`. In the bundled
 * binary this path is synthetic (under `/$bunfs/root`) and exists only for
 * display/logging. Never open it with `fs` — use {@link loadBuiltinSkill}
 * instead, which returns the inlined text.
 */
export function builtinSkillPath(name: BuiltinSkillName): string {
  return path.join(import.meta.dir, "builtin", name, "SKILL.md")
}

/**
 * Resolve a single bundled skill from the inlined content table. Cached
 * after first lookup so repeated calls are free.
 */
export async function loadBuiltinSkill(name: BuiltinSkillName): Promise<BuiltinSkill> {
  const existing = cache.get(name)
  if (existing) return existing
  const location = builtinSkillPath(name)
  const content = BUILTIN_SKILL_CONTENT[name]
  if (typeof content !== "string" || content.length === 0) {
    throw new Error(`builtin skill "${name}" has no inlined content`)
  }
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
