/**
 * Portable GitHub Copilot account-bundle export/import.
 *
 * Ports the Rust `codex-rs/github-copilot/src/transfer.rs` surface
 * (~484 LOC) over to the Effect-based TS runtime. The bundle is a
 * self-describing JSON envelope that captures every Copilot OAuth
 * credential currently in the Auth store along with the per-account
 * `connections.json` metadata we care to keep (plan label, proxy URL,
 * etc.). Consumers can share a bundle across machines by copying the
 * JSON file, or share a redacted copy for debugging purposes.
 *
 * Intentional parity points with Rust:
 * - `version: 1` schema tag — `import` rejects newer versions up-front.
 * - Accounts are keyed by Copilot auth key (`github-copilot`,
 *   `github-copilot#edu`, …); dedup on import.
 * - Refresh tokens are treated as secrets: `exportBundle({ redactTokens })`
 *   strips them.
 * - Imports support two modes: `merge` (default, additive) and
 *   `replace` (wipe any pre-existing Copilot creds/connections first).
 */
import { Effect, Schema } from "effect"
import { Auth } from "@/auth"
import { list as listCopilotAuths, label as copilotLabel, type CopilotAuth } from "./auth"
import { Store as ConnectionsStore, empty as emptyConnections, type Conn, type State as ConnectionsState } from "./connections"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"

export const BUNDLE_VERSION = 1 as const

/* ------------------------------------------------------------------ */
/* Schemas                                                            */
/* ------------------------------------------------------------------ */

const BundleAccount = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  /** Refresh token — omitted when redactTokens is set. */
  refresh: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  proxyUrl: Schema.optional(Schema.String),
  proxyToken: Schema.optional(Schema.String),
})

const BundleConn = Schema.Struct({
  label: Schema.optional(Schema.String),
  login: Schema.optional(Schema.String),
  plan: Schema.optional(Schema.String),
  proxyUrl: Schema.optional(Schema.String),
  proxyToken: Schema.optional(Schema.String),
  preferred: Schema.optional(Schema.Boolean),
  deactivated: Schema.optional(Schema.Boolean),
})

const Bundle = Schema.Struct({
  version: Schema.Number,
  accounts: Schema.Array(BundleAccount),
  connections: Schema.Record(Schema.String, BundleConn),
  preferred: Schema.optional(Schema.String),
  exportedAt: Schema.Number,
  exportedBy: Schema.optional(Schema.String),
  /** When true, refresh tokens were stripped. */
  redacted: Schema.optional(Schema.Boolean),
})

export type BundleAccount = typeof BundleAccount.Type
export type BundleConn = typeof BundleConn.Type
export type Bundle = typeof Bundle.Type

export { Bundle as BundleSchema }

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

export type ExportOptions = {
  redactTokens?: boolean
  exportedBy?: string
  /** Override `Date.now()` for deterministic tests. */
  now?: number
}

export type ImportOptions = {
  /** Default: "merge". */
  mode?: "merge" | "replace"
  /** When true, compute the plan but write nothing. */
  dryRun?: boolean
}

export type ImportResult = {
  added: string[]
  updated: string[]
  skipped: string[]
  removed: string[]
  connectionsWritten: boolean
  dryRun: boolean
  mode: "merge" | "replace"
}

/** Pure helper: construct a bundle from auth + connections state. */
export function buildBundle(input: {
  auths: CopilotAuth[]
  state: ConnectionsState
  options?: ExportOptions
}): Bundle {
  const opts = input.options ?? {}
  const now = opts.now ?? Date.now()
  const redacted = !!opts.redactTokens

  const accounts: BundleAccount[] = input.auths.map((auth) => {
    const conn = input.state.connections[auth.key]
    return {
      key: auth.key,
      label: auth.label || copilotLabel(auth.key),
      ...(redacted ? {} : { refresh: auth.refresh }),
      ...(auth.enterpriseUrl ? { enterpriseUrl: auth.enterpriseUrl } : {}),
      ...(conn?.plan ? { plan: conn.plan } : {}),
      ...(conn?.proxyUrl ? { proxyUrl: conn.proxyUrl } : {}),
      // Proxy tokens ride with the refresh-token redaction flag — they
      // are functionally a secret.
      ...(!redacted && conn?.proxyToken ? { proxyToken: conn.proxyToken } : {}),
    }
  })

  const connections: Record<string, BundleConn> = {}
  for (const [key, conn] of Object.entries(input.state.connections)) {
    if (!key.startsWith("github-copilot")) continue
    const entry: BundleConn = {
      ...(conn.label !== undefined ? { label: conn.label } : {}),
      ...(conn.login !== undefined ? { login: conn.login } : {}),
      ...(conn.plan !== undefined ? { plan: conn.plan } : {}),
      ...(conn.proxyUrl !== undefined ? { proxyUrl: conn.proxyUrl } : {}),
      ...(!redacted && conn.proxyToken !== undefined ? { proxyToken: conn.proxyToken } : {}),
      ...(conn.preferred !== undefined ? { preferred: conn.preferred } : {}),
      ...(conn.deactivated !== undefined ? { deactivated: conn.deactivated } : {}),
    }
    // Don't emit empty shells.
    if (Object.keys(entry).length > 0) connections[key] = entry
  }

  return {
    version: BUNDLE_VERSION,
    accounts,
    connections,
    ...(input.state.preferred ? { preferred: input.state.preferred } : {}),
    exportedAt: now,
    ...(opts.exportedBy ? { exportedBy: opts.exportedBy } : {}),
    ...(redacted ? { redacted: true } : {}),
  }
}

