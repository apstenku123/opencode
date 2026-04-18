import { Identifier } from "@/id/id"
import { withStatics } from "@/util/schema"
import * as DateTime from "effect/DateTime"
import { Schema } from "effect"

export namespace SessionEvent {
  export const ID = Schema.String.pipe(
    Schema.brand("Session.Event.ID"),
    withStatics((s) => ({
      create: () => s.make(Identifier.create("evt", "ascending")),
    })),
  )
  export type ID = Schema.Schema.Type<typeof ID>
  type Stamp = Schema.Schema.Type<typeof Schema.DateTimeUtc>
  type BaseInput = {
    id?: ID
    metadata?: Record<string, unknown>
    timestamp?: Stamp
  }

  const Base = {
    id: ID,
    metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
    timestamp: Schema.DateTimeUtc,
  }

  export class Source extends Schema.Class<Source>("Session.Event.Source")({
    start: Schema.Number,
    end: Schema.Number,
    text: Schema.String,
  }) {}

  export class FileAttachment extends Schema.Class<FileAttachment>("Session.Event.FileAttachment")({
    uri: Schema.String,
    mime: Schema.String,
    name: Schema.String.pipe(Schema.optional),
    description: Schema.String.pipe(Schema.optional),
    source: Source.pipe(Schema.optional),
  }) {
    static create(input: FileAttachment) {
      return new FileAttachment({
        uri: input.uri,
        mime: input.mime,
        name: input.name,
        description: input.description,
        source: input.source,
      })
    }
  }

  export class AgentAttachment extends Schema.Class<AgentAttachment>("Session.Event.AgentAttachment")({
    name: Schema.String,
    source: Source.pipe(Schema.optional),
  }) {}

  export class Prompt extends Schema.Class<Prompt>("Session.Event.Prompt")({
    ...Base,
    type: Schema.Literal("prompt"),
    text: Schema.String,
    files: Schema.Array(FileAttachment).pipe(Schema.optional),
    agents: Schema.Array(AgentAttachment).pipe(Schema.optional),
  }) {
    static create(input: BaseInput & { text: string; files?: FileAttachment[]; agents?: AgentAttachment[] }) {
      return new Prompt({
        id: input.id ?? ID.create(),
        type: "prompt",
        timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
        metadata: input.metadata,
        text: input.text,
        files: input.files,
        agents: input.agents,
      })
    }
  }

  export class Synthetic extends Schema.Class<Synthetic>("Session.Event.Synthetic")({
    ...Base,
    type: Schema.Literal("synthetic"),
    text: Schema.String,
  }) {
    static create(input: BaseInput & { text: string }) {
      return new Synthetic({
        id: input.id ?? ID.create(),
        type: "synthetic",
        timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
        metadata: input.metadata,
        text: input.text,
      })
    }
  }

  export namespace Step {
    export class Started extends Schema.Class<Started>("Session.Event.Step.Started")({
      ...Base,
      type: Schema.Literal("step.started"),
      model: Schema.Struct({
        id: Schema.String,
        providerID: Schema.String,
        variant: Schema.String.pipe(Schema.optional),
      }),
    }) {
      static create(input: BaseInput & { model: { id: string; providerID: string; variant?: string } }) {
        return new Started({
          id: input.id ?? ID.create(),
          type: "step.started",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          model: input.model,
        })
      }
    }

    export class Ended extends Schema.Class<Ended>("Session.Event.Step.Ended")({
      ...Base,
      type: Schema.Literal("step.ended"),
      reason: Schema.String,
      cost: Schema.Number,
      tokens: Schema.Struct({
        input: Schema.Number,
        output: Schema.Number,
        reasoning: Schema.Number,
        cache: Schema.Struct({
          read: Schema.Number,
          write: Schema.Number,
        }),
      }),
    }) {
      static create(input: BaseInput & { reason: string; cost: number; tokens: Ended["tokens"] }) {
        return new Ended({
          id: input.id ?? ID.create(),
          type: "step.ended",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          reason: input.reason,
          cost: input.cost,
          tokens: input.tokens,
        })
      }
    }
  }

