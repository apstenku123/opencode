import {
  codedashProfileFile,
  forgeCredentialFile,
  githubCopilotAppsFile,
  githubCopilotOAuthFile,
  legacyCredentialFile,
  macOSAppSupportAuthFile,
  migrationFile,
} from "./paths"
import { Auth } from "@/auth"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Effect } from "effect"

export type CopilotAuth = {
  key: string
  label: string
  refresh: string
  access: string
  expires: number
  accountId?: string
  enterpriseUrl?: string
  proxyUrl?: string
  proxyToken?: string
}

export function label(key: string) {
  if (key == "github-copilot") return "Primary"
  return key.replace(/^github-copilot#/, "")
}

export function auth(value: Auth.Info | undefined, key: string) {
  if (!value) return
  if (value.type !== "oauth") return
  if (!key.startsWith("github-copilot")) return
  return {
    key,
    label: label(key),
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
    accountId: value.accountId,
    enterpriseUrl: value.enterpriseUrl,
  } satisfies CopilotAuth
}

export function list(all: Record<string, Auth.Info>) {
  return Object.entries(all)
    .flatMap(([key, value]) => {
      const item = auth(value, key)
      return item ? [item] : []
    })
    .sort((a, b) => {
      if (a.key === "github-copilot") return -1
      if (b.key === "github-copilot") return 1
      return a.key.localeCompare(b.key)
    })
}


function extractOne(item: Record<string, unknown>, key: string): CopilotAuth | null {
  const refresh = typeof item.token === "string" ? item.token : typeof item.refresh_token === "string" ? item.refresh_token : undefined
  const access = typeof item.token === "string" ? item.token : typeof item.access_token === "string" ? item.access_token : refresh
  if (!refresh || !access) return null
  const plan = typeof item.plan === "string" ? item.plan : undefined
  const login = typeof item.user === "string" ? item.user : typeof item.login === "string" ? item.login : undefined
  const enterpriseUrl = typeof item.enterprise_uri === "string" ? item.enterprise_uri : typeof item.enterpriseUrl === "string" ? item.enterpriseUrl : undefined
  const proxyUrl = typeof item.proxy_url === "string" ? item.proxy_url : typeof item.proxyUrl === "string" ? item.proxyUrl : undefined
  const proxyToken = typeof item.proxy_token === "string" ? item.proxy_token : typeof item.proxyToken === "string" ? item.proxyToken : undefined
  const suffix = plan === "enterprise" ? "#enterprise" : plan === "edu" ? "#edu" : plan === "free" || plan === "personal" ? "#free" : key === "github.com" ? "" : key === "" ? "#cli" : `#${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
  return {
    key: `github-copilot${suffix}`,
    label: login ?? label(`github-copilot${suffix}`),
    refresh,
    access,
    expires: 0,
    enterpriseUrl,
    proxyUrl,
    proxyToken,
  }
}

export function legacy(raw: unknown): CopilotAuth[] {
  if (!raw || typeof raw !== "object") return []
  const data = raw as Record<string, unknown>
  // Flat single-credential form — ~/.copilot/auth/credential.json is
  // `{token, login, stored_at, proxy_url?, proxy_token?}` with no outer
  // key. Detect by presence of a top-level `token` string.
  if (typeof data.token === "string") {
    const one = extractOne(data, "")
    return one ? [one] : []
  }
  // Keyed form — `{"github.com": {...}, "enterprise.example.com": {...}}`.
  const items = Object.entries(data).flatMap(([key, value]) => {
    if (!value || typeof value !== "object") return []
    const one = extractOne(value as Record<string, unknown>, key)
    return one ? [one] : []
  })
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.key)) return false
    seen.add(item.key)
    return true
  })
}

/**
 * Parse `~/.config/github-copilot/apps.json` — the VS Code / Neovim
 * Copilot multiplexer, keyed by `"<host>:<githubAppId>"`. Each slot
 * carries its own `oauth_token`, so a user with multiple App IDs
 * (extension vs LSP vs CLI) registers as distinct `github-copilot#<slug>`
 * keys.  Mirrors codex_git's auth discovery surface for multiplexed
 * Copilot setups.
 */
export function apps(raw: unknown): CopilotAuth[] {
  if (!raw || typeof raw !== "object") return []
  const data = raw as Record<string, unknown>
  const items: CopilotAuth[] = []
  for (const [compound, value] of Object.entries(data)) {
    if (!value || typeof value !== "object") continue
    const item = value as Record<string, unknown>
    const token = typeof item.oauth_token === "string" ? item.oauth_token : undefined
    if (!token) continue
    const user = typeof item.user === "string" ? item.user : undefined
    const appId = typeof item.githubAppId === "string" ? item.githubAppId : undefined
    // Compound key form: `"github.com:Iv23ctfURkiMfJ4xr5mv"`. The App ID
    // is the salient discriminator — different App IDs serve different
    // Copilot scopes on the same GitHub account. Fall back to the raw
    // compound key when neither is usable.
    const slug = appId
      ? appId.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16)
      : compound.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16)
    const key = `github-copilot#app-${slug}`
    items.push({
      key,
      label: user ?? label(key),
      refresh: token,
      access: token,
      expires: 0,
    })
  }
  return items
}

