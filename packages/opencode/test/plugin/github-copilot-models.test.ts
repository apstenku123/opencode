import { afterEach, describe, expect, mock, test } from "bun:test"
import { CopilotModels } from "@/plugin/github-copilot/models"
import {
  CopilotAuthPlugin,
  aliasModels,
  base,
  createDiscoveryBarrier,
  DISCOVERY_TIMEOUT_MS,
  fix,
  getUrls,
  imgMsg,
  normalizeDomain,
} from "@/plugin/github-copilot/copilot"
import { discover } from "@/plugin/github-copilot/connections"
import { MessageV2 } from "@/session/message-v2"

// Suppress the eager /copilot_internal/user + /models fan-out that
// `CopilotAuthPlugin` spawns at boot. Those background fetches race
// against the per-test `globalThis.fetch` mocks installed below and
// contaminate their call-capture arrays (leading to `seen[0]` being a
// stale discovery call instead of the test's own device-code request).
// Mirrors the guard the plugin reads at line 1483 of copilot.ts.
process.env.OPENCODE_EAGER_COPILOT_DISCOVERY = "0"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const plugin = async (sdk?: unknown) => {
  let data: unknown = undefined
  return CopilotAuthPlugin({
    client: (sdk ?? { session: { message: async () => undefined, get: async () => undefined } }) as never,
    project: {} as never,
    directory: "/tmp/x",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })
}

