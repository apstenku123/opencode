/**
 * Rollout HTTP routes (R6 Stream G).
 *
 * `GET  /session/:id/rollout` — return the persisted rollout log for
 *                                a session as a JSON array of entries.
 * `POST /session/:id/replay`  — re-emit the rollout entries to the
 *                                caller (pure; does not re-run the
 *                                model or mutate DB state).
 */
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { SessionID } from "@/session/schema"
import { Rollout } from "@/rollout"
import { errors } from "../error"
import { lazy } from "../../util/lazy"

export const RolloutRoutes = lazy(() =>
  new Hono()
    .get(
      "/:sessionID/rollout",
      describeRoute({
        summary: "Get session rollout",
        description: "Return the persistent JSONL rollout log for a session as a JSON array of entries.",
        tags: ["Rollout"],
        operationId: "rollout.get",
        responses: {
          200: {
            description: "Rollout entries",
            content: {
              "application/json": {
                schema: resolver(Rollout.Writer.Entry.array()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "query",
        z.object({
          sinceSeq: z.coerce.number().int().nonnegative().optional(),
          untilSeq: z.coerce.number().int().nonnegative().optional(),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const { sinceSeq, untilSeq } = c.req.valid("query")
        const state = await Rollout.Replay.replayToMemory(sessionID, {
          sinceSeq,
          untilSeq,
        })
        return c.json(state.entries)
      },
    )
    .post(
      "/:sessionID/replay",
      describeRoute({
        summary: "Replay session rollout",
        description:
          "Pure replay of a session's rollout log. Returns the aggregated state (entries + kind counts). Does not re-run the model.",
        tags: ["Rollout"],
        operationId: "rollout.replay",
        responses: {
          200: {
            description: "Replay state",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    sessionID: SessionID.zod,
                    entries: Rollout.Writer.Entry.array(),
                    kinds: z.record(z.string(), z.number()),
                    firstTime: z.number().optional(),
                    lastTime: z.number().optional(),
                    lastSeq: z.number().optional(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          sessionID: SessionID.zod,
        }),
      ),
      validator(
        "query",
        z.object({
          sinceSeq: z.coerce.number().int().nonnegative().optional(),
          untilSeq: z.coerce.number().int().nonnegative().optional(),
        }),
      ),
      async (c) => {
        const { sessionID } = c.req.valid("param")
        const { sinceSeq, untilSeq } = c.req.valid("query")
        const state = await Rollout.Replay.replayToMemory(sessionID, {
          sinceSeq,
          untilSeq,
        })
        return c.json(state)
      },
    ),
)
