import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Config } from "../../config"
import { Provider } from "../../provider"
import { mapValues } from "remeda"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { AppRuntime } from "../../effect/app-runtime"
import { jsonRequest } from "./trace"
import { SessionAutosteerObserver } from "../../session/autosteer-observer"

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.get", c, function* () {
          const cfg = yield* Config.Service
          return yield* cfg.get()
        }),
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info),
      async (c) => {
        const config = c.req.valid("json")
        await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.update(config)))
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("ConfigRoutes.providers", c, function* () {
          const svc = yield* Provider.Service
          const providers = mapValues(yield* svc.list(), (item) => item)
          return {
            providers: Object.values(providers),
            default: mapValues(providers, (item) => Provider.sort(Object.values(item.models))[0].id),
          }
        }),
    )
    .post(
      "/autosteering",
      describeRoute({
        summary: "Toggle autosteering at runtime",
        description:
          "Override the autosteering enabled flag without rewriting opencode.json. Pass `enabled` as a boolean to set, or omit (or pass null) to clear the override and revert to the config value. The current effective value is returned in the response.",
        operationId: "config.autosteering.set",
        responses: {
          200: {
            description: "Autosteering toggled",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    enabled: z.boolean(),
                    cumulativeNudgeCount: z.number().int().nonnegative(),
                  }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ enabled: z.union([z.boolean(), z.null()]).optional() })),
      async (c) => {
        const body = c.req.valid("json")
        await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.setEnabledOverride(body.enabled ?? undefined)),
        )
        const enabled = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.isEnabled()),
        )
        const cumulativeNudgeCount = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.cumulativeNudgeCount()),
        )
        return c.json({ enabled, cumulativeNudgeCount })
      },
    )
    .get(
      "/autosteering",
      describeRoute({
        summary: "Get autosteering status",
        description: "Return the effective autosteering enabled flag and the cumulative nudge count for this server process.",
        operationId: "config.autosteering.get",
        responses: {
          200: {
            description: "Autosteering status",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    enabled: z.boolean(),
                    cumulativeNudgeCount: z.number().int().nonnegative(),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const enabled = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.isEnabled()),
        )
        const cumulativeNudgeCount = await AppRuntime.runPromise(
          SessionAutosteerObserver.Service.use((svc) => svc.cumulativeNudgeCount()),
        )
        return c.json({ enabled, cumulativeNudgeCount })
      },
    ),
)