  export namespace Text {
    export class Started extends Schema.Class<Started>("Session.Event.Text.Started")({
      ...Base,
      type: Schema.Literal("text.started"),
    }) {
      static create(input: BaseInput = {}) {
        return new Started({
          id: input.id ?? ID.create(),
          type: "text.started",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
        })
      }
    }

    export class Delta extends Schema.Class<Delta>("Session.Event.Text.Delta")({
      ...Base,
      type: Schema.Literal("text.delta"),
      delta: Schema.String,
    }) {
      static create(input: BaseInput & { delta: string }) {
        return new Delta({
          id: input.id ?? ID.create(),
          type: "text.delta",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          delta: input.delta,
        })
      }
    }

    export class Ended extends Schema.Class<Ended>("Session.Event.Text.Ended")({
      ...Base,
      type: Schema.Literal("text.ended"),
      text: Schema.String,
    }) {
      static create(input: BaseInput & { text: string }) {
        return new Ended({
          id: input.id ?? ID.create(),
          type: "text.ended",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          text: input.text,
        })
      }
    }
  }

  export namespace Reasoning {
    export class Started extends Schema.Class<Started>("Session.Event.Reasoning.Started")({
      ...Base,
      type: Schema.Literal("reasoning.started"),
    }) {
      static create(input: BaseInput = {}) {
        return new Started({
          id: input.id ?? ID.create(),
          type: "reasoning.started",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
        })
      }
    }

    export class Delta extends Schema.Class<Delta>("Session.Event.Reasoning.Delta")({
      ...Base,
      type: Schema.Literal("reasoning.delta"),
      delta: Schema.String,
    }) {
      static create(input: BaseInput & { delta: string }) {
        return new Delta({
          id: input.id ?? ID.create(),
          type: "reasoning.delta",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          delta: input.delta,
        })
      }
    }

    export class Ended extends Schema.Class<Ended>("Session.Event.Reasoning.Ended")({
      ...Base,
      type: Schema.Literal("reasoning.ended"),
      text: Schema.String,
    }) {
      static create(input: BaseInput & { text: string }) {
        return new Ended({
          id: input.id ?? ID.create(),
          type: "reasoning.ended",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          text: input.text,
        })
      }
    }
  }

  export namespace Tool {
    export namespace Input {
      export class Started extends Schema.Class<Started>("Session.Event.Tool.Input.Started")({
        ...Base,
        callID: Schema.String,
        name: Schema.String,
        type: Schema.Literal("tool.input.started"),
      }) {
        static create(input: BaseInput & { callID: string; name: string }) {
          return new Started({
            id: input.id ?? ID.create(),
            type: "tool.input.started",
            timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
            metadata: input.metadata,
            callID: input.callID,
            name: input.name,
          })
        }
      }

      export class Delta extends Schema.Class<Delta>("Session.Event.Tool.Input.Delta")({
        ...Base,
        callID: Schema.String,
        type: Schema.Literal("tool.input.delta"),
        delta: Schema.String,
      }) {
        static create(input: BaseInput & { callID: string; delta: string }) {
          return new Delta({
            id: input.id ?? ID.create(),
            type: "tool.input.delta",
            timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
            metadata: input.metadata,
            callID: input.callID,
            delta: input.delta,
          })
        }
      }

      export class Ended extends Schema.Class<Ended>("Session.Event.Tool.Input.Ended")({
        ...Base,
        callID: Schema.String,
        type: Schema.Literal("tool.input.ended"),
        text: Schema.String,
      }) {
        static create(input: BaseInput & { callID: string; text: string }) {
          return new Ended({
            id: input.id ?? ID.create(),
            type: "tool.input.ended",
            timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
            metadata: input.metadata,
            callID: input.callID,
            text: input.text,
          })
        }
      }
    }

    export class Called extends Schema.Class<Called>("Session.Event.Tool.Called")({
      ...Base,
      type: Schema.Literal("tool.called"),
      callID: Schema.String,
      tool: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    }) {
      static create(
        input: BaseInput & {
          callID: string
          tool: string
          input: Record<string, unknown>
          provider: Called["provider"]
        },
      ) {
        return new Called({
          id: input.id ?? ID.create(),
          type: "tool.called",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          callID: input.callID,
          tool: input.tool,
          input: input.input,
          provider: input.provider,
        })
      }
    }