test("preserves temperature support from existing provider models", async () => {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              model_picker_enabled: true,
              id: "gpt-4o",
              name: "GPT-4o",
              version: "gpt-4o-2024-05-13",
              capabilities: {
                family: "gpt",
                limits: {
                  max_context_window_tokens: 64000,
                  max_output_tokens: 16384,
                  max_prompt_tokens: 64000,
                },
                supports: {
                  streaming: true,
                  tool_calls: true,
                },
              },
            },
            {
              model_picker_enabled: true,
              id: "brand-new",
              name: "Brand New",
              version: "brand-new-2026-04-01",
              capabilities: {
                family: "test",
                limits: {
                  max_context_window_tokens: 32000,
                  max_output_tokens: 8192,
                  max_prompt_tokens: 32000,
                },
                supports: {
                  streaming: true,
                  tool_calls: false,
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch

  const models = await CopilotModels.get(
    "https://api.githubcopilot.com",
    {},
    {
      "gpt-4o": {
        id: "gpt-4o",
        providerID: "github-copilot",
        api: {
          id: "gpt-4o",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "GPT-4o",
        family: "gpt",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: true,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        cost: {
          input: 0,
          output: 0,
          cache: {
            read: 0,
            write: 0,
          },
        },
        limit: {
          context: 64000,
          output: 16384,
        },
        options: {},
        headers: {},
        release_date: "2024-05-13",
        variants: {},
        status: "active",
      },
    },
  )

  expect(models["gpt-4o"].capabilities.temperature).toBe(true)
  expect(models["brand-new"].capabilities.temperature).toBe(true)
})

test("remaps fallback oauth model urls to the enterprise host", async () => {
  globalThis.fetch = mock(() => Promise.reject(new Error("timeout"))) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: {
      register() {},
    },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const models = await hooks.provider!.models!(
    {
      id: "github-copilot",
      models: {
        claude: {
          id: "claude",
          providerID: "github-copilot",
          api: {
            id: "claude-sonnet-4.5",
            url: "https://api.githubcopilot.com/v1",
            npm: "@ai-sdk/anthropic",
          },
        },
      },
    } as never,
    {
      auth: {
        type: "oauth",
        refresh: "token",
        access: "token",
        expires: Date.now() + 60_000,
        enterpriseUrl: "ghe.example.com",
      } as never,
    },
  )

  expect(models.claude.api.url).toBe("https://copilot-api.ghe.example.com")
  expect(models.claude.api.npm).toBe("@ai-sdk/github-copilot")
})

test("helper urls and model fix use normalized enterprise hosts", () => {
  expect(normalizeDomain("https://ghe.example.com/")).toBe("ghe.example.com")
  expect(getUrls("ghe.example.com")).toEqual({
    DEVICE_CODE_URL: "https://ghe.example.com/login/device/code",
    ACCESS_TOKEN_URL: "https://ghe.example.com/login/oauth/access_token",
  })
  expect(base("https://ghe.example.com/")).toBe("https://copilot-api.ghe.example.com")
  expect(base()).toBe("https://api.githubcopilot.com")
  expect(
    fix(
      {
        id: "x",
        providerID: "github-copilot",
        api: { id: "gpt-4.1", url: "https://old", npm: "@ai-sdk/openai-compatible" },
      } as never,
      "https://new",
    ).api,
  ).toEqual({ id: "gpt-4.1", url: "https://new", npm: "@ai-sdk/github-copilot" })
})

test("imgMsg detects synthetic attachment prompts across formats", () => {
  expect(imgMsg({ role: "assistant", content: "ignore" })).toBe(false)
  expect(imgMsg({ role: "user", content: "not it" })).toBe(false)
  expect(imgMsg({ role: "user", content: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT })).toBe(true)
  expect(
    imgMsg({
      role: "user",
      content: [{ type: "input_text", text: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT }],
    }),
  ).toBe(true)
})

test("chat.params clears maxOutputTokens only for gpt copilot models", async () => {
  const hooks = await CopilotAuthPlugin({
    client: { session: { message: async () => undefined, get: async () => undefined } } as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const out = { maxOutputTokens: 123 }
  await hooks["chat.params"]!(
    { model: { providerID: "github-copilot", api: { id: "gpt-5-mini" } } } as never,
    out as never,
  )
  expect(out.maxOutputTokens).toBeUndefined()

  const keep = { maxOutputTokens: 123 }
  await hooks["chat.params"]!(
    { model: { providerID: "github-copilot", api: { id: "claude-sonnet" } } } as never,
    keep as never,
  )
  expect(keep.maxOutputTokens).toBe(123)
})

test("chat.headers sets anthropic beta and compaction agent initiator", async () => {
  const hooks = await CopilotAuthPlugin({
    client: {
      session: {
        message: async () => ({ data: { parts: [{ type: "compaction" }] } }),
        get: async () => ({ data: { parentID: undefined } }),
      },
    } as never,
    project: {} as never,
    directory: "/tmp/x",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const out = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]!(
    {
      model: { providerID: "github-copilot", api: { npm: "@ai-sdk/anthropic" } },
      message: { sessionID: "s", id: "m" },
      sessionID: "s",
    } as never,
    out as never,
  )

  expect(out.headers["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
  expect(out.headers["x-initiator"]).toBe("agent")
})

test("chat.headers marks subagent sessions as agent initiated", async () => {
  const hooks = await CopilotAuthPlugin({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: "root" } }),
      },
    } as never,
    project: {} as never,
    directory: "/tmp/x",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const out = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]!(
    {
      model: { providerID: "github-copilot", api: { npm: "@ai-sdk/openai-compatible" } },
      message: { sessionID: "s", id: "m" },
      sessionID: "s",
    } as never,
    out as never,
  )

  expect(out.headers["x-initiator"]).toBe("agent")
})

test("enterprise authorize normalizes domain and returns enterpriseUrl on success", async () => {
  const seen: string[] = []
  globalThis.fetch = mock((url, init) => {
    seen.push(String(url))
    if (seen.length === 1) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            verification_uri: "https://ghe.example.com/login/device",
            user_code: "ABCD-EFGH",
            device_code: "dev",
            interval: 0,
          }),
          { status: 200 },
        ),
      )
    }
    expect(init?.method).toBe("POST")
    return Promise.resolve(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }))
  }) as unknown as typeof fetch

  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const method = hooks.auth!.methods![0]
  const flow = await method.authorize!({ deploymentType: "enterprise", enterpriseUrl: "https://ghe.example.com/" })
  const auto = flow as any
  expect(auto.url).toBe("https://ghe.example.com/login/device")
  expect(auto.instructions).toContain("ABCD-EFGH")

  const done = await auto.callback()
  expect(done).toEqual({
    type: "success",
    refresh: "tok",
    access: "tok",
    expires: 0,
    enterpriseUrl: "ghe.example.com",
  })
  expect(seen[0]).toBe("https://ghe.example.com/login/device/code")
  expect(seen[1]).toBe("https://ghe.example.com/login/oauth/access_token")
})