/**
 * Parse `~/.config/github-copilot/oauth.json` — the classic single-entry
 * OAuth log-in store, keyed by `"<login-url>"` with an array of sessions.
 * Each session gets its own account slot so re-logins accumulate rather
 * than overwrite.
 */
export function oauth(raw: unknown): CopilotAuth[] {
  if (!raw || typeof raw !== "object") return []
  const data = raw as Record<string, unknown>
  const items: CopilotAuth[] = []
  for (const [_host, value] of Object.entries(data)) {
    if (!Array.isArray(value)) continue
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const token = typeof e.accessToken === "string" ? e.accessToken : undefined
      if (!token) continue
      const account = (e.account && typeof e.account === "object") ? (e.account as Record<string, unknown>) : {}
      const user = typeof account.label === "string" ? account.label : undefined
      const id = typeof account.id === "string" ? account.id : typeof e.id === "string" ? e.id : undefined
      const slug = id
        ? id.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16)
        : "oauth"
      const key = `github-copilot#oauth-${slug}`
      items.push({
        key,
        label: user ?? label(key),
        refresh: token,
        access: token,
        expires: 0,
      })
    }
  }
  return items
}

/**
 * Parse an opencode-native `auth.json` shape — keys are already
 * `github-copilot[#suffix]` and values are `{type, refresh, access,
 * expires, proxy_url?, proxy_token?}`. Used for the macOS Application
 * Support auth store which preserves the user's original key names
 * (e.g. `github-copilot#edu-1` through `#edu-7`).
 */
export function opencodeNative(raw: unknown): CopilotAuth[] {
  if (!raw || typeof raw !== "object") return []
  const data = raw as Record<string, unknown>
  const items: CopilotAuth[] = []
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith("github-copilot")) continue
    if (!value || typeof value !== "object") continue
    const e = value as Record<string, unknown>
    if (e.type !== "oauth") continue
    const refresh = typeof e.refresh === "string" ? e.refresh : undefined
    const access = typeof e.access === "string" ? e.access : refresh
    if (!refresh || !access) continue
    const proxyUrl = typeof e.proxy_url === "string" ? e.proxy_url : typeof e.proxyUrl === "string" ? e.proxyUrl : undefined
    const proxyToken = typeof e.proxy_token === "string" ? e.proxy_token : typeof e.proxyToken === "string" ? e.proxyToken : undefined
    const enterpriseUrl = typeof e.enterpriseUrl === "string" ? e.enterpriseUrl : typeof e.enterprise_uri === "string" ? e.enterprise_uri : undefined
    items.push({
      key,
      label: label(key),
      refresh,
      access,
      expires: typeof e.expires === "number" ? e.expires : 0,
      enterpriseUrl,
      proxyUrl,
      proxyToken,
    })
  }
  return items
}

