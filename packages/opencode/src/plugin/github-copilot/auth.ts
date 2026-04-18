import { legacyCredentialFile, migrationFile } from "./paths"
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
  const allFound = legacy(raw)
  const items = allFound.filter((item) => !existingKeys.has(item.key))
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
  for (const item of allFound) {
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
  marker: string
  read(path: string): Effect.Effect<unknown, unknown>
  write(path: string, value: unknown): Effect.Effect<void, unknown>
}

export function io(): Effect.Effect<MigrationIO, never, AppFileSystem.Service> {
  return Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    return {
      legacy: legacyCredentialFile,
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
