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


export function legacy(raw: unknown): CopilotAuth[] {
  if (!raw || typeof raw !== "object") return []
  const data = raw as Record<string, unknown>
  const items = Object.entries(data).flatMap(([key, value]) => {
    if (!value || typeof value !== "object") return []
    const item = value as Record<string, unknown>
    const refresh = typeof item.token === "string" ? item.token : typeof item.refresh_token === "string" ? item.refresh_token : undefined
    const access = typeof item.token === "string" ? item.token : typeof item.access_token === "string" ? item.access_token : refresh
    if (!refresh || !access) return []
    const plan = typeof item.plan === "string" ? item.plan : undefined
    const login = typeof item.user === "string" ? item.user : typeof item.login === "string" ? item.login : undefined
    const enterpriseUrl = typeof item.enterprise_uri === "string" ? item.enterprise_uri : typeof item.enterpriseUrl === "string" ? item.enterpriseUrl : undefined
    const suffix = plan === "enterprise" ? "#enterprise" : plan === "edu" ? "#edu" : plan === "free" || plan === "personal" ? "#free" : key === "github.com" ? "" : `#${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
    return [{
      key: `github-copilot${suffix}`,
      label: login ?? label(`github-copilot${suffix}`),
      refresh,
      access,
      expires: 0,
      enterpriseUrl,
    } satisfies CopilotAuth]
  })
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.key)) return false
    seen.add(item.key)
    return true
  })
}

export const migrate = Effect.fn("CopilotAuth.migrate")(function* (src?: MigrationIO) {
  const fs = src ?? (yield* io())
  const auth = yield* Auth.Service
  const mark = yield* readMigration(fs)
  if (mark.keys.length > 0) {
    outcome.last = mark
    return mark
  }
  const existing = yield* auth.all()
  if (Object.keys(existing).some((key) => key.startsWith("github-copilot"))) {
    const next = { version: 1, keys: [], skipped: true } satisfies MigrationState
    outcome.last = next
    return next
  }
  const raw = yield* fs.read(fs.legacy).pipe(Effect.orElseSucceed(() => ({})))
  const items = legacy(raw)
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
  const next = {
    version: 1,
    migratedAt: items.length > 0 ? Date.now() : undefined,
    source: items.length > 0 ? fs.legacy : undefined,
    keys: items.map((item) => item.key),
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