/**
 * Parse `~/forge/.credentials.json` — the Forge CLI credential store.
 * Array of `{id, auth_details: {o_auth_with_api_key: {tokens: {access_token}}}}`
 * entries. Each `github_copilot` entry becomes its own
 * `github-copilot#forge-<prefix>` slot so distinct Copilot App IDs used
 * by Forge (different from VS Code / CLI / multiplexer) register as
 * separate pool accounts.
 */
export function forge(raw: unknown): CopilotAuth[] {
  if (!Array.isArray(raw)) return []
  const items: CopilotAuth[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    if (e.id !== "github_copilot") continue
    const auth = (e.auth_details && typeof e.auth_details === "object") ? (e.auth_details as Record<string, unknown>) : {}
    const ooauth = (auth.o_auth_with_api_key && typeof auth.o_auth_with_api_key === "object")
      ? (auth.o_auth_with_api_key as Record<string, unknown>)
      : {}
    const tokens = (ooauth.tokens && typeof ooauth.tokens === "object") ? (ooauth.tokens as Record<string, unknown>) : {}
    const access = typeof tokens.access_token === "string" ? tokens.access_token : undefined
    if (!access) continue
    // Use first 8 chars of the token as the slug — good enough to
    // disambiguate when multiple forge creds are stored.
    const slug = access.replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(0, 8) || "default"
    const key = `github-copilot#forge-${slug}`
    items.push({
      key,
      label: label(key),
      refresh: access,
      access,
      expires: 0,
    })
  }
  return items
}

/**
 * Parse `~/.codedash/github-profile.json` — single-GitHub-user store
 * with `{username, token}`. Registers as `github-copilot#codedash-<user>`.
 */
export function codedash(raw: unknown): CopilotAuth[] {
  if (!raw || typeof raw !== "object") return []
  const data = raw as Record<string, unknown>
  const token = typeof data.token === "string" ? data.token : undefined
  if (!token) return []
  const user = typeof data.username === "string" ? data.username : undefined
  const slug = user ? user.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 16) : "default"
  const key = `github-copilot#codedash-${slug}`
  return [{
    key,
    label: user ?? label(key),
    refresh: token,
    access: token,
    expires: 0,
  }]
}

/**
 * Transient map populated by `migrate()` with proxy metadata from
 * `~/.copilot/auth/credential.json`. `Auth.Info` has no proxy fields
 * (proxy lives on Conn in `copilot-connections.json`), so downstream
 * code drains this map to upsert the proxy + envelope flag into state.
 */
export const proxyImports = new Map<string, { url: string; token?: string }>()