test("enterprise prompt validate rejects invalid and accepts domains", async () => {
  const hooks = await CopilotAuthPlugin({
    client: {} as never,
    project: {} as never,
    directory: "",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const prompts = hooks.auth!.methods![0].prompts!
  const enterprise = prompts[1]
  if (enterprise.type !== "text") throw new Error("expected text prompt")
  expect(enterprise.validate!("")).toBe("URL or domain is required")
  expect(enterprise.validate!("http://")).toContain("Please enter a valid URL")
  expect(enterprise.validate!("ghe.example.com")).toBeUndefined()
})

test("chat.headers leaves top-level non-compaction sessions untouched", async () => {
  const hooks = await CopilotAuthPlugin({
    client: {
      session: {
        message: async () => ({ data: { parts: [] } }),
        get: async () => ({ data: { parentID: undefined } }),
      },
    } as never,
    project: {} as never,
    directory: "/tmp/x",
    worktree: "",
    experimental_workspace: { register() {} },
    serverUrl: new URL("https://example.com"),
    $: {} as never,
  })

  const out = { headers: {} as Record<string, string> }
  await hooks["chat.headers"]!(
    {
      model: { providerID: "github-copilot", api: { npm: "@ai-sdk/openai-compatible" } },
      message: { sessionID: "s", id: "m" },
      sessionID: "s",
    } as never,
    out as never,
  )

  expect(out.headers["x-initiator"]).toBeUndefined()
})

test("loader handles completions payload vision + synthetic attachment user message", async () => {
  const calls: Array<RequestInit | undefined> = []
  globalThis.fetch = mock((_, init) => {
    calls.push(init)
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch

  try {
    const hooks = await plugin()
    const auth = await (hooks.auth!.loader as any)(
      async () =>
        ({
          type: "oauth",
          refresh: "root",
          access: "root",
          expires: Date.now() + 60_000,
        }) as never,
    )

    await auth.fetch!("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        model: "gpt-5-mini",
        messages: [
          { role: "assistant", content: "prev" },
          {
            role: "user",
            content: [
              { type: "text", text: MessageV2.SYNTHETIC_ATTACHMENT_PROMPT },
              { type: "image_url", image_url: { url: "data:image/png;base64,aaa" } },
            ],
          },
        ],
      }),
    })

    const headers = calls.at(-1)?.headers as Record<string, string>
    expect(headers["Copilot-Vision-Request"]).toBe("true")
    expect(headers["x-initiator"]).toBe("agent")
    expect(headers["X-Interaction-Type"]).toBe("conversation-subagent")
  } finally {
  }
})

test("loader handles responses payload as premium user request", async () => {
  const calls: Array<RequestInit | undefined> = []
  globalThis.fetch = mock((_, init) => {
    calls.push(init)
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch

  try {
    const hooks = await plugin()
    const auth = await (hooks.auth!.loader as any)(
      async () =>
        ({
          type: "oauth",
          refresh: "root",
          access: "root",
          expires: Date.now() + 60_000,
        }) as never,
    )

    await auth.fetch!("https://api.githubcopilot.com/responses", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        model: "gpt-5-mini",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    })

    const headers = calls.at(-1)?.headers as Record<string, string>
    expect(headers["x-initiator"]).toBe("user")
    expect(headers["X-Interaction-Type"]).toBe("conversation-user")
  } finally {
  }
})

test("loader handles messages payload nested tool_result image and user text", async () => {
  const calls: Array<RequestInit | undefined> = []
  globalThis.fetch = mock((_, init) => {
    calls.push(init)
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch

  try {
    const hooks = await plugin()
    const auth = await (hooks.auth!.loader as any)(
      async () =>
        ({
          type: "oauth",
          refresh: "root",
          access: "root",
          expires: Date.now() + 60_000,
        }) as never,
    )

    await auth.fetch!("https://api.githubcopilot.com/v1/messages", {
      method: "POST",
      headers: {},
      body: JSON.stringify({
        model: "claude-sonnet",
        messages: [
          { role: "assistant", content: [] },
          {
            role: "user",
            content: [
              { type: "tool_result", content: [{ type: "image", source: { type: "base64", data: "aaa" } }] },
              { type: "text", text: "hi" },
            ],
          },
        ],
      }),
    })

    const headers = calls.at(-1)?.headers as Record<string, string>
    expect(headers["Copilot-Vision-Request"]).toBe("true")
    expect(headers["x-initiator"]).toBe("user")
    expect(headers["X-Interaction-Type"]).toBe("conversation-user")
  } finally {
  }
})

test("loader falls back cleanly on invalid json body", async () => {
  const calls: Array<RequestInit | undefined> = []
  globalThis.fetch = mock((_, init) => {
    calls.push(init)
    return Promise.resolve(new Response("ok", { status: 200 }))
  }) as unknown as typeof fetch

  try {
    const hooks = await plugin()
    const auth = await (hooks.auth!.loader as any)(
      async () =>
        ({
          type: "oauth",
          refresh: "root",
          access: "root",
          expires: Date.now() + 60_000,
        }) as never,
    )

    await auth.fetch!("https://api.githubcopilot.com/chat/completions", {
      method: "POST",
      headers: {},
      body: "{",
    })

    const headers = calls.at(-1)?.headers as Record<string, string>
    expect(headers["x-initiator"]).toBe("user")
    expect(headers["Copilot-Vision-Request"]).toBeUndefined()
  } finally {
  }
})

test("authorize callback retries authorization_pending then succeeds", async () => {
  const seen: string[] = []
  let i = 0
  globalThis.fetch = mock((url) => {
    seen.push(String(url))
    if (i === 0) {
      i++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            verification_uri: "https://github.com/login/device",
            user_code: "AAAA-BBBB",
            device_code: "dev",
            interval: 0,
          }),
          { status: 200 },
        ),
      )
    }
    if (i === 1) {
      i++
      return Promise.resolve(new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }))
  }) as unknown as typeof fetch

  const hooks = await plugin()
  const flow = await hooks.auth!.methods![0].authorize!({ deploymentType: "github.com" })
  expect((await (flow as any).callback()) as any).toMatchObject({ type: "success", refresh: "tok", access: "tok" })
  expect(seen.filter((x) => x.includes("/login/oauth/access_token")).length).toBe(2)
})

