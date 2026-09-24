import type { Credential, Plugin } from "@opencode/plugin"
import { startCallbackServer } from "./callback-server.js"
import { discoverIssuer } from "./discovery.js"
import { decodeJwtClaims } from "./jwt.js"
import { MEMORY_DEFAULTS, setupMemory, type MemoryOptions } from "./memory.js"
import { fetchModels, matchOverrides, toModelInfo, type ModelOverride, type RemoteModel } from "./models.js"
import { generatePkce, generateState } from "./pkce.js"
import { exchangeCode, refreshAccessToken, resolveExpiryMs } from "./token.js"

export interface HaukeCloudOptions {
  /** Provider (and integration) id the plugin defines and authenticates. */
  provider?: string
  /** Display name of the provider. */
  name?: string
  /** OpenAI-compatible endpoint the provider's models are served from. */
  baseURL?: string
  /** OIDC issuer. Discovery is read from "<issuer>/.well-known/openid-configuration". */
  issuer?: string
  /** Public client id, registered for PKCE with no client secret. */
  clientId?: string
  /** Space-separated scopes. Include "offline_access" to avoid re-login every time the access token expires. */
  scope?: string
  /** Loopback port for the redirect_uri. Must be registered verbatim as a valid redirect URI on the client. */
  callbackPort?: number
  /** Loopback path for the redirect_uri. */
  callbackPath?: string
  /** Seconds to wait for the browser login to complete before giving up. */
  loginTimeoutSeconds?: number
  /**
   * After sign-in, list the provider's models from "<baseURL>/models" with the
   * signed-in account's token and add any the config doesn't already define.
   */
  discoverModels?: boolean
  /**
   * Capabilities and limits of discovered models, which the listing doesn't
   * report, keyed by model id or a pattern with "*" wildcards, e.g.
   * { "*-vl-*": { capabilities: { input: ["text", "image"] } } }.
   */
  models?: Record<string, ModelOverride>
  /** Long-term memory through mem0, authenticated with the same login. false turns it off. */
  memory?: false | Partial<MemoryOptions>
}

export const PLUGIN_ID = "opencode-hauke-cloud"
// Branded in opencode's schema; the brand is compile-time only, so a cast keeps
// this package free of a runtime dependency on @opencode/plugin.
export const METHOD_ID = "oidc" as Credential.OAuth["methodID"]

// Everything defaults to hauke.cloud, so the plugin line alone is a working
// setup. Each value can still be overridden in the plugin's options.
export const DEFAULTS = {
  provider: "hauke-cloud",
  name: "hauke.cloud",
  baseURL: "https://llama.llm.hauke.cloud/v1",
  issuer: "https://id.hauke.cloud/realms/cloud",
  clientId: "prod-llama-swap-opencode",
  scope: "openid profile email offline_access",
  callbackPort: 51121,
  callbackPath: "/callback",
  loginTimeoutSeconds: 300,
  discoverModels: true,
} as const

// The SDK package opencode loads for the provider; it sends the access token as
// "Authorization: Bearer <token>".
const PROVIDER_PACKAGE = "@ai-sdk/openai-compatible"

export interface ResolvedOptions {
  provider: string
  name: string
  baseURL: string
  issuer: string
  clientId: string
  scope: string
  callbackPort: number
  callbackPath: string
  loginTimeoutMs: number
  discoverModels: boolean
  models: Record<string, ModelOverride>
  memory: MemoryOptions | false
}

export function resolveOptions(options: unknown): ResolvedOptions {
  const o = (options ?? {}) as HaukeCloudOptions & { providers?: unknown }
  if (o.providers !== undefined) {
    throw new Error(
      `${PLUGIN_ID}: "providers" is not supported -- this plugin sets up a single provider; ` +
        `put its options directly in the plugin's options.`,
    )
  }
  const provider = o.provider ?? DEFAULTS.provider
  return {
    provider,
    name: o.name ?? DEFAULTS.name,
    baseURL: o.baseURL ?? DEFAULTS.baseURL,
    issuer: o.issuer ?? DEFAULTS.issuer,
    clientId: o.clientId ?? DEFAULTS.clientId,
    scope: o.scope ?? DEFAULTS.scope,
    callbackPort: o.callbackPort ?? DEFAULTS.callbackPort,
    callbackPath: o.callbackPath ?? DEFAULTS.callbackPath,
    loginTimeoutMs: (o.loginTimeoutSeconds ?? DEFAULTS.loginTimeoutSeconds) * 1000,
    discoverModels: o.discoverModels ?? DEFAULTS.discoverModels,
    models: o.models ?? {},
    memory:
      o.memory === false
        ? false
        : { ...MEMORY_DEFAULTS, localProviders: ["ollama", provider], ...(o.memory ?? {}) },
  }
}

