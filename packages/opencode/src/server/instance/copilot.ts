/**
 * `/copilot/*` HTTP RPC routes — server mirrors of the `opencode providers`
 * Copilot-account CLI subcommands.
 *
 * The CLI renders human-friendly + `--json` output; here we expose the
 * same underlying logic via plain JSON endpoints so external UIs (TUI,
 * dashboards, scripts) can drive Copilot account management without
 * shelling out.
 *
 * All route handlers delegate to already-exported helpers in
 * `@/cli/cmd/providers` (status probes, route debug) and
 * `@/plugin/github-copilot/connections` (state persistence) so the route
 * surface stays thin and the behaviour matches the CLI exactly.
 */

import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"

import {
  ACCOUNT_STATUS_SCHEMA_VERSION,
  allAuth,
  copilotAliasLabel,
  jsonMigration,
  jsonStatus,
  loadAccountStatuses,
  loadProvidersStats,
  loadRouteDebug,
  poolAllowedProdModels,
  poolAllowedTestModels,
  quotaAccounts,
  resolveMigrationSummary,
  saveProxy,
} from "@/cli/cmd/providers"
import { parseDuration, STATS_SCHEMA_VERSION } from "@/plugin/github-copilot/stats"
import {
  clearDeactivated,
  empty,
  markDeactivated,
  StateSchema,
  upsert,
  type State,
} from "@/plugin/github-copilot/connections"
import { checkAccountStatuses } from "@/plugin/github-copilot/health"
import { connectionFile } from "@/plugin/github-copilot/paths"
import { poolForAccount } from "@/plugin/github-copilot/pool-routing"
import { getPoolRoutingConfig } from "@/plugin/github-copilot/copilot"
import { CopilotModels } from "@/plugin/github-copilot/models"
import { errors } from "../error"
import { lazy } from "@/util/lazy"

// --------------------------------------------------------------------------
// Internal state helpers (match CLI `readConnections`/`writeConnections`)
// --------------------------------------------------------------------------

async function readState(): Promise<State> {
  const raw = await Bun.file(connectionFile)
    .json()
    .catch(() => empty())
  const parsed = StateSchema.zod.safeParse(raw)
  return parsed.success ? (parsed.data as State) : empty()
}

async function writeState(state: State): Promise<void> {
  await Bun.write(connectionFile, JSON.stringify(state, null, 2))
}

async function isCopilotAccount(key: string): Promise<boolean> {
  if (!key.startsWith("github-copilot")) return false
  const credentials = await allAuth()
  const accounts = quotaAccounts(
    credentials as Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>,
  )
  return accounts.some(([k]) => k === key)
}

// --------------------------------------------------------------------------
// Zod schemas (kept lax — the CLI helpers we delegate to already constrain
// the shape; we only type the server-only request bodies tightly).
// --------------------------------------------------------------------------

const ProxyBodySchema = z.object({
  proxyUrl: z.string().optional().meta({
    description: "Proxy base URL. Pass an empty string or omit to clear.",
  }),
  proxyToken: z.string().optional().meta({ description: "Optional proxy bearer token" }),
  envelope: z.boolean().optional().meta({
    description: "Wrap traffic in the base64 envelope expected by the proxy",
  }),
})

const RouteDebugBodySchema = z.object({
  modelId: z.string().min(1).meta({ description: "Model identifier to test-route" }),
  providerID: z.string().optional().meta({ description: "Scope candidates to a provider alias" }),
  account: z.string().optional().meta({ description: "Scope candidates to a single account key" }),
})

const KeyParamSchema = z.object({
  key: z
    .string()
    .min(1)
    .meta({ description: "Copilot account key (e.g. `github-copilot#edu`)" }),
})

const PoolParamSchema = z.object({
  pool: z.enum(["edu", "prod"]).meta({ description: "Copilot routing pool" }),
})

const StatsQuerySchema = z.object({
  since: z
    .string()
    .optional()
    .meta({
      description: "Time window (10m, 1h, 24h, …). Omit for since-boot totals.",
    }),
})