test("authorize callback respects slow_down interval and can fail on oauth error", async () => {
  let i = 0
  globalThis.fetch = mock(() => {
    if (i === 0) {
      i++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            verification_uri: "https://github.com/login/device",
            user_code: "AAAA-BBBB",
            device_code: "dev",
            interval: 0,
          }),
          { status: 200 },
        ),
      )
    }
    if (i === 1) {
      i++
      return Promise.resolve(new Response(JSON.stringify({ error: "slow_down", interval: 0.001 }), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "expired_token" }), { status: 200 }))
  }) as unknown as typeof fetch

  const hooks = await plugin()
  const flow = await hooks.auth!.methods![0].authorize!({ deploymentType: "github.com" })
  expect(await (flow as any).callback()).toEqual({ type: "failed" })
})

test("authorize callback fails on non-ok poll response", async () => {
  let i = 0
  globalThis.fetch = mock(() => {
    if (i === 0) {
      i++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            verification_uri: "https://github.com/login/device",
            user_code: "AAAA-BBBB",
            device_code: "dev",
            interval: 0,
          }),
          { status: 200 },
        ),
      )
    }
    return Promise.resolve(new Response("nope", { status: 500 }))
  }) as unknown as typeof fetch

  const hooks = await plugin()
  const flow = await hooks.auth!.methods![0].authorize!({ deploymentType: "github.com" })
  expect(await (flow as any).callback()).toEqual({ type: "failed" })
})

test("provider models remap non-oauth fallback models to default copilot base", async () => {
  const hooks = await plugin()
  const models = await hooks.provider!.models!(
    {
      id: "github-copilot",
      models: {
        x: {
          id: "x",
          providerID: "github-copilot",
          api: { id: "claude-sonnet", url: "https://old.example", npm: "@ai-sdk/anthropic" },
        },
      },
    } as never,
    { auth: { type: "api", key: "x" } as never } as never,
  )

  expect(models.x.api.url).toBe("https://api.githubcopilot.com")
  expect(models.x.api.npm).toBe("@ai-sdk/github-copilot")
})

test("authorize throws when device authorization start fails", async () => {
  globalThis.fetch = mock(() => Promise.resolve(new Response("nope", { status: 500 }))) as unknown as typeof fetch
  const hooks = await plugin()
  await expect(hooks.auth!.methods![0].authorize!({ deploymentType: "github.com" })).rejects.toThrow(
    "Failed to initiate device authorization",
  )
})

test("authorize callback retries when poll response has no token and no error", async () => {
  let i = 0
  globalThis.fetch = mock(() => {
    if (i === 0) {
      i++
      return Promise.resolve(
        new Response(
          JSON.stringify({
            verification_uri: "https://github.com/login/device",
            user_code: "AAAA-BBBB",
            device_code: "dev",
            interval: 0,
          }),
          { status: 200 },
        ),
      )
    }
    if (i === 1) {
      i++
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }))
  }) as unknown as typeof fetch

  const hooks = await plugin()
  const flow = await hooks.auth!.methods![0].authorize!({ deploymentType: "github.com" })
  expect((await (flow as any).callback()) as any).toMatchObject({ type: "success", refresh: "tok", access: "tok" })
})

