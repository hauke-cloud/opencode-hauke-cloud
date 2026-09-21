import { test } from "node:test"
import assert from "node:assert/strict"
import plugin, { METHOD_ID, PLUGIN_ID, createOidcMethod, resolveOptions } from "../index.js"

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.signature`
}

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return run().finally(() => {
    globalThis.fetch = original
  })
}

const baseOptions = {
  provider: "llama-swap",
  issuer: "https://id.example.com/realms/cloud",
  clientId: "opencode",
}

const discoveryResponse = () =>
  new Response(
    JSON.stringify({
      issuer: "https://id.example.com/realms/cloud",
      authorization_endpoint: "https://id.example.com/realms/cloud/protocol/openid-connect/auth",
      token_endpoint: "https://id.example.com/realms/cloud/protocol/openid-connect/token",
    }),
    { status: 200 },
  )

function stale(refresh: string) {
  return { type: "oauth" as const, methodID: METHOD_ID, access: "stale-access", refresh, expires: Date.now() - 1000 }
}

test("setup registers one OAuth method per configured provider", async () => {
  const registered: { integrationID: string; method: { id: string; type: string } }[] = []
  await plugin.setup({
    options: {
      providers: [baseOptions, { ...baseOptions, provider: "other", clientId: "other-client" }],
    },
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ method: { update: (input: (typeof registered)[number]) => registered.push(input) } })
        return { dispose: async () => {} }
      },
    },
  } as never)

  assert.equal(plugin.id, PLUGIN_ID)
  assert.deepEqual(
    registered.map((r) => [r.integrationID, r.method.id, r.method.type]),
    [
      ["llama-swap", METHOD_ID, "oauth"],
      ["other", METHOD_ID, "oauth"],
    ],
  )
})

test("resolveOptions accepts a flat options object and rejects missing or duplicate providers", () => {
  assert.equal(resolveOptions(baseOptions)[0].scope, "openid profile email offline_access")
  assert.throws(() => resolveOptions({ issuer: "x" }), /missing required option\(s\) provider, clientId/)
  assert.throws(() => resolveOptions({ providers: [baseOptions, { issuer: "x" }] }), /in providers\[1\]/)
  assert.throws(() => resolveOptions({ providers: [baseOptions, baseOptions] }), /configured more than once/)
  assert.throws(() => resolveOptions({ providers: [] }), /"providers" is empty/)
})

test("refresh dedupes concurrent and replayed grants for the same rotating refresh token", async () => {
  let refreshCalls = 0

  await withMockFetch(
    (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse()
      if (url === "https://id.example.com/realms/cloud/protocol/openid-connect/token") {
        refreshCalls++
        const sent = new URLSearchParams(String(init?.body)).get("refresh_token")
        return new Response(
          JSON.stringify({ access_token: `access-for-${sent}`, refresh_token: `after-${sent}`, expires_in: 300, token_type: "Bearer" }),
          { status: 200 },
        )
      }
      throw new Error(`unexpected fetch to ${url}`)
    }) as typeof fetch,
    async () => {
      const method = createOidcMethod(resolveOptions(baseOptions)[0])

      const [a, b] = await Promise.all([method.refresh(stale("r1")), method.refresh(stale("r1"))])
      assert.equal(refreshCalls, 1, "both concurrent callers should share a single refresh call")
      assert.deepEqual(a, b)
      assert.equal(a.type, "oauth")
      assert.equal(a.methodID, METHOD_ID)
      assert.equal(a.access, "access-for-r1")
      assert.equal(a.refresh, "after-r1")
      assert.ok(Number.isInteger(a.expires) && a.expires > Date.now())

      // A caller that read the credential before opencode stored the rotated
      // token must not replay the consumed one.
      const late = await method.refresh(stale("r1"))
      assert.equal(refreshCalls, 1)
      assert.equal(late.refresh, "after-r1")

      const next = await method.refresh(stale("after-r1"))
      assert.equal(refreshCalls, 2)
      assert.equal(next.refresh, "after-after-r1")
    },
  )
})

test("refresh keeps the old refresh token when the IdP doesn't rotate it, and retries after a failure", async () => {
  let fail = true

  await withMockFetch(
    (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith("/.well-known/openid-configuration")) return discoveryResponse()
      if (fail) return new Response("invalid_grant", { status: 400, statusText: "Bad Request" })
      return new Response(JSON.stringify({ access_token: "fresh", expires_in: 300, token_type: "Bearer" }), { status: 200 })
    }) as typeof fetch,
    async () => {
      const method = createOidcMethod(resolveOptions(baseOptions)[0])
      await assert.rejects(() => method.refresh(stale("r1")), /400 Bad Request/)

      fail = false
      const refreshed = await method.refresh(stale("r1"))
      assert.equal(refreshed.access, "fresh")
      assert.equal(refreshed.refresh, "r1")
    },
  )
})

test("label names the signed-in account from the access token's claims", () => {
  const method = createOidcMethod(resolveOptions(baseOptions)[0])
  const credential = { ...stale("r"), access: fakeJwt({ preferred_username: "hauke", exp: 1 }) }
  assert.equal(method.label(credential), "hauke @ id.example.com")
  assert.equal(method.label({ ...credential, access: "opaque" }), undefined)
})