const StatsResponseSchema = z
  .object({
    schemaVersion: z.number().meta({ example: STATS_SCHEMA_VERSION }),
    generatedAt: z.number(),
    bootedAt: z.number(),
    windowMs: z.number().nullable(),
    accounts: z.array(z.any()),
    topModels: z.array(z.object({ model: z.string(), count: z.number() })),
    pools: z.array(
      z.object({
        pool: z.string(),
        accounts: z.number(),
        deactivated: z.number(),
        inCooldown: z.number(),
      }),
    ),
    totals: z.object({
      accounts: z.number(),
      deactivated: z.number(),
      dispatches: z.number(),
      rateLimits: z.number(),
      premium: z.number(),
    }),
  })
  .loose()

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

export const CopilotRoutes = lazy(() =>
  new Hono()
    /* ---------------- Accounts ----------------------------------------- */
    .get(
      "/accounts",
      describeRoute({
        summary: "List Copilot accounts",
        description:
          "Return the same JSON envelope as `opencode providers accounts --json` — account status, health triage, migration summary, and best-per-vendor discovery snapshot.",
        operationId: "copilot.accounts.list",
        responses: {
          200: {
            description: "Account overview",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) => {
        const { accounts, items, state } = await loadAccountStatuses()
        const migration = resolveMigrationSummary(accounts.length > 0)
        const auths = accounts.map(([key, info]) => ({
          key,
          label: copilotAliasLabel(key),
          refresh: info.refresh || "",
          access: (info as any).access || info.refresh || "",
          expires: (info as any).expires || 0,
          enterpriseUrl: info.enterpriseUrl,
        }))
        const triage = await checkAccountStatuses({ auths, state })
        const healthByKey = new Map(triage.map((h) => [h.key, h] as const))
        const bestPerVendor = Object.fromEntries(
          Object.entries(state.connections)
            .map(([key, conn]) => {
              const catalog = conn.discovery?.models ?? []
              if (catalog.length === 0) return [key, null] as const
              const best = CopilotModels.bestPerVendor(catalog.map((id) => ({ id })))
              return [key, best.length > 0 ? best : null] as const
            })
            .filter(([, v]) => v !== null),
        )
        return c.json({
          schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
          migration: jsonMigration(migration),
          health: triage,
          bestPerVendor,
          items: items.map((item) => ({
            schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
            ...item,
            status: jsonStatus(item.status),
            triage: healthByKey.get(item.status.key) ?? null,
          })),
        })
      },
    )
    .get(
      "/accounts/:key",
      describeRoute({
        summary: "Get a single Copilot account status",
        description: "Same per-item envelope as `/copilot/accounts`, filtered to one account key.",
        operationId: "copilot.accounts.get",
        responses: {
          200: {
            description: "Account status",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
          ...errors(404),
        },
      }),
      validator("param", KeyParamSchema),
      async (c) => {
        const { key } = c.req.valid("param")
        const { accounts, items, state } = await loadAccountStatuses()
        const match = items.find((item) => item.status.key === key)
        if (!match) return c.json({ error: "account not found", key }, 404)
        const auths = accounts.map(([k, info]) => ({
          key: k,
          label: copilotAliasLabel(k),
          refresh: info.refresh || "",
          access: (info as any).access || info.refresh || "",
          expires: (info as any).expires || 0,
          enterpriseUrl: info.enterpriseUrl,
        }))
        const triage = await checkAccountStatuses({ auths, state })
        const hit = triage.find((t) => t.key === key) ?? null
        return c.json({
          schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
          ...match,
          status: jsonStatus(match.status),
          triage: hit,
        })
      },
    )
    .post(
      "/accounts/:key/deactivate",
      describeRoute({
        summary: "Deactivate a Copilot account",
        description:
          "Mark the account as deactivated so the routing layer skips it on subsequent dispatches. Mirrors the persisted 401/403 auto-deactivation performed by `providers accounts`.",
        operationId: "copilot.accounts.deactivate",
        responses: {
          200: {
            description: "Account deactivated",
            content: {
              "application/json": {
                schema: resolver(z.object({ key: z.string(), deactivated: z.literal(true) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", KeyParamSchema),
      async (c) => {
        const { key } = c.req.valid("param")
        if (!(await isCopilotAccount(key))) return c.json({ error: "account not found", key }, 404)
        const state = await readState()
        const next = markDeactivated(state, key)
        await writeState(next)
        return c.json({ key, deactivated: true as const })
      },
    )
    .post(
      "/accounts/:key/activate",
      describeRoute({
        summary: "Reactivate a Copilot account",
        description: "Clear the deactivated flag for the account so routing resumes considering it.",
        operationId: "copilot.accounts.activate",
        responses: {
          200: {
            description: "Account activated",
            content: {
              "application/json": {
                schema: resolver(z.object({ key: z.string(), deactivated: z.literal(false) })),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", KeyParamSchema),
      async (c) => {
        const { key } = c.req.valid("param")
        if (!(await isCopilotAccount(key))) return c.json({ error: "account not found", key }, 404)
        const state = await readState()
        const next = clearDeactivated(state, key)
        await writeState(next)
        return c.json({ key, deactivated: false as const })
      },
    )
    .post(
      "/accounts/:key/machine-id/rotate",
      describeRoute({
        summary: "Rotate the machine-id for a Copilot account",
        description:
          "Clear the persisted machineId so the next `dispatchOnce` for this account mints a fresh UUID. The response reports whether a previous id existed.",
        operationId: "copilot.accounts.machineId.rotate",
        responses: {
          200: {
            description: "Machine ID cleared",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    key: z.string(),
                    previousMachineId: z.string().nullable(),
                    cleared: z.boolean(),
                  }),
                ),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", KeyParamSchema),
      async (c) => {
        const { key } = c.req.valid("param")
        if (!(await isCopilotAccount(key))) return c.json({ error: "account not found", key }, 404)
        const state = await readState()
        const previous = state.connections[key]?.machineId ?? null
        const next = upsert(state, key, { machineId: undefined })
        await writeState(next)
        return c.json({ key, previousMachineId: previous, cleared: true })
      },
    )
    .post(
      "/accounts/:key/proxy",
      describeRoute({
        summary: "Configure Copilot proxy for an account",
        description:
          "Set or clear the per-account proxy URL, token and envelope flag. Empty/missing `proxyUrl` clears the configuration.",
        operationId: "copilot.accounts.proxy.set",
        responses: {
          200: {
            description: "Proxy configuration updated",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    key: z.string(),
                    proxyUrl: z.string().nullable(),
                    proxyToken: z.string().nullable(),
                    envelope: z.boolean().nullable(),
                  }),
                ),
              },
            },
          },
          ...errors(404, 400),
        },
      }),
      validator("param", KeyParamSchema),
      validator("json", ProxyBodySchema),
      async (c) => {
        const { key } = c.req.valid("param")
        const body = c.req.valid("json")
        if (!(await isCopilotAccount(key))) return c.json({ error: "account not found", key }, 404)
        const url = body.proxyUrl?.trim() || undefined
        const token = body.proxyToken?.trim() || undefined
        const next = await saveProxy(key, url, token)
        // `saveProxy` clears / sets proxyUrl + proxyToken but not `envelope`.
        // Apply the envelope flag in a follow-up upsert when the caller
        // specifies one (so turning on envelope without changing url keeps
        // the existing url intact).
        let finalState = next
        if (body.envelope !== undefined) {
          finalState = upsert(next, key, { envelope: body.envelope })
          await writeState(finalState)
        }
        const conn = finalState.connections[key]
        return c.json({
          key,
          proxyUrl: conn?.proxyUrl ?? null,
          proxyToken: conn?.proxyToken ?? null,
          envelope: conn?.envelope ?? null,
        })
      },
    )
    /* ---------------- Pools -------------------------------------------- */
    .get(
      "/pools",
      describeRoute({
        summary: "List Copilot accounts grouped by pool",
        description:
          "Bucket configured Copilot accounts into the `edu`/`prod` pools used by the routing layer. Accounts whose plan cannot be resolved fall into `unpooled`.",
        operationId: "copilot.pools.list",
        responses: {
          200: {
            description: "Pool membership",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    edu: z.array(z.string()),
                    prod: z.array(z.string()),
                    unpooled: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const credentials = await allAuth()
        const accounts = quotaAccounts(
          credentials as Record<string, { type: string; refresh?: string; enterpriseUrl?: string }>,
        )
        const state = await readState()
        const cfg = getPoolRoutingConfig()
        const buckets: { edu: string[]; prod: string[]; unpooled: string[] } = {
          edu: [],
          prod: [],
          unpooled: [],
        }
        for (const [key] of accounts) {
          const plan = state.connections[key]?.plan
          const pool = poolForAccount({ key, plan, cfg })
          if (pool === "edu") buckets.edu.push(key)
          else if (pool === "prod") buckets.prod.push(key)
          else buckets.unpooled.push(key)
        }
        return c.json(buckets)
      },
    )
    .get(
      "/pools/:pool/allowed",
      describeRoute({
        summary: "List models allowed for a pool",
        description:
          "Return the production + test-only model IDs the pool is permitted to route. Mirrors `poolAllowedProdModels` / `poolAllowedTestModels` used by `providers accounts`.",
        operationId: "copilot.pools.allowed",
        responses: {
          200: {
            description: "Model allow list",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    prod: z.array(z.string()),
                    testOnly: z.array(z.string()),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", PoolParamSchema),
      async (c) => {
        const { pool } = c.req.valid("param")
        return c.json({
          prod: poolAllowedProdModels(pool),
          testOnly: poolAllowedTestModels(pool),
        })
      },
    )
    /* ---------------- Observability ------------------------------------ */
    .get(
      "/stats",
      describeRoute({
        summary: "GitHub Copilot dispatch stats",
        description:
          "Per-account dispatch counts, 429 hits, retry-after average and premium stamps since boot. Mirrors `opencode providers stats --json`. Optional `since` query narrows to a window (e.g. `10m`, `1h`, `24h`).",
        operationId: "copilot.stats",
        responses: {
          200: {
            description: "Aggregate stats payload",
            content: { "application/json": { schema: resolver(StatsResponseSchema) } },
          },
          ...errors(400),
        },
      }),
      validator("query", StatsQuerySchema),
      async (c) => {
        const { since } = c.req.valid("query")
        const sinceMs = parseDuration(since)
        if (since !== undefined && sinceMs === undefined) {
          return c.json({ error: `invalid since value: ${since}` }, 400)
        }
        const payload = await loadProvidersStats({ sinceMs })
        return c.json(payload)
      },
    )
    /* ---------------- Quota + route debug ------------------------------ */
    .get(
      "/quota",
      describeRoute({
        summary: "Copilot quota overview",
        description:
          "Return the same JSON envelope as `opencode providers quota --json` — migration summary and per-account quota items.",
        operationId: "copilot.quota",
        responses: {
          200: {
            description: "Quota overview",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
        },
      }),
      async (c) => {
        const { accounts, items } = await loadAccountStatuses()
        const migration = resolveMigrationSummary(accounts.length > 0)
        return c.json({
          schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
          migration: jsonMigration(migration),
          items: items.map((item) => ({
            schemaVersion: ACCOUNT_STATUS_SCHEMA_VERSION,
            ...item,
            status: jsonStatus(item.status),
          })),
        })
      },
    )
    .post(
      "/route-debug",
      describeRoute({
        summary: "Debug Copilot routing for a model",
        description:
          "Return the ranked candidate list that `preferPolicy` + `preferDiscovery` would produce for `modelId`. Optional `providerID` and `account` narrow the candidate pool.",
        operationId: "copilot.route.debug",
        responses: {
          200: {
            description: "Route candidates",
            content: { "application/json": { schema: resolver(z.any()) } },
          },
          ...errors(400),
        },
      }),
      validator("json", RouteDebugBodySchema),
      async (c) => {
        const body = c.req.valid("json")
        const data = await loadRouteDebug({
          model: body.modelId,
          providerID: body.providerID,
          account: body.account,
        })
        return c.json(data)
      },
    ),
)