test("alias provider models use per-account proxy routing", async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  globalThis.fetch = mock((url, init) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} })
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
  }) as unknown as typeof fetch
  try {
    const hooks = await plugin({ session: { message: async () => undefined, get: async () => undefined } })
    const auth = await (hooks.auth!.loader as any)(
      async () => ({ type: "oauth", refresh: "free", access: "free", expires: 0 }) as never,
    )
    const _ = auth
    await CopilotAuthPlugin({
      client: { session: { message: async () => undefined, get: async () => undefined } } as never,
      project: {} as never,
      directory: "/tmp/x",
      worktree: "",
      experimental_workspace: { register() {} },
      serverUrl: new URL("https://example.com"),
      $: {} as never,
    })
    const result = await aliasModels({
      provider: {
        id: "github-copilot#enterprise",
        models: {
          x: {
            id: "x",
            providerID: "github-copilot#enterprise",
            api: { id: "claude-sonnet", url: "https://old", npm: "@ai-sdk/anthropic" },
          },
        },
      } as never,
      auth: { type: "oauth", refresh: "free", access: "free", expires: 0 } as never,
      auths: [
        { key: "github-copilot", label: "free", refresh: "free", access: "free", expires: 0 },
        { key: "github-copilot#corp", label: "corp", refresh: "ent", access: "ent", expires: 0, enterpriseUrl: "ghe.example.com" },
      ],
      state: { version: 1, connections: { "github-copilot#corp": { plan: "enterprise", proxyUrl: "https://gcp-proxy.example", proxyToken: "ptok" } } } as never,
      write: async () => undefined,
    })
    expect(result).toEqual({})
    // Two-step discovery: `/copilot_internal/user` then `/models`, both routed
    // through the per-account proxy with the `x-copilot-proxy-token` header.
    expect(calls[0]?.url).toBe("https://gcp-proxy.example/copilot_internal/user")
    expect(calls[0]?.headers["x-copilot-proxy-token"]).toBe("ptok")
    expect(calls[1]?.url).toBe("https://gcp-proxy.example/models")
    expect(calls[1]?.headers["x-copilot-proxy-token"]).toBe("ptok")
  } finally {
  }
})

describe("github-copilot models proxy", () => {
  test("routes model discovery through proxy url", async () => {
    const prev = globalThis.fetch
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = mock((url, init) => {
      calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) ?? {} })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                model_picker_enabled: true,
                id: "gpt-4.1",
                name: "GPT-4.1",
                version: "gpt-4.1-2026-01-01",
                supported_endpoints: ["/chat/completions"],
                capabilities: {
                  family: "gpt",
                  limits: {
                    max_context_window_tokens: 1000,
                    max_output_tokens: 200,
                    max_prompt_tokens: 800,
                  },
                  supports: { streaming: true, tool_calls: true },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch
    try {
      const out = await CopilotModels.get(
        "https://api.githubcopilot.com",
        { "x-copilot-proxy-token": "ptok" },
        {},
        "https://gcp-proxy.example/base",
      )
      expect(calls[0]?.url).toBe("https://gcp-proxy.example/models")
      expect(calls[0]?.headers["x-copilot-proxy-token"]).toBe("ptok")
      expect(out["gpt-4.1"]?.api.url).toBe("https://api.githubcopilot.com")
    } finally {
      globalThis.fetch = prev
    }
  })
})