export const migrate = Effect.fn("CopilotAuth.migrate")(function* (src?: MigrationIO) {
  const fs = src ?? (yield* io())
  const auth = yield* Auth.Service
  const existing = yield* auth.all()
  const existingKeys = new Set(Object.keys(existing).filter((k) => k.startsWith("github-copilot")))
  const raw = yield* fs.read(fs.legacy).pipe(Effect.orElseSucceed(() => ({})))
  const rawApps = yield* fs.read(fs.apps).pipe(Effect.orElseSucceed(() => ({})))
  const rawOauth = yield* fs.read(fs.oauth).pipe(Effect.orElseSucceed(() => ({})))
  const rawForge = yield* fs.read(fs.forge).pipe(Effect.orElseSucceed(() => [] as unknown))
  const rawCodedash = yield* fs.read(fs.codedash).pipe(Effect.orElseSucceed(() => ({})))
  const rawMacAS = yield* fs.read(fs.macOSAppSupport).pipe(Effect.orElseSucceed(() => ({})))
  // Merge all six on-disk sources plus env-supplied test tokens. Dedup by
  // final `key`; macOS Application Support opencode auth.json is parsed
  // via `opencodeNative` (keyed `{"github-copilot#edu-N": {type,refresh,
  // access,proxy_url}}` format) and wins for those namespaced keys.
  const envTests = testTokensFromEnv(process.env.OPENCODE_TEST_COPILOT_TOKENS)
  // Primary sources — always imported. Mirrors codex_git's
  // `CopilotAuth::load()` cascade (`~/Library/Application Support/opencode/auth.json`
  // on macOS → `~/.copilot/auth/credential.json`).
  const primary = [
    ...opencodeNative(rawMacAS),
    ...legacy(raw),
  ]
  // Secondary IDE/tool stores — opt-in via
  // `OPENCODE_IMPORT_ALL_COPILOT_TOKENS=1`. These mine tokens from
  // every plausible on-disk location (VS Code apps.json, Neovim
  // oauth.json, Forge credentials, Codedash profile); when the user's
  // canonical auth.json is already complete, they cause spurious dup
  // slots, so we keep them behind a flag.
  const extras = process.env.OPENCODE_IMPORT_ALL_COPILOT_TOKENS === "1"
    ? [
        ...apps(rawApps),
        ...oauth(rawOauth),
        ...forge(rawForge),
        ...codedash(rawCodedash),
      ]
    : []
  const allFound = [...primary, ...extras, ...envTests]
  // Dedup on two axes:
  //   1. By final `key` (keeping the first-seen source — so macOS
  //      Application Support wins over `~/.copilot/auth/credential.json`
  //      for the same key since it's listed first in `allFound`).
  //   2. By raw `refresh` token — if the same OAuth token is present
  //      under a different key in a later source (e.g. the
  //      `~/.copilot/auth/credential.json` flat form maps to
  //      `github-copilot#cli`, but the same token already landed as
  //      `github-copilot` via macOS auth.json), skip the duplicate so
  //      `providers accounts` doesn't render the same physical account
  //      under two different slot names.
  const seenKeys = new Set<string>()
  const seenTokens = new Set<string>()
  const uniq: CopilotAuth[] = []
  for (const item of allFound) {
    if (seenKeys.has(item.key)) continue
    if (seenTokens.has(item.refresh)) continue
    seenKeys.add(item.key)
    seenTokens.add(item.refresh)
    uniq.push(item)
  }
  const items = uniq.filter((item) => !existingKeys.has(item.key))
  // Append, never overwrite: if legacy drops a credential we already have
  // under the same key, prefer the opencode-native one. Re-runs safely on
  // every CLI/plugin boot so edu/GCP-proxy accounts added to
  // ~/.copilot/auth/credential.json AFTER the initial migration still
  // land in opencode.
  for (const item of items) {
    yield* auth.set(item.key, {
      type: "oauth",
      refresh: item.refresh,
      access: item.access,
      expires: item.expires,
      accountId: item.key,
      enterpriseUrl: item.enterpriseUrl,
    })
  }
  // Stash proxy metadata (not on Auth.Info) for downstream upsert into
  // copilot-connections.json. All legacy entries are considered — not
  // just newly-added — so proxy rotations in the legacy file propagate.
  for (const item of uniq) {
    if (item.proxyUrl) proxyImports.set(item.key, { url: item.proxyUrl, token: item.proxyToken })
  }
  const prior = yield* readMigration(fs)
  const mergedKeys = [...new Set([...prior.keys, ...items.map((item) => item.key)])]
  const next = {
    version: 1,
    migratedAt: items.length > 0 ? Date.now() : prior.migratedAt,
    source: items.length > 0 ? fs.legacy : prior.source,
    keys: mergedKeys,
    skipped: items.length === 0 && existingKeys.size > 0,
  } satisfies MigrationState
  yield* writeMigration(next, fs)
  outcome.last = next
  return next
})


export type MigrationState = {
  version: number
  migratedAt?: number
  source?: string
  keys: string[]
  skipped?: boolean
}

export const migration = {
  empty(): MigrationState {
    return { version: 1, keys: [] }
  },
  parse(raw: unknown): MigrationState {
    if (!raw || typeof raw !== "object") return migration.empty()
    const item = raw as Partial<MigrationState>
    return {
      version: 1,
      migratedAt: typeof item.migratedAt === "number" ? item.migratedAt : undefined,
      source: typeof item.source === "string" ? item.source : undefined,
      keys: Array.isArray(item.keys) ? item.keys.filter((x): x is string => typeof x === "string") : [],
      skipped: typeof item.skipped === "boolean" ? item.skipped : undefined,
    }
  },
}

