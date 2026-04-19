/**
 * Model-tier classification for Copilot account routing.
 *
 * Ported from `codex-rs/core/src/model_tiers.rs` and the secondary-preference
 * predicate in `codex-rs/core/src/thread_manager_fork.rs::should_prefer_secondary_subagent_accounts`.
 *
 * Design note (from Rust): classification uses hardcoded prefix matching
 * rather than loading `models.json` at runtime. This keeps the logic
 * zero-cost and avoids coupling the hot path to the catalog format.
 *
 * Semantics:
 *
 *   - `Top`        : best-in-family (e.g. `gpt-5.4`, `claude-opus-4.6`,
 *                    `gemini-2.5-pro`) — always routes through the primary.
 *   - `Secondary`  : usable fallback (e.g. `gpt-5.3-codex`, `claude-haiku`,
 *                    `gemini-2-pro-preview`) — eligible for backup-first
 *                    routing when the caller is a spawned sub-agent.
 *   - `Unknown`    : not in our classification.
 *
 * The `shouldPreferSecondarySubagentAccounts` predicate combines the tier
 * classification with a requested/parent model comparison: a sub-agent is
 * routed to backup accounts only when it *diverges from* the parent thread's
 * model **and** the requested model is `Secondary` tier. This keeps the
 * main interactive account free for foreground dispatches while ensuring
 * Top-tier sub-agent fan-out (e.g. claude-opus planning Opus threads) still
 * uses the account the user expects.
 */

export type ModelTier = "Top" | "Secondary" | "Unknown"

/**
 * Classify a model slug into a {@link ModelTier}. Mirrors Rust
 * `core/src/model_tiers.rs::classify_model`.
 */
export function classifyModel(slug: string): ModelTier {
  if (!slug) return "Unknown"
  // Top tier — latest flagship per family.
  if (
    slug.startsWith("gpt-5.4") ||
    slug.startsWith("claude-opus-4") ||
    slug.startsWith("claude-sonnet-4") ||
    slug.startsWith("gemini-2.5") ||
    slug.startsWith("gemini-3")
  ) {
    return "Top"
  }
  // Secondary — older/smaller but still capable.
  if (
    slug.startsWith("gpt-5.3") ||
    slug.startsWith("gpt-5.2") ||
    slug.startsWith("gpt-5.1") ||
    slug.startsWith("gpt-5-codex") ||
    slug.startsWith("gpt-5-mini") ||
    slug === "gpt-5" ||
    slug.startsWith("codex-5") ||
    slug.startsWith("claude-haiku") ||
    slug.startsWith("gemini-2") ||
    slug.startsWith("gpt-oss")
  ) {
    return "Secondary"
  }
  return "Unknown"
}

/**
 * Given a list of model slugs an account supports, return the best tier
 * attainable. Mirrors Rust `best_tier_for_account`.
 */
export function bestTierForAccount(models: readonly string[]): ModelTier {
  if (models.length === 0) return "Unknown"
  let best: ModelTier = "Unknown"
  const rank = (tier: ModelTier): number => (tier === "Top" ? 0 : tier === "Secondary" ? 1 : 2)
  for (const model of models) {
    const tier = classifyModel(model)
    if (rank(tier) < rank(best)) best = tier
  }
  return best
}

/** Filter a model list to just the Top-tier slugs. Mirrors Rust `top_tier_models`. */
export function topTierModels(models: readonly string[]): string[] {
  return models.filter((model) => classifyModel(model) === "Top")
}

/**
 * `true` when a sub-agent should be routed to secondary/backup accounts
 * instead of the primary pool entry.
 *
 * Mirrors Rust `thread_manager_fork.rs::should_prefer_secondary_subagent_accounts`
 * (`lines 26-38`). The heuristic is intentionally narrow: the sub-agent must
 * request a *different* model from its parent **and** that model must be
 * classified as {@link ModelTier.Secondary}. Without both conditions the
 * spawned thread stays on the same account as the parent so the user's
 * foreground session keeps its chosen account.
 *
 * Returns `false` when either model is missing/empty — mirroring the
 * Rust early-return `filter(|m| !m.is_empty())` short-circuits.
 */
export function shouldPreferSecondarySubagentAccounts(
  requestedModel: string | undefined | null,
  parentModel: string | undefined | null,
): boolean {
  if (!requestedModel) return false
  if (!parentModel) return false
  if (requestedModel === parentModel) return false
  return classifyModel(requestedModel) === "Secondary"
}