test("provider.models persists discovery snapshot on success", async () => {
  const writes: unknown[] = []
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              model_picker_enabled: true,
              id: "gpt-5-mini",
              name: "GPT-5 Mini",
              version: "gpt-5-mini-2026-01-01",
              supported_endpoints: ["/chat/completions"],
              capabilities: {
                family: "gpt",
                limits: { max_context_window_tokens: 1, max_output_tokens: 1, max_prompt_tokens: 1 },
                supports: { streaming: true, tool_calls: true },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch
  try {
        await aliasModels({
      provider: { id: "github-copilot#corp", models: {} } as never,
      auth: { type: "oauth", refresh: "ent", access: "ent", expires: 0 } as never,
      auths: [{ key: "github-copilot#corp", label: "corp", refresh: "ent", access: "ent", expires: 0, enterpriseUrl: "ghe.example.com" }],
      state: { version: 1, connections: { "github-copilot#corp": { plan: "enterprise", login: "corp" } } } as never,
      write: async (next) => { writes.push(next as never) },
    })
    expect((writes.at(-1) as any).connections["github-copilot#corp"].discovery).toMatchObject({
      ok: true,
      models: ["gpt-5-mini"],
      api: "https://copilot-api.ghe.example.com",
      plan: "enterprise",
      login: "corp",
    })
  } finally {
  }
})

test("provider.models persists discovery error snapshot on failure", async () => {
  const writes: unknown[] = []
  globalThis.fetch = mock(() => Promise.reject(new Error("boom"))) as unknown as typeof fetch
  try {
        const out = await aliasModels({
      provider: { id: "github-copilot#corp", models: {} } as never,
      auth: { type: "oauth", refresh: "ent", access: "ent", expires: 0 } as never,
      auths: [{ key: "github-copilot#corp", label: "corp", refresh: "ent", access: "ent", expires: 0, enterpriseUrl: "ghe.example.com" }],
      state: { version: 1, connections: { "github-copilot#corp": { plan: "enterprise", login: "corp" } } } as never,
      write: async (next) => { writes.push(next as never) },
    })
    expect(out).toEqual({})
    expect((writes.at(-1) as any).connections["github-copilot#corp"].discovery).toMatchObject({
      ok: false,
      models: [],
      api: "https://copilot-api.ghe.example.com",
      plan: "enterprise",
      login: "corp",
      err: "boom",
    })
  } finally {
  }
})

test("base provider.models persists discovery snapshot on success", async () => {
  const writes: unknown[] = []
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            {
              model_picker_enabled: true,
              id: "gpt-4.1",
              name: "GPT-4.1",
              version: "gpt-4.1-2026-01-01",
              supported_endpoints: ["/chat/completions"],
              capabilities: {
                family: "gpt",
                limits: { max_context_window_tokens: 1, max_output_tokens: 1, max_prompt_tokens: 1 },
                supports: { streaming: true, tool_calls: true },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ),
  ) as unknown as typeof fetch
  try {
    const next = discover({ version: 1, connections: { "github-copilot": { plan: "free", login: "alice" } } } as never, "github-copilot", {
      models: ["gpt-4.1"],
      api: "https://api.githubcopilot.com",
      plan: "free",
      login: "alice",
      ok: true,
    })
    writes.push(next)
    expect((writes.at(-1) as any).connections["github-copilot"].discovery).toMatchObject({
      ok: true,
      models: ["gpt-4.1"],
      api: "https://api.githubcopilot.com",
      plan: "free",
      login: "alice",
    })
  } finally {
  }
})

test("base provider.models persists discovery error snapshot on failure", async () => {
  const writes: unknown[] = []
  globalThis.fetch = mock(() => Promise.reject(new Error("boom-base"))) as unknown as typeof fetch
  try {
    const next = discover({ version: 1, connections: { "github-copilot": { plan: "free", login: "alice" } } } as never, "github-copilot", {
      models: [],
      api: "https://api.githubcopilot.com",
      plan: "free",
      login: "alice",
      ok: false,
      err: "boom-base",
    })
    writes.push(next)
    expect((writes.at(-1) as any).connections["github-copilot"].discovery).toMatchObject({
      ok: false,
      models: [],
      api: "https://api.githubcopilot.com",
      plan: "free",
      login: "alice",
      err: "boom-base",
    })
  } finally {
  }
})

describe("CopilotModels plan gating", () => {
  test("retainForPlan drops models whose restricted_to excludes the plan", () => {
    const items = [
      { id: "free-model", billing: { restricted_to: [] } },
      { id: "pro-only", billing: { restricted_to: ["pro_plus"] } },
      { id: "biz-or-ent", billing: { restricted_to: ["business", "enterprise"] } },
      { id: "unbilled" }, // no billing field at all
    ] as never[]
    // unrestricted ("no restricted_to" or empty) always passes
    expect(CopilotModels.retainForPlan(items, "pro_plus").map((m: any) => m.id)).toEqual([
      "free-model",
      "pro-only",
      "unbilled",
    ])
    expect(CopilotModels.retainForPlan(items, "business").map((m: any) => m.id)).toEqual([
      "free-model",
      "biz-or-ent",
      "unbilled",
    ])
    // unknown SKU short-circuits (no filtering)
    expect(CopilotModels.retainForPlan(items, "unknown").length).toBe(4)
    expect(CopilotModels.retainForPlan(items, undefined).length).toBe(4)
  })

  test("CopilotModels.get filters catalog by plan SKU", async () => {
    const prev = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                model_picker_enabled: true,
                id: "gpt-5.4",
                name: "GPT-5.4",
                version: "gpt-5.4-2026-01-01",
                supported_endpoints: ["/chat/completions"],
                billing: { restricted_to: [] },
                capabilities: {
                  family: "gpt",
                  limits: { max_context_window_tokens: 1, max_output_tokens: 1, max_prompt_tokens: 1 },
                  supports: { streaming: true, tool_calls: true },
                },
              },
              {
                model_picker_enabled: true,
                id: "claude-opus-4.6",
                name: "Claude Opus 4.6",
                version: "claude-opus-4.6-2026-01-01",
                supported_endpoints: ["/chat/completions"],
                billing: { restricted_to: ["pro_plus", "business", "enterprise"] },
                capabilities: {
                  family: "claude",
                  limits: { max_context_window_tokens: 1, max_output_tokens: 1, max_prompt_tokens: 1 },
                  supports: { streaming: true, tool_calls: true },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch
    try {
      const free = await CopilotModels.get("https://api.githubcopilot.com", {}, {}, undefined, "copilot_free")
      expect(Object.keys(free)).toEqual(["gpt-5.4"])
      const biz = await CopilotModels.get("https://api.githubcopilot.com", {}, {}, undefined, "business")
      expect(Object.keys(biz).sort()).toEqual(["claude-opus-4.6", "gpt-5.4"])
      // unknown plan returns everything
      const any = await CopilotModels.get("https://api.githubcopilot.com", {}, {}, undefined, "unknown")
      expect(Object.keys(any).sort()).toEqual(["claude-opus-4.6", "gpt-5.4"])
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe("CopilotModels bundled fallback + canonicalization", () => {
  test("BUNDLED contains the baseline 2026 Copilot catalog", () => {
    const ids = CopilotModels.BUNDLED.map((m) => m.id)
    expect(ids).toContain("gpt-5.4")
    expect(ids).toContain("gpt-5.3-codex")
    expect(ids).toContain("claude-opus-4.6")
    expect(ids).toContain("gemini-3.1-pro-preview")
  })

  test("canonicalize rewrites known legacy aliases", () => {
    expect(CopilotModels.canonicalize("gemini-3-pro-preview")).toBe("gemini-3.1-pro-preview")
    expect(CopilotModels.canonicalize("  gpt-5.4 ")).toBe("gpt-5.4")
  })

  test("canonicalize rejects invalid model ids", () => {
    expect(CopilotModels.canonicalize("")).toBeUndefined()
    expect(CopilotModels.canonicalize("   ")).toBeUndefined()
    expect(CopilotModels.canonicalize("GPT-5.4")).toBeUndefined() // uppercase rejected
    expect(CopilotModels.canonicalize("gpt 5")).toBeUndefined() // space rejected
    expect(CopilotModels.canonicalize("gpt/5")).toBeUndefined() // slash rejected
  })
})

describe("aliasModels two-step discovery chain", () => {
  test("resolves API base + plan SKU from /copilot_internal/user before /models", async () => {
    const prev = globalThis.fetch
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    globalThis.fetch = mock((url, init) => {
      const u = String(url)
      calls.push({ url: u, headers: (init?.headers as Record<string, string>) ?? {} })
      if (u.endsWith("/copilot_internal/user")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user_login: "corp",
              copilot_plan: "enterprise",
              access_type_sku: "enterprise",
              endpoints: { api: "https://api.enterprise.githubcopilot.com" },
              entitlements: { premium_requests: 0 },
            }),
            { status: 200 },
          ),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                model_picker_enabled: true,
                id: "gpt-5.4",
                name: "GPT-5.4",
                version: "gpt-5.4-2026-01-01",
                supported_endpoints: ["/chat/completions"],
                billing: { restricted_to: ["enterprise"] },
                capabilities: {
                  family: "gpt",
                  limits: { max_context_window_tokens: 1, max_output_tokens: 1, max_prompt_tokens: 1 },
                  supports: { streaming: true, tool_calls: true },
                },
              },
              {
                // Filtered out by plan gate (free-plan-only)
                model_picker_enabled: true,
                id: "gpt-5.4-free",
                name: "GPT-5.4 Free",
                version: "gpt-5.4-free-2026-01-01",
                supported_endpoints: ["/chat/completions"],
                billing: { restricted_to: ["free"] },
                capabilities: {
                  family: "gpt",
                  limits: { max_context_window_tokens: 1, max_output_tokens: 1, max_prompt_tokens: 1 },
                  supports: { streaming: true, tool_calls: true },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch
    try {
      const writes: unknown[] = []
      const result = await aliasModels({
        provider: { id: "github-copilot#enterprise", models: {} } as never,
        auth: { type: "oauth", refresh: "ent", access: "ent", expires: 0 } as never,
        auths: [
          {
            key: "github-copilot#corp",
            label: "corp",
            refresh: "ent",
            access: "ent",
            expires: 0,
            enterpriseUrl: "ghe.example.com",
          },
        ],
        state: { version: 1, connections: { "github-copilot#corp": { plan: "enterprise", login: "corp" } } } as never,
        write: async (next) => {
          writes.push(next)
        },
      })
      // Step 1: /copilot_internal/user (static api.github.com base because no proxy).
      expect(calls[0]?.url).toBe("https://api.github.com/copilot_internal/user")
      // Step 2: /models uses the dynamic `endpoints.api` from step 1.
      expect(calls[1]?.url).toBe("https://api.enterprise.githubcopilot.com/models")
      // Plan gate dropped `gpt-5.4-free`.
      expect(Object.keys(result ?? {})).toEqual(["gpt-5.4"])
      expect((writes.at(-1) as any).connections["github-copilot#corp"].discovery).toMatchObject({
        ok: true,
        models: ["gpt-5.4"],
        api: "https://api.enterprise.githubcopilot.com",
      })
    } finally {
      globalThis.fetch = prev
    }
  })

  test("falls back to static base when /copilot_internal/user fails", async () => {
    const prev = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = mock((url) => {
      const u = String(url)
      calls.push(u)
      if (u.endsWith("/copilot_internal/user")) {
        return Promise.resolve(new Response("nope", { status: 500 }))
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    }) as unknown as typeof fetch
    try {
      await aliasModels({
        provider: { id: "github-copilot#corp", models: {} } as never,
        auth: { type: "oauth", refresh: "ent", access: "ent", expires: 0 } as never,
        auths: [
          {
            key: "github-copilot#corp",
            label: "corp",
            refresh: "ent",
            access: "ent",
            expires: 0,
            enterpriseUrl: "ghe.example.com",
          },
        ],
        state: { version: 1, connections: { "github-copilot#corp": { plan: "enterprise", login: "corp" } } } as never,
        write: async () => undefined,
      })
      expect(calls[0]).toBe("https://api.github.com/copilot_internal/user")
      // Fallback to static enterprise base.
      expect(calls[1]).toBe("https://copilot-api.ghe.example.com/models")
    } finally {
      globalThis.fetch = prev
    }
  })
})

describe("discovery barrier", () => {
  test("wait returns immediately when barrier was never started for the key", async () => {
    const b = createDiscoveryBarrier()
    const before = Date.now()
    await b.wait("never-started", 5000)
    expect(Date.now() - before).toBeLessThan(100)
  })

  test("wait blocks until resolve is called", async () => {
    const b = createDiscoveryBarrier()
    b.start("k")
    const gate = b.wait("k", 10_000)
    let settled = false
    const tracked = gate.then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    b.resolve("k")
    await tracked
    expect(settled).toBe(true)
    expect(b.done("k")).toBe(true)
  })

  test("wait returns after the bounded 10s timeout even if resolve is never called", async () => {
    const b = createDiscoveryBarrier()
    b.start("stuck")
    const before = Date.now()
    await b.wait("stuck", 25)
    const elapsed = Date.now() - before
    expect(elapsed).toBeGreaterThanOrEqual(20)
    expect(elapsed).toBeLessThan(500)
    expect(b.done("stuck")).toBe(false)
  })

  test("resolve is idempotent and subsequent waits return immediately", async () => {
    const b = createDiscoveryBarrier()
    b.start("k")
    b.resolve("k")
    b.resolve("k") // no-op
    const before = Date.now()
    await b.wait("k", 5000)
    expect(Date.now() - before).toBeLessThan(100)
    expect(b.done("k")).toBe(true)
  })

  test("DISCOVERY_TIMEOUT_MS mirrors the Rust 10s bound", () => {
    expect(DISCOVERY_TIMEOUT_MS).toBe(10_000)
  })
})
