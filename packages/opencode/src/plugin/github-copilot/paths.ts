import path from "path"
import { Global } from "@/global"

export const connectionFile = path.join(Global.Path.data, "copilot-connections.json")

export const legacyCredentialFile = path.join(Global.Path.home, ".copilot", "auth", "credential.json")
/**
 * VS Code / Neovim Copilot multiplexer apps.json — stores per-App-ID
 * OAuth tokens. Mirrors the Rust CLI's secondary import source; each
 * `githubAppId` slot becomes its own `github-copilot#<slug>` key so
 * enterprise multiplexers with multiple Apps register as distinct pool
 * accounts.
 */
export const githubCopilotAppsFile = path.join(Global.Path.home, ".config", "github-copilot", "apps.json")
/**
 * Classic Copilot CLI oauth.json (the `{host: [{accessToken, account}]}`
 * shape). Complements apps.json — some setups have one but not the
 * other.
 */
export const githubCopilotOAuthFile = path.join(Global.Path.home, ".config", "github-copilot", "oauth.json")
/**
 * Forge CLI credential store — `~/forge/.credentials.json`. Stores an
 * array of `{id, auth_details}` entries; `id: "github_copilot"` entries
 * carry an access token + optional enterprise `api_key` SKU in
 * `auth_details.o_auth_with_api_key.tokens.access_token`.
 */
export const forgeCredentialFile = path.join(Global.Path.home, "forge", ".credentials.json")
/**
 * Codedash profile — `~/.codedash/github-profile.json`. Single-GitHub
 * user shape with `{username, token}`. Not per-app, but useful when the
 * user has authenticated codedash against a distinct account that's not
 * in the other stores.
 */
export const codedashProfileFile = path.join(Global.Path.home, ".codedash", "github-profile.json")
/**
 * macOS opencode auth store under Apple's Application Support
 * convention: `~/Library/Application Support/opencode/auth.json`. On
 * macOS opencode can be configured to use either XDG (`$XDG_DATA_HOME`)
 * or Apple's native dir; this path lets us pick up accounts stashed
 * under the non-XDG location so `providers accounts` surfaces every
 * Copilot credential the user actually has — in particular the 7
 * edu/test slots registered under this store.
 */
export const macOSAppSupportAuthFile = path.join(
  Global.Path.home,
  "Library",
  "Application Support",
  "opencode",
  "auth.json",
)
export const migrationFile = path.join(Global.Path.data, "copilot-migration.json")
/**
 * SQLite file where `CopilotRateLimiter` / `AccountPool` persist per-account
 * rate-limit state (cooldown deadlines, headerless-429 escalator counter,
 * `last429At`). Exposed separately so the `providers stats` CLI and the
 * `/copilot/stats` HTTP endpoint can read it without duplicating the literal.
 */
export const rateStateFile = path.join(Global.Path.data, "copilot-rate-state.sqlite")