// The pieces of an OAuth integration method for one provider. opencode owns
// everything around them: it persists the credential, calls refresh() when the
// stored access token is within a few minutes of expiry, and hands the fresh
// access token to the provider's SDK as its apiKey -- which @ai-sdk/openai-compatible
// sends as "Authorization: Bearer <token>".
export function createOidcMethod(opts: ResolvedOptions) {
  // Two model resolutions racing in with an expiring token must not each fire
  // their own refresh_token grant: Keycloak (like most IdPs) rotates the
  // refresh token on use, so the loser's grant would be replayed against an
  // already-consumed token and the whole session would die instead of just
  // refreshing. Remembering which refresh token the last grant consumed means
  // every caller holding that token -- whether it arrives while the grant is
  // in flight or read the credential just before opencode stored the rotated
  // one -- shares that grant's result instead of replaying it.
  let lastRefresh: { from: string; result: Promise<Credential.OAuth> } | null = null

  async function refreshCredential(current: Credential.OAuth): Promise<Credential.OAuth> {
    const discovery = await discoverIssuer(opts.issuer)
    const refreshed = await refreshAccessToken(discovery.token_endpoint, {
      clientId: opts.clientId,
      refreshToken: current.refresh,
    })
    return {
      type: "oauth",
      methodID: current.methodID,
      access: refreshed.access_token,
      refresh: refreshed.refresh_token ?? current.refresh,
      expires: resolveExpiryMs(refreshed),
    }
  }

  return {
    integrationID: opts.provider,
    method: {
      id: METHOD_ID,
      type: "oauth" as const,
      label: `Sign in with ${safeHost(opts.issuer)}`,
    },

    async authorize() {
      const discovery = await discoverIssuer(opts.issuer)
      const pkce = generatePkce()
      const state = generateState()
      const redirectUri = `http://127.0.0.1:${opts.callbackPort}${opts.callbackPath}`

      const listener = await startCallbackServer({
        port: opts.callbackPort,
        path: opts.callbackPath,
        state,
        timeoutMs: opts.loginTimeoutMs,
      })

      const authorizeUrl = new URL(discovery.authorization_endpoint)
      authorizeUrl.searchParams.set("client_id", opts.clientId)
      authorizeUrl.searchParams.set("response_type", "code")
      authorizeUrl.searchParams.set("redirect_uri", redirectUri)
      authorizeUrl.searchParams.set("scope", opts.scope)
      authorizeUrl.searchParams.set("state", state)
      authorizeUrl.searchParams.set("code_challenge", pkce.challenge)
      authorizeUrl.searchParams.set("code_challenge_method", "S256")

      const callback = (async (): Promise<Credential.OAuth> => {
        try {
          const received = await listener.result
          if (received.error || !received.code) {
            const reason = received.errorDescription ?? received.error ?? "no code received"
            throw new Error(`${PLUGIN_ID}: login did not complete (${reason}).`)
          }

          const tokens = await exchangeCode(discovery.token_endpoint, {
            clientId: opts.clientId,
            code: received.code,
            redirectUri,
            codeVerifier: pkce.verifier,
          })

          if (!tokens.refresh_token) {
            // Without a refresh token the session dies the moment the
            // short-lived access token expires, which for a CLI tool
            // that's used sporadically is every session. Fail loudly
            // here rather than leave the user to discover it as a
            // silent 401 five minutes into their next opencode run.
            throw new Error(
              `${PLUGIN_ID}: token response for client "${opts.clientId}" had no refresh_token. ` +
                `Enable the "offline_access" scope on this client (and include it in the plugin's "scope" option, the default already does).`,
            )
          }

          return {
            type: "oauth",
            methodID: METHOD_ID,
            refresh: tokens.refresh_token,
            access: tokens.access_token,
            expires: resolveExpiryMs(tokens),
          }
        } finally {
          listener.close()
        }
      })()
      // opencode awaits this as soon as authorize() returns; the extra handler
      // only keeps a login that's abandoned before then from surfacing as an
      // unhandled rejection when the listener times out.
      callback.catch(() => {})

      return {
        url: authorizeUrl.toString(),
        instructions: `Sign in with your ${safeHost(opts.issuer)} account. If your browser didn't open, visit the URL above.`,
        // Expire opencode's pending attempt together with our loopback listener.
        expiresAt: Date.now() + opts.loginTimeoutMs,
        mode: "auto" as const,
        callback,
      }
    },

    refresh(current: Credential.OAuth): Promise<Credential.OAuth> {
      if (lastRefresh?.from !== current.refresh) {
        const entry = { from: current.refresh, result: refreshCredential(current) }
        // A failed grant didn't consume anything worth sharing -- let the next caller retry.
        entry.result.catch(() => {
          if (lastRefresh === entry) lastRefresh = null
        })
        lastRefresh = entry
      }
      return lastRefresh.result
    },

    // Shown next to the saved connection in `opencode auth list`.
    label(credential: Credential.OAuth): string | undefined {
      const claims = decodeJwtClaims(credential.access)
      const name = claims?.preferred_username ?? claims?.email
      return typeof name === "string" ? `${name} @ ${safeHost(opts.issuer)}` : undefined
    },
  }
}

