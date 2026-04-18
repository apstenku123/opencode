/** @jsxImportSource @opentui/solid */
/**
 * Integration smoke test — verify that a `question.forwarded_to_parent`
 * global event propagates into `useSync().data.forwarded_question` and
 * that a subsequent `question.replied`/`question.rejected` for the same
 * `requestID` dismisses the corresponding entry.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { ForwardedQueue } from "../../../../src/cli/cmd/tui/routes/session/forwarded-queue"

const sighup = new Set(process.listeners("SIGHUP"))

afterEach(() => {
  for (const fn of process.listeners("SIGHUP")) {
    if (!sighup.has(fn)) process.off("SIGHUP", fn)
  }
})

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: {
      "content-type": "application/json",
    },
  })
}

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function createFetch() {
  return Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init)
      const url = new URL(req.url)
      // Generic empty responses — SyncProvider bootstrap is not the
      // focus of this test.
      const empty: Record<string, unknown> = {
        "/config/providers": { providers: [], default: {} },
        "/provider": { all: [], default: {}, connected: [] },
        "/experimental/console": {},
        "/agent": [],
        "/config": {},
        "/project/current": { id: "proj" },
        "/path": { state: "/tmp/state", config: "/tmp/config", worktree: "/tmp", directory: "/tmp" },
        "/session": [],
        "/command": [],
        "/lsp": [],
        "/mcp": {},
        "/experimental/resource": {},
        "/formatter": [],
        "/session/status": {},
        "/provider/auth": {},
        "/vcs": { branch: "main" },
        "/experimental/workspace": [],
      }
      if (url.pathname in empty) return json(empty[url.pathname])
      throw new Error(`unexpected request: ${req.method} ${url.pathname}`)
    },
    { preconnect: fetch.preconnect.bind(fetch) },
  ) satisfies typeof fetch
}

function makeEventSource() {
  let emit!: (event: GlobalEvent) => void
  return {
    source: {
      subscribe: async (handler: (event: GlobalEvent) => void) => {
        emit = handler
        return () => {}
      },
    },
    emit: (event: GlobalEvent) => emit(event),
  }
}

function Probe(props: { onReady: (sync: ReturnType<typeof useSync>) => void }) {
  const sync = useSync()
  onMount(() => props.onReady(sync))
  return <box />
}

async function mount() {
  const events = makeEventSource()
  let sync!: ReturnType<typeof useSync>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory="/tmp" fetch={createFetch()} events={events.source}>
      <ArgsProvider continue={false}>
        <ExitProvider>
          <ProjectProvider>
            <SyncProvider>
              <Probe
                onReady={(ctx) => {
                  sync = ctx
                  done()
                }}
              />
            </SyncProvider>
          </ProjectProvider>
        </ExitProvider>
      </ArgsProvider>
    </SDKProvider>
  ))

  await ready
  return { app, sync, emit: events.emit }
}

function forwardedEvent(requestID: string, parentID = "ses_parent", childID = "ses_child"): GlobalEvent {
  return {
    directory: "/tmp",
    payload: {
      type: "question.forwarded_to_parent",
      properties: {
        parentID,
        childID,
        requestID,
        request: {
          id: requestID,
          sessionID: childID,
          questions: [
            {
              question: "Proceed?",
              header: "test-action",
              options: [
                { label: "Allow", description: "approve" },
                { label: "Deny", description: "deny" },
              ],
            },
          ],
        },
      },
    },
  }
}

function repliedEvent(requestID: string, sessionID = "ses_child"): GlobalEvent {
  return {
    directory: "/tmp",
    payload: {
      type: "question.replied",
      properties: {
        sessionID,
        requestID,
        answers: [["Allow"]],
      },
    },
  }
}

describe("SyncProvider — forwarded question events", () => {
  test("question.forwarded_to_parent enqueues under parentID", async () => {
    const { app, sync, emit } = await mount()
    try {
      emit(forwardedEvent("que_1"))
      await wait(() => ForwardedQueue.list(sync.data.forwarded_question, "ses_parent").length === 1)
      const head = ForwardedQueue.head(sync.data.forwarded_question, "ses_parent")
      expect(head?.requestID).toBe("que_1")
      expect(head?.childID).toBe("ses_child")
    } finally {
      app.renderer.destroy()
    }
  })

  test("multiple forwarded events preserve FIFO order", async () => {
    const { app, sync, emit } = await mount()
    try {
      emit(forwardedEvent("que_1"))
      emit(forwardedEvent("que_2"))
      emit(forwardedEvent("que_3"))
      await wait(() => ForwardedQueue.list(sync.data.forwarded_question, "ses_parent").length === 3)
      const list = ForwardedQueue.list(sync.data.forwarded_question, "ses_parent")
      expect(list.map((e) => e.requestID)).toEqual(["que_1", "que_2", "que_3"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("question.replied dismisses the matching forwarded entry", async () => {
    const { app, sync, emit } = await mount()
    try {
      emit(forwardedEvent("que_1"))
      emit(forwardedEvent("que_2"))
      await wait(() => ForwardedQueue.list(sync.data.forwarded_question, "ses_parent").length === 2)

      emit(repliedEvent("que_1"))
      await wait(() => ForwardedQueue.list(sync.data.forwarded_question, "ses_parent").length === 1)

      const head = ForwardedQueue.head(sync.data.forwarded_question, "ses_parent")
      expect(head?.requestID).toBe("que_2")
    } finally {
      app.renderer.destroy()
    }
  })
})
