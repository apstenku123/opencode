/**
 * GitHub Copilot integration modules.
 *
 * Provides full Copilot CLI protocol compatibility including:
 * - Multi-account connection management with round-robin failover
 * - Adaptive rate limiting with 429 detection and backoff
 * - Quota tracking from API and response headers
 * - Model catalog discovery with plan-based filtering
 * - Persistent machine/session ID tracking
 */

export { CopilotAuthPlugin } from "./copilot"
export { getCopilotSessionId, getCopilotMachineId } from "./copilot-ids"
export { CopilotConnectionManager } from "./copilot-connections"
export type { ConnectionState, ResolvedConnection } from "./copilot-connections"
export { CopilotRateLimiter, getCopilotRateLimiter } from "./copilot-rate-limiter"
export {
  fetchCopilotQuota,
  parseQuotaHeaders,
  selectBestToken,
  formatQuotaBar,
} from "./copilot-quota"
export type { PremiumQuota, CopilotQuotaInfo } from "./copilot-quota"
export {
  fetchModelCatalog,
  fetchModelCatalogWithDiscovery,
  getBestModelByFamily,
  getBestOverallModel,
  getCachedModelCatalog,
  KNOWN_COPILOT_MODELS,
} from "./copilot-models"
export type { CopilotModelInfo, CopilotModelCatalog } from "./copilot-models"
