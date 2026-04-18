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
export const migrationFile = path.join(Global.Path.data, "copilot-migration.json")