/**
 * Produce a JSON-ready bundle object from the live Auth store and the
 * persisted `copilot-connections.json`. Does not write anything to
 * disk.
 */
export const exportBundle = Effect.fn("CopilotTransfer.exportBundle")(function* (options?: ExportOptions) {
  const auth = yield* Auth.Service
  const all = yield* auth.all()
  const auths = listCopilotAuths(all as any)

  const fs = yield* AppFileSystem.Service
  const store = new ConnectionsStore(fs)
  const state = yield* store.read()

  return buildBundle({ auths, state, options })
})

/* ------------------------------------------------------------------ */
/* Import                                                             */
/* ------------------------------------------------------------------ */

/**
 * Validate a raw parsed JSON value against the bundle schema. Throws
 * a descriptive `Error` with `cause` for any field-level violation or
 * unsupported version.
 */
export function parseBundle(raw: unknown): Bundle {
  const opt = Schema.decodeUnknownOption(Bundle)(raw)
  if (opt._tag === "None") {
    throw new Error("invalid Copilot transfer bundle: schema mismatch")
  }
  const bundle = opt.value
  if (bundle.version !== BUNDLE_VERSION) {
    throw new Error(
      `unsupported Copilot transfer bundle version ${bundle.version} (expected ${BUNDLE_VERSION})`,
    )
  }
  return bundle
}

/**
 * Compute the in-memory result of merging/replacing a bundle into the
 * given Auth map and connections state. Pure — used by the `importBundle`
 * effect and by tests that do not want filesystem side-effects.
 */
export function applyBundle(input: {
  bundle: Bundle
  existingAuth: Record<string, Auth.Info>
  existingState: ConnectionsState
  mode?: "merge" | "replace"
}) {
  const mode = input.mode ?? "merge"
  const added: string[] = []
  const updated: string[] = []
  const skipped: string[] = []
  const removed: string[] = []

  // Start from either a wiped slate (replace) or the existing store
  // (merge). We only ever touch `github-copilot*` keys.
  const nextAuth: Record<string, Auth.Info> = { ...input.existingAuth }
  let nextState: ConnectionsState = {
    version: input.existingState.version,
    preferred: input.existingState.preferred,
    connections: { ...input.existingState.connections },
  }

  if (mode === "replace") {
    for (const key of Object.keys(nextAuth)) {
      if (key.startsWith("github-copilot")) {
        removed.push(key)
        delete nextAuth[key]
      }
    }
    const trimmedConns: Record<string, Conn> = {}
    for (const [key, conn] of Object.entries(nextState.connections)) {
      if (!key.startsWith("github-copilot")) trimmedConns[key] = conn
    }
    nextState = { ...nextState, preferred: undefined, connections: trimmedConns }
  }

  for (const account of input.bundle.accounts) {
    if (!account.key.startsWith("github-copilot")) {
      skipped.push(account.key)
      continue
    }
    if (!account.refresh) {
      // Refresh token stripped — cannot restore the OAuth credential;
      // we still carry the connection metadata below.
      skipped.push(account.key)
      continue
    }
    const existed = nextAuth[account.key]
    nextAuth[account.key] = {
      type: "oauth",
      refresh: account.refresh,
      access: account.refresh,
      expires: 0,
      accountId: account.key,
      ...(account.enterpriseUrl ? { enterpriseUrl: account.enterpriseUrl } : {}),
    } as Auth.Info
    if (existed) updated.push(account.key)
    else added.push(account.key)
  }

  // Connection-state overlay.
  const mergedConns: Record<string, Conn> = { ...nextState.connections }
  for (const [key, conn] of Object.entries(input.bundle.connections)) {
    const base = mergedConns[key] ?? {}
    mergedConns[key] = { ...base, ...conn }
  }
  nextState = {
    ...nextState,
    connections: mergedConns,
    ...(input.bundle.preferred ? { preferred: input.bundle.preferred } : {}),
  }

  return {
    nextAuth,
    nextState,
    result: {
      added,
      updated,
      skipped,
      removed,
      connectionsWritten: Object.keys(input.bundle.connections).length > 0 || mode === "replace",
      dryRun: false,
      mode,
    } satisfies ImportResult,
  }
}

/**
 * Apply a validated bundle to the live Auth store and connections
 * state. Honours `mode` (merge/replace) and `dryRun`.
 */
export const importBundle = Effect.fn("CopilotTransfer.importBundle")(function* (
  bundle: Bundle,
  options?: ImportOptions,
) {
  const auth = yield* Auth.Service
  const existingAuth = yield* auth.all()

  const fs = yield* AppFileSystem.Service
  const store = new ConnectionsStore(fs)
  const existingState = yield* store.read().pipe(Effect.orElseSucceed(() => emptyConnections()))

  const { nextAuth, nextState, result } = applyBundle({
    bundle,
    existingAuth,
    existingState,
    mode: options?.mode,
  })

  if (options?.dryRun) {
    return { ...result, dryRun: true } satisfies ImportResult
  }

  // Remove first (replace mode), then upsert everyone else.
  for (const key of result.removed) {
    yield* auth.remove(key)
  }
  for (const key of [...result.added, ...result.updated]) {
    yield* auth.set(key, nextAuth[key]!)
  }
  yield* store.write(nextState)

  return result
})
