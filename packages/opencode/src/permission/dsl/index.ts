export * as DSL from "./index"

import { parse, stringify, type RawPolicy, type ParseOptions, PolicyParseError } from "./parser"
import { compile, type CompiledPolicy, type ToolInvocation, PolicyCompileError } from "./compiler"
import { match, matchMany, explain, type Decision } from "./matcher"

export type { RawPolicy, RawRule, RawMatch, RawAction } from "./parser"
export type { CompiledRule, CompiledPolicy, ToolInvocation, Action } from "./compiler"
export type { Decision } from "./matcher"
export { PolicyParseError, PolicyCompileError, parse, stringify, compile, match, matchMany, explain }

/** One-shot convenience: parse + compile text. Throws on either error. */
export function load(text: string, options?: ParseOptions): CompiledPolicy {
  const raw = parse(text, options)
  return compile(raw)
}

/**
 * Given a compiled policy and an invocation, return the effective action
 * or `undefined` when the DSL did not match (caller should fall back to
 * the existing Ruleset flow).
 */
export function decide(policy: CompiledPolicy | undefined, invocation: ToolInvocation): Decision | undefined {
  if (!policy) return undefined
  return match(policy, invocation)
}

/** An empty compiled policy — useful as a default. */
export const EMPTY: CompiledPolicy = { version: 1, rules: [] }

/** Parse the DSL source from one of several canonical fallback files. */
export function parseFromSource(text: string, filename: string): RawPolicy {
  const lower = filename.toLowerCase()
  const format: ParseOptions["format"] = lower.endsWith(".yaml") || lower.endsWith(".yml")
    ? "yaml"
    : lower.endsWith(".jsonc") || lower.endsWith(".json") || lower.endsWith(".json5")
      ? "jsonc"
      : "auto"
  return parse(text, { format, source: filename })
}
