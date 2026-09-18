import { test } from "node:test"
import assert from "node:assert/strict"
import { createOidcAuthPlugin } from "../index.js"

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return run().finally(() => {
    globalThis.fetch = original
  })
}

test("loader dedupes concurrent refreshes instead of racing on a rotating refresh token", async () => {
  let refreshCalls = 0
  let authSet: { path: { id: string }; body: { type: string; access: string; refresh: string; expires: number } } | null = null

  const fakeInput = {
    client: {
      auth: {
        set: async (args: typeof authSet) => {
          authSet = args
        },
      },
    },
  }

  await withMockFetch(
    (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer: "https://id.example.com/realms/cloud",
            authorization_endpoint: "https://id.example.com/realms/cloud/protocol/openid-connect/auth",
            token_endpoint: "https://id.example.com/realms/cloud/protocol/openid-connect/token",
          }),
          { status: 200 },
        )
      }
      if (url === "https://id.example.com/realms/cloud/protocol/openid-connect/token") {
        refreshCalls++
        return new Response(
          JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 300, token_type: "Bearer" }),
          { status: 200 },
        )
      }
      if (url === "https://backend.example.com/v1/models") {
        return new Response("ok", { status: 200 })
      }
      throw new Error(`unexpected fetch to ${url}`)
    }) as typeof fetch,
    async () => {
      const hooks = await createOidcAuthPlugin(fakeInput as never, {
        provider: "llama-swap",
        issuer: "https://id.example.com/realms/cloud",
        clientId: "opencode",
      })

      const expiredAuth = {
        type: "oauth" as const,
        access: "stale-access",
        refresh: "stale-refresh",
        expires: Date.now() - 1000,
      }
      const wired = await hooks.auth!.loader!(async () => expiredAuth as never, {} as never)

      const [a, b] = await Promise.all([
        wired.fetch("https://backend.example.com/v1/models"),
        wired.fetch("https://backend.example.com/v1/models"),
      ])

      assert.equal(a.status, 200)
      assert.equal(b.status, 200)
      assert.equal(refreshCalls, 1, "both concurrent requests should share a single refresh call")
      assert.equal(authSet?.path.id, "llama-swap")
      assert.equal(authSet?.body.access, "fresh-access")
      assert.equal(authSet?.body.refresh, "fresh-refresh")
      assert.ok(authSet && authSet.body.expires > Date.now())
    },
  )
})

test("loader sends the fresh access token as a Bearer header, stripping any pre-existing Authorization", async () => {
  let seenAuthHeader: string | null = null

  await withMockFetch(
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === "https://backend.example.com/v1/models") {
        seenAuthHeader = new Headers(init?.headers).get("authorization")
        return new Response("ok", { status: 200 })
      }
      throw new Error(`unexpected fetch to ${url}`)
    }) as typeof fetch,
    async () => {
      const hooks = await createOidcAuthPlugin({} as never, {
        provider: "llama-swap",
        issuer: "https://id.example.com/realms/cloud",
        clientId: "opencode",
      })

      const validAuth = { type: "oauth" as const, access: "still-valid", refresh: "r", expires: Date.now() + 60_000 }
      const wired = await hooks.auth!.loader!(async () => validAuth as never, {} as never)

      await wired.fetch("https://backend.example.com/v1/models", { headers: { authorization: "Bearer forged" } })
      assert.equal(seenAuthHeader, "Bearer still-valid")
    },
  )
})

test("loader throws a clear error when the provider has no OIDC session", async () => {
  const hooks = await createOidcAuthPlugin({} as never, {
    provider: "llama-swap",
    issuer: "https://id.example.com/realms/cloud",
    clientId: "opencode",
  })
  const wired = await hooks.auth!.loader!(async () => ({ type: "api", key: "irrelevant" }) as never, {} as never)
  await assert.rejects(() => wired.fetch("https://backend.example.com/v1/models"), /has no OIDC session yet/)
})
