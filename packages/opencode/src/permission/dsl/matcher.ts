export * as DSLMatcher from "./matcher"

import type { CompiledPolicy, CompiledRule, ToolInvocation, Action } from "./compiler"

/**
 * Port of `codex-rs/core/src/exec_policy.rs` (857 LOC) decision logic.
 * Given a compiled policy and a tool invocation, produce a `Decision`.
 *
 * Precedence rules (Codex-compatible):
 *   1. Last-matching rule wins (same as the existing opencode Ruleset model).
 *   2. If no rule matches, the decision is `undefined` — callers should fall
 *      back to the existing Ruleset / prompt flow.
 *
 * The `matchMany` API returns every matching rule in source order, for
 * diagnostics (`opencode permission explain` / debug UIs).
 */

export interface Decision {
  readonly action: Action
  readonly rule: CompiledRule
}

export function match(policy: CompiledPolicy, invocation: ToolInvocation): Decision | undefined {
  // Iterate from the end for last-matching-wins without collecting all.
  for (let i = policy.rules.length - 1; i >= 0; i--) {
    const rule = policy.rules[i]
    if (rule.test(invocation)) {
      return { action: rule.action, rule }
    }
  }
  return undefined
}

export function matchMany(policy: CompiledPolicy, invocation: ToolInvocation): ReadonlyArray<CompiledRule> {
  const hits: CompiledRule[] = []
  for (const rule of policy.rules) {
    if (rule.test(invocation)) hits.push(rule)
  }
  return hits
}

/**
 * Summarize a decision for audit logs. Never throws — safe to call in error
 * paths.
 */
export function explain(decision: Decision | undefined, invocation: ToolInvocation): string {
  if (!decision) {
    return `[exec-policy] no DSL rule matched ${invocation.tool}${invocation.command ? ` "${invocation.command}"` : ""}${invocation.path ? ` path=${invocation.path}` : ""}`
  }
  const { action, rule } = decision
  const desc = rule.description ? ` (${rule.description})` : ""
  return `[exec-policy] ${action} via rule #${rule.index}${desc}`
}
