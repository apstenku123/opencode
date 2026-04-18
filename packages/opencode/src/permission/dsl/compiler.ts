export * as DSLCompiler from "./compiler"

import { minimatch } from "minimatch"
import { Wildcard } from "@/util"
import type { RawMatch, RawPolicy, RawRule, RawAction } from "./parser"

/**
 * Port of `codex-rs/execpolicy/src/rule.rs` + `policy.rs` (~680 LOC).
 * Compiles a `RawPolicy` into `CompiledRule`s with pre-built matchers so
 * every tool invocation is cheap at check time.
 *
 * Safety: we guard user-provided regexes against catastrophic backtracking
 * by rejecting `.*.*`-style unbounded patterns at compile time and by
 * running every regex under a per-match character budget. See `safeRegex`.
 */

export class PolicyCompileError extends Error {
  readonly rule: number
  constructor(message: string, rule: number) {
    super(`[exec-policy] ${message} (rule index: ${rule})`)
    this.name = "PolicyCompileError"
    this.rule = rule
  }
}

export type Action = RawAction

export interface CompiledRule {
  /** 0-based index in the source policy, for diagnostics + precedence ties. */
  readonly index: number
  readonly action: Action
  readonly description?: string
  /**
   * Test whether a tool invocation matches this rule. Returns true on match.
   */
  readonly test: (inv: ToolInvocation) => boolean
}

export interface CompiledPolicy {
  readonly version: number
  readonly rules: ReadonlyArray<CompiledRule>
}

export interface ToolInvocation {
  /** Tool name (bash, edit, write, read, webfetch, ...). */
  readonly tool: string
  /** For bash: the command string. */
  readonly command?: string
  /** For edit/read/write: the target path (absolute when possible). */
  readonly path?: string
  /** Current working directory at invocation time. */
  readonly cwd?: string
}

// --- helpers -------------------------------------------------------------

/** Absolute-path-ish: either starts with `/` or matches a Windows drive. */
function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)
}

/**
 * Build a RegExp from a user pattern with basic ReDoS guards. Patterns that
 * contain two unbounded quantifiers in a row (`.*.*`, `.+.+`, `.*.+` …) are
 * rejected. The compiled regex is wrapped so it applies only to strings up
 * to `MAX_TEST_INPUT` bytes; longer inputs short-circuit to `false`.
 */
const MAX_TEST_INPUT = 8 * 1024

function safeRegex(source: string, flags: string, context: string, ruleIdx: number): (input: string) => boolean {
  const unbounded = /\.[*+][^?]?.*\.[*+]/
  if (unbounded.test(source)) {
    throw new PolicyCompileError(
      `${context} regex rejected (looks like a ReDoS catastrophic-backtracking shape): ${source}`,
      ruleIdx,
    )
  }
  let re: RegExp
  try {
    re = new RegExp(source, flags)
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    throw new PolicyCompileError(`${context} regex invalid: ${msg} (pattern: ${source})`, ruleIdx)
  }
  return (input: string) => {
    if (input.length > MAX_TEST_INPUT) return false
    return re.test(input)
  }
}

function matchGlob(pattern: string, input: string): boolean {
  // minimatch for path-style globs. For broader "bash-command"-style globs we
  // also fall back to our own Wildcard matcher which treats " *" specially.
  if (minimatch(input, pattern, { dot: true })) return true
  return Wildcard.match(input, pattern)
}

// --- per-field predicate builders ---------------------------------------

type Predicate = (inv: ToolInvocation) => boolean

function buildToolPred(spec: RawMatch): Predicate {
  if (!spec.tool) return () => true
  const pattern = spec.tool
  return (inv) => Wildcard.match(inv.tool, pattern)
}

function buildCommandPred(spec: RawMatch, idx: number): Predicate {
  if (spec.command) {
    const pattern = spec.command
    return (inv) => (inv.command !== undefined ? matchGlob(pattern, inv.command) : false)
  }
  if (spec.command_regex) {
    const test = safeRegex(spec.command_regex, "s", "match.command_regex", idx)
    return (inv) => (inv.command !== undefined ? test(inv.command) : false)
  }
  return () => true
}

function buildPathPred(spec: RawMatch, idx: number): Predicate {
  if (spec.path) {
    const pattern = spec.path
    return (inv) => (inv.path !== undefined ? matchGlob(pattern, inv.path) : false)
  }
  if (spec.path_regex) {
    const test = safeRegex(spec.path_regex, "s", "match.path_regex", idx)
    return (inv) => (inv.path !== undefined ? test(inv.path) : false)
  }
  return () => true
}

function buildCwdPred(spec: RawMatch, idx: number): Predicate {
  if (!spec.cwd_under) return () => true
  const prefix = spec.cwd_under
  if (!isAbsolute(prefix)) {
    throw new PolicyCompileError(`match.cwd_under must be an absolute path, got ${JSON.stringify(prefix)}`, idx)
  }
  const norm = prefix.replaceAll("\\", "/").replace(/\/+$/, "")
  return (inv) => {
    if (!inv.cwd) return false
    const cwd = inv.cwd.replaceAll("\\", "/").replace(/\/+$/, "")
    return cwd === norm || cwd.startsWith(norm + "/")
  }
}

function compileRule(raw: RawRule, idx: number): CompiledRule {
  const tool = buildToolPred(raw.match)
  const cmd = buildCommandPred(raw.match, idx)
  const path = buildPathPred(raw.match, idx)
  const cwd = buildCwdPred(raw.match, idx)
  // require at least one discriminator other than tool — a rule whose only
  // content is `{tool: bash, action: deny}` would outright kill bash; we
  // want that, but it should be explicit. To keep the AST faithful we DO
  // allow tool-only rules; the constraint below only rejects truly-empty
  // match blocks.
  if (!raw.match.tool && !raw.match.command && !raw.match.command_regex && !raw.match.path && !raw.match.path_regex && !raw.match.cwd_under) {
    throw new PolicyCompileError(`match block is empty; at least one discriminator is required`, idx)
  }
  return {
    index: idx,
    action: raw.action,
    description: raw.match.description,
    test: (inv) => tool(inv) && cmd(inv) && path(inv) && cwd(inv),
  }
}

/** Compile a raw policy into an executable `CompiledPolicy`. */
export function compile(policy: RawPolicy): CompiledPolicy {
  const rules = policy.rules.map((r, i) => compileRule(r, i))
  return { version: policy.version, rules }
}