    export class Success extends Schema.Class<Success>("Session.Event.Tool.Success")({
      ...Base,
      type: Schema.Literal("tool.success"),
      callID: Schema.String,
      title: Schema.String,
      output: Schema.String.pipe(Schema.optional),
      attachments: Schema.Array(FileAttachment).pipe(Schema.optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    }) {
      static create(
        input: BaseInput & {
          callID: string
          title: string
          output?: string
          attachments?: FileAttachment[]
          provider: Success["provider"]
        },
      ) {
        return new Success({
          id: input.id ?? ID.create(),
          type: "tool.success",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          callID: input.callID,
          title: input.title,
          output: input.output,
          attachments: input.attachments,
          provider: input.provider,
        })
      }
    }

    export class Error extends Schema.Class<Error>("Session.Event.Tool.Error")({
      ...Base,
      type: Schema.Literal("tool.error"),
      callID: Schema.String,
      error: Schema.String,
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
      }),
    }) {
      static create(input: BaseInput & { callID: string; error: string; provider: Error["provider"] }) {
        return new Error({
          id: input.id ?? ID.create(),
          type: "tool.error",
          timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
          metadata: input.metadata,
          callID: input.callID,
          error: input.error,
          provider: input.provider,
        })
      }
    }
  }

  export class Retried extends Schema.Class<Retried>("Session.Event.Retried")({
    ...Base,
    type: Schema.Literal("retried"),
    error: Schema.String,
  }) {
    static create(input: BaseInput & { error: string }) {
      return new Retried({
        id: input.id ?? ID.create(),
        type: "retried",
        timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
        metadata: input.metadata,
        error: input.error,
      })
    }
  }

  export class Plan extends Schema.Class<Plan>("Session.Event.Plan")({
    ...Base,
    type: Schema.Literal("plan"),
    items: Schema.Array(
      Schema.Struct({
        step: Schema.String,
        status: Schema.Union([Schema.Literal("pending"), Schema.Literal("in_progress"), Schema.Literal("completed")]),
      }),
    ),
  }) {
    static create(input: BaseInput & { items: { step: string; status: "pending" | "in_progress" | "completed" }[] }) {
      return new Plan({
        id: input.id ?? ID.create(),
        type: "plan",
        timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
        metadata: input.metadata,
        items: input.items,
      })
    }
  }

  export class Compacted extends Schema.Class<Compacted>("Session.Event.Compated")({
    ...Base,
    type: Schema.Literal("compacted"),
    auto: Schema.Boolean,
    overflow: Schema.Boolean.pipe(Schema.optional),
  }) {
    static create(input: BaseInput & { auto: boolean; overflow?: boolean }) {
      return new Compacted({
        id: input.id ?? ID.create(),
        type: "compacted",
        timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
        metadata: input.metadata,
        auto: input.auto,
        overflow: input.overflow,
      })
    }
  }


  export class Autobest extends Schema.Class<Autobest>("Session.Event.Autobest")({
    ...Base,
    type: Schema.Literal("autobest"),
    active: Schema.Struct({
      key: Schema.String,
      score: Schema.Number.pipe(Schema.optional),
      source: Schema.String,
      ts: Schema.Number,
    }).pipe(Schema.optional),
    selected: Schema.Struct({
      key: Schema.String,
      score: Schema.Number,
      reason: Schema.Array(Schema.String).pipe(Schema.optional),
    }).pipe(Schema.optional),
    changed: Schema.Boolean,
    candidates: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        score: Schema.Number,
        reason: Schema.Array(Schema.String).pipe(Schema.optional),
      }),
    ),
    /**
     * Step A/B/C/D kind. Ports `codex-rs/core/src/autobest_extract.rs::AutobestStep`.
     * Optional for backward-compat with existing history writers.
     */
    stepKind: Schema.Union([Schema.Literal("a"), Schema.Literal("b"), Schema.Literal("c"), Schema.Literal("d")]).pipe(
      Schema.optional,
    ),
    /** Human-readable decision reason, e.g. "llm-step-a", "regex-fallback", "max-iterations". */
    reason: Schema.String.pipe(Schema.optional),
    /** Cycle iteration index (0-based). Mirror of Rust `AutobestTurnResult::iteration`. */
    iteration: Schema.Number.pipe(Schema.optional),
    /** Turn correlation id. */
    turnID: Schema.String.pipe(Schema.optional),
    /** LLM call duration in ms. */
    elapsedMs: Schema.Number.pipe(Schema.optional),
    /** Model id used for Step A extraction. */
    modelUsed: Schema.String.pipe(Schema.optional),
    /** Action scheduled as next user turn (auto-continue payload). */
    resultingAction: Schema.String.pipe(Schema.optional),
    /**
     * Whether the cycle's "And what's next?" follow-up has been dispatched.
     * Mirror of `Session::what_next_asks_used_this_cycle` in Rust.
     */
    whatNextAsked: Schema.Boolean.pipe(Schema.optional),
    /**
     * Compact-window correlation id used for Step B plan check. Optional —
     * absent when the compact pipeline has not produced a window yet.
     */
    compactWindowID: Schema.Number.pipe(Schema.optional),
    /** Truncated compact-window snippet shown for diagnostics. */
    compactSnippet: Schema.String.pipe(Schema.optional),
    /**
     * Grounding outcome side-band. Populated when Step A `complaint=true`
     * triggered the grounding dispatch in `autobest/grounding.ts`.
     */
    grounding: Schema.Struct({
      outcome: Schema.Union([Schema.Literal("skipped"), Schema.Literal("dispatched")]),
      reason: Schema.String.pipe(Schema.optional),
      agentsSpawned: Schema.Number.pipe(Schema.optional),
      toolsUsed: Schema.Array(Schema.String).pipe(Schema.optional),
      turn: Schema.Number,
    }).pipe(Schema.optional),
  }) {
    static create(
      input: BaseInput & {
        active?: { key: string; score?: number; source: string; ts: number }
        selected?: { key: string; score: number; reason?: string[] }
        changed: boolean
        candidates: { key: string; score: number; reason?: string[] }[]
        stepKind?: "a" | "b" | "c" | "d"
        reason?: string
        iteration?: number
        turnID?: string
        elapsedMs?: number
        modelUsed?: string
        resultingAction?: string
        whatNextAsked?: boolean
        compactWindowID?: number
        compactSnippet?: string
        grounding?: {
          outcome: "skipped" | "dispatched"
          reason?: string
          agentsSpawned?: number
          toolsUsed?: readonly string[]
          turn: number
        }
      },
    ) {
      return new Autobest({
        id: input.id ?? ID.create(),
        type: "autobest",
        timestamp: input.timestamp ?? DateTime.makeUnsafe(Date.now()),
        metadata: input.metadata,
        active: input.active,
        selected: input.selected,
        changed: input.changed,
        candidates: input.candidates,
        stepKind: input.stepKind,
        reason: input.reason,
        iteration: input.iteration,
        turnID: input.turnID,
        elapsedMs: input.elapsedMs,
        modelUsed: input.modelUsed,
        resultingAction: input.resultingAction,
        whatNextAsked: input.whatNextAsked,
        compactWindowID: input.compactWindowID,
        compactSnippet: input.compactSnippet,
        grounding: input.grounding,
      })
    }
  }

  export const Event = Schema.Union(
    [
      Prompt,
      Synthetic,
      Step.Started,
      Step.Ended,
      Text.Started,
      Text.Delta,
      Text.Ended,
      Tool.Input.Started,
      Tool.Input.Delta,
      Tool.Input.Ended,
      Tool.Called,
      Tool.Success,
      Tool.Error,
      Reasoning.Started,
      Reasoning.Delta,
      Reasoning.Ended,
      Retried,
      Plan,
      Compacted,
      Autobest,
    ],
    {
      mode: "oneOf",
    },
  )
  export type Event = Schema.Schema.Type<typeof Event>
  export type Type = Event["type"]
}
