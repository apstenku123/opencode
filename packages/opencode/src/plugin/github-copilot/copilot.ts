import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Installation } from "@/installation"
import { Auth } from "@/auth"
import { iife } from "@/util/iife"
import { setTimeout as sleep } from "node:timers/promises"
import { getCopilotSessionId, getCopilotMachineId } from "../copilot-ids"
import { CopilotConnectionManager, type ResolvedConnection } from "../copilot-connections"

const CLIENT_ID = "Ov23ctDVkRmgkPke0Mmm"
// Add a small safety buffer when polling to avoid hitting the server
// slightly too early due to clock skew / timer drift.
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000 // 3 seconds
function normalizeDomain(url: string) {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "")
}

function getUrls(domain: string) {
  return {
    DEVICE_CODE_URL: `https://${domain}/login/device/code`,
    ACCESS_TOKEN_URL: `https://${domain}/login/oauth/access_token`,
  }
}

export async function CopilotAuthPlugin(input: PluginInput): Promise<Hooks> {
  const sdk = input.client

  // Multi-account connection manager with round-robin and failover.
  const connectionManager = new CopilotConnectionManager()

  // Per-account per-model premium tracking matching codex_git's account_pool.rs:
  // Only the FIRST request to each model per account in a session gets
  // x-initiator: "user" (premium). All subsequent requests get "agent" (free).
  const premiumSentModels = new Map<string, Set<string>>() // accountKey -> Set<modelId>

  function checkAndMarkPremium(accountKey: string, modelId: string): boolean {
    let models = premiumSentModels.get(accountKey)
    if (!models) {
      models = new Set()
      premiumSentModels.set(accountKey, models)
    }
    if (models.has(modelId)) return false
    models.add(modelId)
    return true
  }

  function rollbackPremium(accountKey: string, modelId: string): void {
    premiumSentModels.get(accountKey)?.delete(modelId)
  }

  /**
   * Load all github-copilot accounts from auth.json and resolve via connection manager.
   * Returns connections sorted by preference/availability with round-robin.
   */
  async function loadCopilotAccounts(): Promise<ResolvedConnection[]> {
    try {
      const allAuth = await Auth.all()
      const copilotEntries: Record<string, { refresh: string; enterpriseUrl?: string }> = {}
      for (const [key, info] of Object.entries(allAuth)) {
        if (!key.startsWith("github-copilot") || info.type !== "oauth") continue
        copilotEntries[key] = {
          refresh: info.refresh,
          enterpriseUrl: "enterpriseUrl" in info ? (info.enterpriseUrl as string) : undefined,
        }
      }
      return connectionManager.getConnections(copilotEntries)
    } catch {
      return []
    }
  }

  return {
    auth: {
      provider: "github-copilot",
      async loader(getAuth, provider) {
        const info = await getAuth()
        if (!info || info.type !== "oauth") return {}

        const enterpriseUrl = info.enterpriseUrl
        const baseURL = enterpriseUrl ? `https://copilot-api.${normalizeDomain(enterpriseUrl)}` : undefined

        if (provider && provider.models) {
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }

            // TODO: re-enable once messages api has higher rate limits
            // TODO: move some of this hacky-ness to models.dev presets once we have better grasp of things here...
            // const base = baseURL ?? model.api.url
            // const claude = model.id.includes("claude")
            // const url = iife(() => {
            //   if (!claude) return base
            //   if (base.endsWith("/v1")) return base
            //   if (base.endsWith("/")) return `${base}v1`
            //   return `${base}/v1`
            // })

            // model.api.url = url
            // model.api.npm = claude ? "@ai-sdk/anthropic" : "@ai-sdk/github-copilot"
            model.api.npm = "@ai-sdk/github-copilot"
          }
        }

        return {
          baseURL,
          apiKey: "",
          async fetch(request: RequestInfo | URL, init?: RequestInit) {
            const info = await getAuth()
            if (info.type !== "oauth") return fetch(request, init)

            const url = request instanceof URL ? request.href : request.toString()
            const { isVision, modelId } = iife(() => {
              try {
                const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body
                const parsedModelId = body?.model ?? ""

                // Completions API
                if (body?.messages && url.includes("completions")) {
                  return {
                    isVision: body.messages.some(
                      (msg: any) =>
                        Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image_url"),
                    ),
                    modelId: parsedModelId,
                  }
                }

                // Responses API
                if (body?.input) {
                  return {
                    isVision: body.input.some(
                      (item: any) =>
                        Array.isArray(item?.content) && item.content.some((part: any) => part.type === "input_image"),
                    ),
                    modelId: parsedModelId,
                  }
                }

                // Messages API
                if (body?.messages) {
                  return {
                    isVision: body.messages.some(
                      (item: any) =>
                        Array.isArray(item?.content) &&
                        item.content.some(
                          (part: any) =>
                            part?.type === "image" ||
                            // images can be nested inside tool_result content
                            (part?.type === "tool_result" &&
                              Array.isArray(part?.content) &&
                              part.content.some((nested: any) => nested?.type === "image")),
                        ),
                    ),
                    modelId: parsedModelId,
                  }
                }
              } catch {}
              return { isVision: false, modelId: "" }
            })

            const stainlessOS = process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux"
            const stainlessArch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch

            // Round-robin account selection: load all copilot accounts and pick next available.
            // Falls back to primary account from getAuth() if no multi-account setup.
            const accounts = await loadCopilotAccounts()
            const activeAccount = await connectionManager.getNextConnection(
              Object.fromEntries(accounts.map((a) => [a.key, { refresh: a.token, enterpriseUrl: a.enterpriseUrl }])),
            )
            const accountKey = activeAccount?.key ?? "github-copilot"
            const token = activeAccount?.token ?? info.refresh

            // Per-account per-model premium tracking: only the first request to each
            // model per account gets x-initiator: "user" (premium).
            const isFirstForModel = modelId ? checkAndMarkPremium(accountKey, modelId) : false

            const headers: Record<string, string> = {
              "x-initiator": isFirstForModel ? "user" : "agent",
              "X-Interaction-Type": isFirstForModel ? "conversation-user" : "conversation-agent",
              ...(init?.headers as Record<string, string>),
              "User-Agent": `opencode/${Installation.VERSION} (${process.platform} ${process.version}) copilot-compat/1.0.14`,
              Authorization: `Bearer ${token}`,
              "Openai-Intent": "conversation-agent",
              "Copilot-Integration-Id": "copilot-developer-cli",
              "X-GitHub-Api-Version": "2026-01-09",
              "X-Interaction-Id": crypto.randomUUID(),
              "X-Agent-Task-Id": crypto.randomUUID(),
              "X-Stainless-Retry-Count": "0",
              "X-Stainless-Lang": "js",
              "X-Stainless-Package-Version": "5.20.1",
              "X-Stainless-OS": stainlessOS,
              "X-Stainless-Arch": stainlessArch,
              "X-Stainless-Runtime": "node",
              "X-Stainless-Runtime-Version": process.version,
              "X-Client-Session-Id": getCopilotSessionId(),
              "X-Client-Machine-Id": getCopilotMachineId(),
            }

            if (isVision) {
              headers["Copilot-Vision-Request"] = "true"
            }

            delete headers["x-api-key"]
            delete headers["authorization"]

            const response = await fetch(request, {
              ...init,
              headers,
            })

            if (response.status === 429) {
              // Mark this account as exhausted for 11 minutes (matching codex_git's
              // first headerless 429 fallback delay). Connection manager will skip
              // it and round-robin to the next available account on the next request.
              connectionManager.setExhaustion(accountKey, Date.now() + 11 * 60 * 1000)

              // Rollback premium so the retry on another account gets "user".
              if (isFirstForModel && modelId) {
                rollbackPremium(accountKey, modelId)
              }
            } else if (response.status === 401) {
              // Bad token — rollback premium so retry re-sends "user".
              if (isFirstForModel && modelId) {
                rollbackPremium(accountKey, modelId)
              }
            } else if (response.ok) {
              // Success — clear any exhaustion on this account.
              connectionManager.clearExhaustion(accountKey)
            }

            return response
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Login with GitHub Copilot",
          prompts: [
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" },
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"

            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
            }

            const urls = getUrls(domain)

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `opencode/${Installation.VERSION}`,
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: "read:user,read:org,repo,gist",
              }),
            })

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization")
            }

            const deviceData = (await deviceResponse.json()) as {
              verification_uri: string
              user_code: string
              device_code: string
              interval: number
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  })

                  if (!response.ok) return { type: "failed" as const }

                  const data = (await response.json()) as {
                    access_token?: string
                    error?: string
                    interval?: number
                  }

                  if (data.access_token) {
                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      provider?: string
                      enterpriseUrl?: string
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                    }

                    if (deploymentType === "enterprise") {
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  if (data.error === "authorization_pending") {
                    await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    // Based on the RFC spec, we must add 5 seconds to our current polling interval.
                    // (See https://www.rfc-editor.org/rfc/rfc8628#section-3.5)
                    let newInterval = (deviceData.interval + 5) * 1000

                    // GitHub OAuth API may return the new interval in seconds in the response.
                    // We should try to use that if provided with safety margin.
                    const serverInterval = data.interval
                    if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                      newInterval = serverInterval * 1000
                    }

                    await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error) return { type: "failed" as const }

                  await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "Add additional GitHub Copilot account",
          prompts: [
            {
              type: "text",
              key: "accountLabel",
              message: "Enter a label for this account (e.g., work, personal, enterprise)",
              placeholder: "work",
              validate: (value) => {
                if (!value || !value.trim()) return "Label is required"
                if (!/^[a-zA-Z0-9_-]+$/.test(value.trim())) return "Label must be alphanumeric (dashes and underscores allowed)"
                return undefined
              },
            },
            {
              type: "select",
              key: "deploymentType",
              message: "Select GitHub deployment type",
              options: [
                {
                  label: "GitHub.com",
                  value: "github.com",
                  hint: "Public",
                },
                {
                  label: "GitHub Enterprise",
                  value: "enterprise",
                  hint: "Data residency or self-hosted",
                },
              ],
            },
            {
              type: "text",
              key: "enterpriseUrl",
              message: "Enter your GitHub Enterprise URL or domain",
              placeholder: "company.ghe.com or https://company.ghe.com",
              when: { key: "deploymentType", op: "eq", value: "enterprise" },
              validate: (value) => {
                if (!value) return "URL or domain is required"
                try {
                  const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`)
                  if (!url.hostname) return "Please enter a valid URL or domain"
                  return undefined
                } catch {
                  return "Please enter a valid URL (e.g., company.ghe.com or https://company.ghe.com)"
                }
              },
            },
          ],
          async authorize(inputs = {}) {
            const label = (inputs.accountLabel as string || "").trim()
            const deploymentType = inputs.deploymentType || "github.com"

            let domain = "github.com"
            if (deploymentType === "enterprise") {
              const enterpriseUrl = inputs.enterpriseUrl
              domain = normalizeDomain(enterpriseUrl!)
            }

            const urls = getUrls(domain)

            const deviceResponse = await fetch(urls.DEVICE_CODE_URL, {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "User-Agent": `opencode/${Installation.VERSION}`,
              },
              body: JSON.stringify({
                client_id: CLIENT_ID,
                scope: "read:user,read:org,repo,gist",
              }),
            })

            if (!deviceResponse.ok) {
              throw new Error("Failed to initiate device authorization")
            }

            const deviceData = (await deviceResponse.json()) as {
              verification_uri: string
              user_code: string
              device_code: string
              interval: number
            }

            return {
              url: deviceData.verification_uri,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                while (true) {
                  const response = await fetch(urls.ACCESS_TOKEN_URL, {
                    method: "POST",
                    headers: {
                      Accept: "application/json",
                      "Content-Type": "application/json",
                      "User-Agent": `opencode/${Installation.VERSION}`,
                    },
                    body: JSON.stringify({
                      client_id: CLIENT_ID,
                      device_code: deviceData.device_code,
                      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                    }),
                  })

                  if (!response.ok) return { type: "failed" as const }

                  const data = (await response.json()) as {
                    access_token?: string
                    error?: string
                    interval?: number
                  }

                  if (data.access_token) {
                    const result: {
                      type: "success"
                      refresh: string
                      access: string
                      expires: number
                      provider?: string
                      enterpriseUrl?: string
                    } = {
                      type: "success",
                      refresh: data.access_token,
                      access: data.access_token,
                      expires: 0,
                      provider: `github-copilot#${label}`,
                    }

                    if (deploymentType === "enterprise") {
                      result.enterpriseUrl = domain
                    }

                    return result
                  }

                  if (data.error === "authorization_pending") {
                    await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error === "slow_down") {
                    let newInterval = (deviceData.interval + 5) * 1000
                    const serverInterval = data.interval
                    if (serverInterval && typeof serverInterval === "number" && serverInterval > 0) {
                      newInterval = serverInterval * 1000
                    }
                    await sleep(newInterval + OAUTH_POLLING_SAFETY_MARGIN_MS)
                    continue
                  }

                  if (data.error) return { type: "failed" as const }

                  await sleep(deviceData.interval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS)
                  continue
                }
              },
            }
          },
        },
      ],
    },
    "chat.headers": async (incoming, output) => {
      if (!incoming.model.providerID.includes("github-copilot")) return

      if (incoming.model.api.npm === "@ai-sdk/anthropic") {
        output.headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
      }

      const parts = await sdk.session
        .message({
          path: {
            id: incoming.message.sessionID,
            messageID: incoming.message.id,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)

      if (parts?.data.parts?.some((part) => part.type === "compaction")) {
        output.headers["x-initiator"] = "agent"
        output.headers["X-Interaction-Type"] = "conversation-background"
        return
      }

      const session = await sdk.session
        .get({
          path: {
            id: incoming.sessionID,
          },
          query: {
            directory: input.directory,
          },
          throwOnError: true,
        })
        .catch(() => undefined)
      if (!session || !session.data.parentID) return
      // mark subagent sessions as agent initiated matching standard that other copilot tools have
      output.headers["x-initiator"] = "agent"
      output.headers["X-Interaction-Type"] = "conversation-subagent"
    },
  }
}
