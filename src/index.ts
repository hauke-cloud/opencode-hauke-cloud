import type { Plugin } from "@opencode-ai/plugin"
import { startCallbackServer } from "./callback-server.js"
import { discoverIssuer } from "./discovery.js"
import { generatePkce, generateState } from "./pkce.js"
import { exchangeCode, refreshAccessToken, resolveExpiryMs } from "./token.js"

export interface OidcPluginOptions {
  /** Provider id in opencode.json this plugin authenticates. Must match exactly. */
  provider: string
  /** OIDC issuer, e.g. "https://id.hauke.cloud/realms/cloud". Discovery is read from "<issuer>/.well-known/openid-configuration". */
  issuer: string
  /** Public client id, registered for PKCE with no client secret. */
  clientId: string
  /** Space-separated scopes. Include "offline_access" to avoid re-login every time the access token expires. */
  scope?: string
  /** Loopback port for the redirect_uri. Must be registered verbatim as a valid redirect URI on the client. */
  callbackPort?: number
  /** Loopback path for the redirect_uri. */
  callbackPath?: string
  /** Seconds of safety margin before expiry at which loader() proactively refreshes. */
  refreshSkewSeconds?: number
  /** Seconds to wait for the browser login to complete before giving up. */
  loginTimeoutSeconds?: number
}

const DEFAULT_SCOPE = "openid profile email offline_access"
const DEFAULT_CALLBACK_PORT = 51121
const DEFAULT_CALLBACK_PATH = "/callback"
const DEFAULT_REFRESH_SKEW_SECONDS = 30
const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300

interface ResolvedOptions {
  provider: string
  issuer: string
  clientId: string
  scope: string
  callbackPort: number
  callbackPath: string
  refreshSkewMs: number
  loginTimeoutMs: number
}

function resolveOptions(options: unknown): ResolvedOptions {
  const o = (options ?? {}) as Partial<OidcPluginOptions>
  const missing = (["provider", "issuer", "clientId"] as const).filter((key) => !o[key])
  if (missing.length > 0) {
    throw new Error(
      `opencode-oidc-plugin: missing required option(s) ${missing.join(", ")}. ` +
        `Configure this plugin with a [name, options] tuple in opencode.json's "plugin" array, ` +
        `e.g. ["opencode-oidc-plugin", { "provider": "my-provider", "issuer": "https://id.example.com/realms/cloud", "clientId": "my-client" }].`,
    )
  }
  return {
    provider: o.provider!,
    issuer: o.issuer!,
    clientId: o.clientId!,
    scope: o.scope ?? DEFAULT_SCOPE,
    callbackPort: o.callbackPort ?? DEFAULT_CALLBACK_PORT,
    callbackPath: o.callbackPath ?? DEFAULT_CALLBACK_PATH,
    refreshSkewMs: (o.refreshSkewSeconds ?? DEFAULT_REFRESH_SKEW_SECONDS) * 1000,
    loginTimeoutMs: (o.loginTimeoutSeconds ?? DEFAULT_LOGIN_TIMEOUT_SECONDS) * 1000,
  }
}

interface OAuthSession {
  access: string
  refresh: string
  expires: number
}

// opencode calls this once per [name, options] entry in the "plugin" config
// array, so `options` is fixed for the lifetime of the returned Hooks object
// -- each entry gets its own closures, its own callback-server port, its own
// in-flight refresh below, etc.
export const createOidcAuthPlugin: Plugin = async (input, options) => {
  const opts = resolveOptions(options)

  // Two requests racing in with an expired access token must not each fire
  // their own refresh_token grant: Keycloak (like most IdPs) rotates the
  // refresh token on use, so the loser's grant would be replayed against an
  // already-consumed token and the whole session would die instead of just
  // refreshing. Funnelling concurrent refreshes through one in-flight
  // promise means only the first caller talks to the token endpoint; the
  // rest await its result.
  let refreshInFlight: Promise<OAuthSession> | null = null

  async function refreshSession(current: OAuthSession): Promise<OAuthSession> {
    if (!refreshInFlight) {
      refreshInFlight = (async () => {
        try {
          const discovery = await discoverIssuer(opts.issuer)
          const refreshed = await refreshAccessToken(discovery.token_endpoint, {
            clientId: opts.clientId,
            refreshToken: current.refresh,
          })
          const next: OAuthSession = {
            access: refreshed.access_token,
            refresh: refreshed.refresh_token ?? current.refresh,
            expires: resolveExpiryMs(refreshed),
          }
          await input.client.auth.set({
            path: { id: opts.provider },
            body: { type: "oauth", ...next },
          })
          return next
        } finally {
          refreshInFlight = null
        }
      })()
    }
    return refreshInFlight
  }

  return {
    auth: {
      provider: opts.provider,
      methods: [
        {
          type: "oauth",
          label: `Sign in with ${safeHost(opts.issuer)}`,
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

            return {
              url: authorizeUrl.toString(),
              instructions: `Sign in with your ${safeHost(opts.issuer)} account. If your browser didn't open, visit the URL above.`,
              method: "auto",
              async callback() {
                try {
                  const received = await listener.result
                  if (received.error || !received.code) {
                    const reason = received.errorDescription ?? received.error ?? "no code received"
                    throw new Error(`opencode-oidc-plugin: login did not complete (${reason}).`)
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
                      `opencode-oidc-plugin: token response for client "${opts.clientId}" had no refresh_token. ` +
                        `Enable the "offline_access" scope on this client (and include it in the plugin's "scope" option, the default already does).`,
                    )
                  }

                  return {
                    type: "success",
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: resolveExpiryMs(tokens),
                  }
                } finally {
                  listener.close()
                }
              },
            }
          },
        },
      ],
      async loader(getAuth) {
        return {
          apiKey: "oidc-managed",
          async fetch(url: string | URL | Request, init?: RequestInit) {
            const auth = await getAuth()
            if (auth.type !== "oauth") {
              throw new Error(
                `opencode-oidc-plugin: provider "${opts.provider}" has no OIDC session yet -- run "opencode auth login" and pick it.`,
              )
            }

            let session: OAuthSession = auth
            if (session.expires - opts.refreshSkewMs < Date.now()) {
              session = await refreshSession(session)
            }

            const headers = new Headers(init?.headers)
            headers.delete("authorization")
            headers.set("authorization", `Bearer ${session.access}`)
            return fetch(url, { ...init, headers })
          },
        }
      },
    },
  }
}

function safeHost(issuer: string): string {
  try {
    return new URL(issuer).host
  } catch {
    return issuer
  }
}

export default createOidcAuthPlugin
