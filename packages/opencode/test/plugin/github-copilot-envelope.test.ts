import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  envelopeFetch,
  envelopeEnabled,
  routedFetch,
  selectAccount,
  spreadIndex,
} from "@/plugin/github-copilot/copilot"
import { empty, mark, markDeactivated, type State } from "@/plugin/github-copilot/connections"
import type { CopilotAuth } from "@/plugin/github-copilot/auth"

const origFetch = globalThis.fetch
const origEnv = process.env.OPENCODE_COPILOT_PROXY_ENVELOPE

afterEach(() => {
  globalThis.fetch = origFetch
  if (origEnv === undefined) delete process.env.OPENCODE_COPILOT_PROXY_ENVELOPE
  else process.env.OPENCODE_COPILOT_PROXY_ENVELOPE = origEnv
})

describe("envelopeEnabled", () => {
  test("returns true when cfg.envelope is true", () => {
    expect(envelopeEnabled({ envelope: true })).toBe(true)
  })

  test("returns true when env var is set", () => {
    process.env.OPENCODE_COPILOT_PROXY_ENVELOPE = "1"
    expect(envelopeEnabled()).toBe(true)
    expect(envelopeEnabled({})).toBe(true)
  })

  test("returns false otherwise", () => {
    delete process.env.OPENCODE_COPILOT_PROXY_ENVELOPE
    expect(envelopeEnabled()).toBe(false)
    expect(envelopeEnabled({ envelope: false })).toBe(false)
  })
})