type Context = Parameters<Plugin.Plugin["setup"]>[0]
type Connection = NonNullable<Awaited<ReturnType<Context["integration"]["connection"]["active"]>>>

// Keeps a provider's model list in step with what the signed-in account can
// see. Discovery runs at startup and whenever the provider's active account
// changes (sign-in, sign-out, switching accounts) -- not on token refreshes,
// which don't change who's asking.
export async function discoverProviderModels(
  ctx: Context,
  providerID: string,
  signal: AbortSignal,
  overrides: Record<string, ModelOverride> = {},
) {
  let loaded: { models: RemoteModel[]; connection: Connection } | undefined

  // Discovered models are bound to the connection that listed them, so opencode
  // never shows one account's models while another is signed in. Models the
  // config already defines keep their definitions; opencode re-applies config
  // overrides on top of discovered ones afterwards either way.
  await ctx.provider.transform((editor) => {
    if (!loaded) return
    // opencode runs plugin transforms before its own config transform, so a
    // provider that only opencode.json defines has no record yet at this point.
    // update() creates it; the config transform fills in package and settings
    // on top of it afterwards.
    if (!editor.get(providerID)) editor.update(providerID, () => {})
    const record = editor.get(providerID)
    if (!record) return
    const models = new Map(record.models)
    for (const remote of loaded.models) {
      const existing = models.get(remote.id)
      if (!existing) models.set(remote.id, toModelInfo(providerID, remote, matchOverrides(overrides, remote.id)))
      // A config entry that only adjusts, say, limits still gets the listed display name.
      else if (remote.name && existing.name === existing.id) models.set(remote.id, { ...existing, name: remote.name })
    }
    editor.add({ info: record.provider, models: [...models.values()], sourceConnection: loaded.connection })
  })

  async function load() {
    const connection = await ctx.integration.connection.active(providerID)
    if (!connection) {
      loaded = undefined
      return
    }
    const credential = await ctx.integration.connection.resolve(connection)
    if (credential?.type !== "oauth") {
      loaded = undefined
      return
    }
    const provider = await ctx.provider.get({ providerID })
    const baseURL = provider.data.settings?.baseURL
    if (typeof baseURL !== "string") {
      throw new Error(`${PLUGIN_ID}: provider "${providerID}" has no baseURL to discover models from.`)
    }
    loaded = { models: await fetchModels(baseURL, credential.access), connection }
  }

  // Refreshes run one at a time so a slow listing can't land after a newer one.
  let queue = Promise.resolve()
  const refresh = () => {
    queue = queue.then(async () => {
      const before = loaded
      try {
        await load()
      } catch (error) {
        // Keep the last good list through a transient outage rather than
        // making the provider's models flicker away.
        console.warn(`${PLUGIN_ID}: model discovery for "${providerID}" failed:`, error)
        return
      }
      if (loaded !== before && !signal.aborted) await ctx.provider.reload()
    })
    return queue
  }

  void refresh()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal })) {
        if (event.type === "credential.switched" && event.data.integrationID === providerID) void refresh()
      }
    } catch (error) {
      if (!signal.aborted) console.warn(`${PLUGIN_ID}: lost the event stream for "${providerID}":`, error)
    }
  })()
}

const plugin: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const opts = resolveOptions(ctx.options)
    const method = createOidcMethod(opts)
    await ctx.integration.transform((editor) => {
      editor.update(opts.provider, (integration) => {
        integration.name = opts.name
      })
      editor.method.update(method)
    })

    // Defines the provider so opencode.json needs no "provider" block. Plugin
    // transforms run before opencode's config transform, so a "provider" entry
    // with the same id still applies on top of this. Activation stays "auto":
    // the provider shows up once its integration has a signed-in connection.
    await ctx.provider.transform((editor) => {
      editor.update(opts.provider, (provider) => {
        provider.name = opts.name
        provider.package = PROVIDER_PACKAGE
        provider.settings = { ...provider.settings, baseURL: opts.baseURL }
      })
    })

    const controller = new AbortController()
    if (opts.discoverModels) await discoverProviderModels(ctx, opts.provider, controller.signal, opts.models)
    const disposeMemory = opts.memory ? await setupMemory(ctx, opts.provider, opts.memory, PLUGIN_ID) : undefined
    return async () => {
      controller.abort()
      await disposeMemory?.()
    }
  },
}

function safeHost(issuer: string): string {
  try {
    return new URL(issuer).host
  } catch {
    return issuer
  }
}

export default plugin