export type MigrationIO = {
  legacy: string
  apps: string
  oauth: string
  forge: string
  codedash: string
  macOSAppSupport: string
  marker: string
  read(path: string): Effect.Effect<unknown, unknown>
  write(path: string, value: unknown): Effect.Effect<void, unknown>
}

export function io(): Effect.Effect<MigrationIO, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      legacy: legacyCredentialFile,
      apps: githubCopilotAppsFile,
      oauth: githubCopilotOAuthFile,
      forge: forgeCredentialFile,
      codedash: codedashProfileFile,
      macOSAppSupport: macOSAppSupportAuthFile,
      marker: migrationFile,
      read(path: string) {
        return fs.readJson(path)
      },
      write(path: string, value: unknown) {
        return fs.writeJson(path, value, 0o600)
      },
    } satisfies MigrationIO
  })
}

export const outcome = {
  last: migration.empty() as MigrationState,
}

export const readMigration = Effect.fn("CopilotAuth.readMigration")(function* (src?: MigrationIO) {
  const fs = src ?? (yield* io())
  const raw = yield* fs.read(fs.marker).pipe(Effect.orElseSucceed(() => migration.empty()))
  return migration.parse(raw)
})

export const writeMigration = Effect.fn("CopilotAuth.writeMigration")(function* (state: MigrationState, src?: MigrationIO) {
  const fs = src ?? (yield* io())
  yield* fs.write(fs.marker, state)
})


/**
 * Parse a comma-separated list of Copilot tokens (from the
 * `OPENCODE_TEST_COPILOT_TOKENS` env var, mirroring codex_git's
 * `CODEX_TEST_COPILOT_TOKENS`) into synthetic test-slot credentials with
 * keys `github-copilot#edu-N`. These are registered under the edu pool
 * so they only route for xhigh test-only models and stay hidden from
 * the production TUI.
 */
export function testTokensFromEnv(raw: string | undefined): CopilotAuth[] {
  if (!raw) return []
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token, i) => {
      const key = `github-copilot#edu-${i + 1}`
      return {
        key,
        label: label(key),
        refresh: token,
        access: token,
        expires: 0,
      } satisfies CopilotAuth
    })
}

/**
 * Extract synthetic test-slot credentials from the opencode
 * `copilot.testAccounts` config section (mirrors codex_git's
 * `[test_accounts]` TOML section — see
 * `codex-rs/core/src/config/types.rs::TestAccountsToml`). Labels +
 * proxy URLs are index-matched with tokens; a missing entry falls back
 * to the synthetic `edu-N` key/label.
 */
export function testAccountsFromConfig(input?: {
  tokens?: readonly string[]
  labels?: readonly string[]
  proxyUrls?: readonly string[]
}): CopilotAuth[] {
  if (!input?.tokens || input.tokens.length === 0) return []
  return input.tokens.map((token, i) => {
    const customLabel = input.labels?.[i]?.trim()
    const slug = customLabel
      ? customLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 24)
      : `${i + 1}`
    const key = `github-copilot#edu-${slug}`
    const proxyUrl = input.proxyUrls?.[i]?.trim()
    return {
      key,
      label: customLabel || label(key),
      refresh: token,
      access: token,
      expires: 0,
      ...(proxyUrl ? { proxyUrl } : {}),
    } satisfies CopilotAuth
  })
}

export function summarizeMigration(state: MigrationState) {
  return {
    migrated: state.keys.length,
    skipped: !!state.skipped,
    source: state.source,
    migratedAt: state.migratedAt,
    text: state.keys.length > 0
      ? `migrated ${state.keys.length} legacy Copilot account${state.keys.length === 1 ? "" : "s"}`
      : state.skipped
        ? "skipped migration, new auth already existed"
        : "no legacy Copilot accounts migrated",
  }
}