describe("envelopeFetch (Rust-compatible POST /fetch wrapper)", () => {
  test("wraps GET as POST {proxy}/fetch with JSON envelope and Bearer token", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = mock((url: any, init: any) => {
      calls.push({ url: String(url), init })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status_code: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: true }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch

    const res = await envelopeFetch(
      "https://api.githubcopilot.com/models",
      { method: "GET", headers: { Authorization: "Bearer inner-token" } },
      { url: "https://gcp-proxy.example", token: "ptok" },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://gcp-proxy.example/fetch")
    expect(calls[0].init?.method).toBe("POST")

    const sentHeaders = calls[0].init?.headers as Record<string, string>
    expect(sentHeaders["Authorization"]).toBe("Bearer ptok")
    expect(sentHeaders["Content-Type"]).toBe("application/json")

    const body = JSON.parse(calls[0].init?.body as string) as Record<string, any>
    expect(body.url).toBe("https://api.githubcopilot.com/models")
    expect(body.method).toBe("GET")
    expect(body.headers.Authorization).toBe("Bearer inner-token")
    expect(body.timeout_ms).toBe(120_000)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test("forwards POST body in envelope and decodes inner status_code", async () => {
    let captured: any = null
    globalThis.fetch = mock((_url: any, init: any) => {
      captured = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status_code: 429,
            headers: { "retry-after": "60" },
            body: "rate limited",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch

    const res = await envelopeFetch(
      "https://api.githubcopilot.com/chat/completions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"messages":[]}' },
      { url: "https://gcp-proxy.example", token: "ptok" },
    )

    expect(captured.method).toBe("POST")
    expect(captured.data).toBe('{"messages":[]}')
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("60")
    expect(await res.text()).toBe("rate limited")
  })

  test("strips Content-Length / Host from forwarded inner headers", async () => {
    let captured: any = null
    globalThis.fetch = mock((_url: any, init: any) => {
      captured = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({ status_code: 200, headers: {}, body: "ok" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch
    await envelopeFetch(
      "https://api.githubcopilot.com/x",
      { method: "POST", headers: { "Content-Length": "999", Host: "evil.example", Foo: "bar" } },
      { url: "https://gcp-proxy.example" },
    )
    expect(captured.headers).toEqual({ Foo: "bar" })
  })

  test("surfaces proxy-side error when proxy itself returns non-2xx", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("upstream went away", { status: 502 })),
    ) as unknown as typeof fetch
    const res = await envelopeFetch("https://api.githubcopilot.com/models", undefined, {
      url: "https://gcp-proxy.example",
    })
    expect(res.status).toBe(502)
    expect(res.headers.get("x-copilot-proxy-error")).toBe("1")
  })

  test("relative request paths resolve against proxy base URL inside envelope", async () => {
    let captured: any = null
    globalThis.fetch = mock((_u: any, init: any) => {
      captured = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(JSON.stringify({ status_code: 200, headers: {}, body: "" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch
    await envelopeFetch("/chat/completions", { method: "POST" }, { url: "https://gcp-proxy.example" })
    expect(captured.url).toBe("https://gcp-proxy.example/chat/completions")
  })
})

describe("routedFetch envelope opt-in", () => {
  test("opts into envelope when cfg.envelope is true", async () => {
    const calls: string[] = []
    globalThis.fetch = mock((url: any) => {
      calls.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify({ status_code: 200, headers: {}, body: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch
    await routedFetch("https://api.githubcopilot.com/models", undefined, {
      url: "https://gcp-proxy.example",
      token: "ptok",
      envelope: true,
    })
    expect(calls[0]).toBe("https://gcp-proxy.example/fetch")
  })

  test("opts into envelope when env var is set", async () => {
    process.env.OPENCODE_COPILOT_PROXY_ENVELOPE = "1"
    const calls: string[] = []
    globalThis.fetch = mock((url: any) => {
      calls.push(String(url))
      return Promise.resolve(
        new Response(JSON.stringify({ status_code: 200, headers: {}, body: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
    }) as unknown as typeof fetch
    await routedFetch("https://api.githubcopilot.com/models", undefined, {
      url: "https://gcp-proxy.example",
      token: "ptok",
    })
    expect(calls[0]).toBe("https://gcp-proxy.example/fetch")
  })

  test("falls back to URL-rewrite path when envelope not opted in", async () => {
    delete process.env.OPENCODE_COPILOT_PROXY_ENVELOPE
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = mock((url: any, init: any) => {
      calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} })
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    await routedFetch("/chat/completions", { headers: { a: "b" } }, {
      url: "https://gcp-proxy.example",
      token: "ptok",
    })
    expect(calls[0].url).toBe("https://gcp-proxy.example/chat/completions")
    expect(calls[0].headers["x-copilot-proxy-token"]).toBe("ptok")
  })
})

// ---------------------------------------------------------------------------
// Regression: `format: json_schema` on `/turn/start` produced
// `400 {"error":{"code":"invalid_request_body","message":"request body is
// not valid JSON"}}` upstream because the envelope proxy path dropped the
// request body (it was being sent under `body` instead of `data`). The fix
// lives in `envelopeFetch` (`046ef5eab`). These tests lock in the contract
// that **both** call shapes routed through `routedFetch` — vanilla
// `github-copilot` (no proxy) and `github-copilot#<suffix>` (proxy +
// envelope) — preserve the caller-supplied POST body verbatim, so a
// `response_format: {type: "json_schema", ...}` payload lands at Copilot
// intact regardless of account routing.
// ---------------------------------------------------------------------------
describe("routedFetch body preservation (json_schema regression)", () => {
  const CHAT_URL = "https://api.githubcopilot.com/chat/completions"
  const CHAT_BODY = JSON.stringify({
    model: "gpt-4.1",
    messages: [{ role: "user", content: "Say hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "StructuredOutput",
          parameters: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
        },
      },
    ],
    tool_choice: "required",
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "response",
        schema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
      },
    },
  })

  test("vanilla (no proxy): forwards POST body verbatim to upstream", async () => {
    delete process.env.OPENCODE_COPILOT_PROXY_ENVELOPE
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = mock((url: any, init: any) => {
      calls.push({ url: String(url), init })
      return Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    }) as unknown as typeof fetch
    // No cfg at all — the vanilla `github-copilot` account routes here.
    await routedFetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: CHAT_BODY,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(CHAT_URL)
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBe(CHAT_BODY)
    // The serialized body must still parse — the upstream 400 message
    // "request body is not valid JSON" means an empty / malformed inner
    // body reached Copilot. Guarding the structural invariants here
    // catches any future body-rewriting regression before we pay the
    // round-trip cost.
    const parsed = JSON.parse(calls[0].init?.body as string) as Record<string, any>
    expect(parsed.response_format?.type).toBe("json_schema")
    expect(parsed.response_format?.json_schema?.schema?.properties?.msg?.type).toBe("string")
  })

  test("suffix-routed (envelope proxy): forwards body under `data` field", async () => {
    let captured: any = null
    globalThis.fetch = mock((_url: any, init: any) => {
      captured = JSON.parse(init.body as string)
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status_code: 200,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ choices: [] }),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
    }) as unknown as typeof fetch
    await routedFetch(
      CHAT_URL,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: CHAT_BODY },
      { url: "https://gcp-proxy.example", token: "ptok", envelope: true },
    )
    // The fix for this bug (commit 046ef5eab) mandates the inner body
    // arrives under `data` (not `body`). Without it the GCP fetch-proxy
    // silently drops the payload and Copilot replies with
    // `400 invalid_request_body`.
    expect(captured.data).toBe(CHAT_BODY)
    expect(captured.body).toBeUndefined()
    // Inner headers still carry the upstream Content-Type so Copilot's
    // schema validator parses the JSON.
    expect(captured.headers["Content-Type"]).toBe("application/json")
    const parsed = JSON.parse(captured.data as string) as Record<string, any>
    expect(parsed.response_format?.type).toBe("json_schema")
    expect(parsed.response_format?.json_schema?.schema?.properties?.msg?.type).toBe("string")
  })

  test("URL-rewrite proxy (no envelope) also carries body verbatim", async () => {
    delete process.env.OPENCODE_COPILOT_PROXY_ENVELOPE
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    globalThis.fetch = mock((url: any, init: any) => {
      calls.push({ url: String(url), init })
      return Promise.resolve(new Response(JSON.stringify({ choices: [] }), { status: 200 }))
    }) as unknown as typeof fetch
    await routedFetch(
      "/chat/completions",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: CHAT_BODY },
      { url: "https://url-rewrite-proxy.example", token: "ptok" },
    )
    expect(calls[0].url).toBe("https://url-rewrite-proxy.example/chat/completions")
    // Caller-supplied body must pass through untouched.
    expect(calls[0].init?.body).toBe(CHAT_BODY)
    // Proxy token is injected as a header, not a body field.
    expect((calls[0].init?.headers as Record<string, string>)["x-copilot-proxy-token"]).toBe("ptok")
  })
})

describe("spreadIndex (deterministic-when-pinned random spread)", () => {
  test("returns 0 when length is 0 or 1", () => {
    expect(spreadIndex(0, 12345)).toBe(0)
    expect(spreadIndex(1, 12345)).toBe(0)
  })

  test("is deterministic for a given (length, now) pair", () => {
    expect(spreadIndex(7, 1_700_000_000_123)).toBe(spreadIndex(7, 1_700_000_000_123))
  })

  test("produces different residues for adjacent millisecond seeds", () => {
    const a = spreadIndex(5, 1_700_000_000_000)
    const b = spreadIndex(5, 1_700_000_000_001)
    expect(a !== b || spreadIndex(5, 1_700_000_000_002) !== a).toBe(true)
  })

  test("uniformly covers all indices over many seeds", () => {
    const len = 4
    const seen = new Set<number>()
    for (let now = 0; now < 1_000; now += 7) seen.add(spreadIndex(len, now))
    expect(seen.size).toBe(len)
  })
})

describe("selectAccount randomized startup spread", () => {
  const auths = (n: number): CopilotAuth[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `github-copilot${i === 0 ? "" : `#alt-${i}`}`,
      label: `acct-${i}`,
      refresh: `tok-${i}`,
      access: `tok-${i}`,
      expires: 0,
    }))

  test("custom pick lets tests pin a specific tier index", () => {
    const list = auths(4)
    const pick = mock((len: number) => 2)
    const got = selectAccount({
      auths: list,
      state: empty(),
      fallback: list[0],
      now: 0,
      pick: pick as unknown as (len: number, now: number) => number,
    })
    expect(got.key).toBe(list[2].key)
    expect(pick).toHaveBeenCalledTimes(1)
  })

  test("spread is deterministic when 'now' is pinned", () => {
    const list = auths(5)
    const a = selectAccount({ auths: list, state: empty(), fallback: list[0], now: 42_000 })
    const b = selectAccount({ auths: list, state: empty(), fallback: list[0], now: 42_000 })
    expect(a.key).toBe(b.key)
  })

  test("spreads selections across the healthy tier over many seeds", () => {
    const list = auths(4)
    const seen = new Set<string>()
    for (let now = 0; now < 200; now += 17) {
      seen.add(selectAccount({ auths: list, state: empty(), fallback: list[0], now }).key)
    }
    expect(seen.size).toBeGreaterThanOrEqual(2)
  })

  test("excludes accounts in 429 cooldown from the live tier", () => {
    const list = auths(3)
    let state: State = empty()
    state = mark(state, list[0].key, 1_000)
    state = mark(state, list[1].key, 1_000)
    // Only list[2] is live.
    for (let now = 0; now < 50; now += 7) {
      const got = selectAccount({ auths: list, state, fallback: list[0], now: 100 })
      expect(got.key).toBe(list[2].key)
    }
  })

  test("excludes deactivated accounts from candidate pool", () => {
    const list = auths(3)
    let state: State = empty()
    state = markDeactivated(state, list[0].key)
    state = markDeactivated(state, list[1].key)
    const got = selectAccount({ auths: list, state, fallback: list[0], now: 12345 })
    expect(got.key).toBe(list[2].key)
  })

  test("falls back to the cooldown tier when every account is exhausted (still picks one)", () => {
    const list = auths(3)
    let state: State = empty()
    for (const a of list) state = mark(state, a.key, 100_000)
    const got = selectAccount({ auths: list, state, fallback: list[0], now: 0 })
    // We still get something — Rust's behavior: after-cooldown pool fallback.
    expect(list.some((a) => a.key === got.key)).toBe(true)
  })

  test("returns fallback when auths list is empty", () => {
    const fallback: CopilotAuth = {
      key: "github-copilot",
      label: "Primary",
      refresh: "x",
      access: "x",
      expires: 0,
    }
    expect(selectAccount({ auths: [], state: empty(), fallback }).key).toBe("github-copilot")
  })
})
