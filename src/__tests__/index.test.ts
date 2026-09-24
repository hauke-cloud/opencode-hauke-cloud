import { test } from "node:test"
import assert from "node:assert/strict"
import plugin, { DEFAULTS, METHOD_ID, PLUGIN_ID, createOidcMethod, resolveOptions } from "../index.js"

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

test("setup defines the provider and its integration, and registers the OAuth method", async () => {
  const integrations: Record<string, { id: string; name: string }> = {}
  const registered: { integrationID: string; method: { id: string; type: string } }[] = []
  const providers: Record<string, { id: string; name: string; package: string; settings?: Record<string, unknown> }> = {}
  await plugin.setup({
    options: { ...baseOptions, discoverModels: false, memory: false },
    integration: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          update: (id: string, edit: (integration: { id: string; name: string }) => void) =>
            edit((integrations[id] ??= { id, name: id })),
          method: { update: (input: (typeof registered)[number]) => registered.push(input) },
        })
        return { dispose: async () => {} }
      },
    },
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          update: (id: string, edit: (provider: (typeof providers)[string]) => void) =>
            edit((providers[id] ??= { id, name: id, package: "", settings: { timeout: false } })),
        })
        return { dispose: async () => {} }
      },
    },
  } as never)

  assert.equal(plugin.id, PLUGIN_ID)
  assert.deepEqual(integrations, { "llama-swap": { id: "llama-swap", name: "hauke.cloud" } })
  assert.deepEqual(
    registered.map((r) => [r.integrationID, r.method.id, r.method.type]),
    [["llama-swap", METHOD_ID, "oauth"]],
  )
  assert.deepEqual(providers["llama-swap"], {
    id: "llama-swap",
    name: "hauke.cloud",
    package: "@ai-sdk/openai-compatible",
    settings: { timeout: false, baseURL: DEFAULTS.baseURL },
  })
})

test("resolveOptions defaults everything to hauke.cloud and lets each value be overridden", () => {
  const defaults = resolveOptions(undefined)
  assert.equal(defaults.provider, "hauke-cloud")
  assert.equal(defaults.issuer, "https://id.hauke.cloud/realms/cloud")
  assert.equal(defaults.scope, "openid profile email offline_access")
  assert.equal(defaults.discoverModels, true)
  assert.ok(defaults.memory)
  assert.deepEqual(defaults.memory.localProviders, ["ollama", "hauke-cloud"])

  const custom = resolveOptions({ ...baseOptions, memory: { recallLimit: 2 } })
  assert.equal(custom.provider, "llama-swap")
  assert.equal(custom.clientId, "opencode")
  assert.ok(custom.memory)
  assert.equal(custom.memory.recallLimit, 2)
  assert.deepEqual(custom.memory.localProviders, ["ollama", "llama-swap"])

  assert.equal(resolveOptions({ memory: false }).memory, false)
  assert.throws(() => resolveOptions({ providers: [baseOptions] }), /"providers" is not supported/)
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
      const method = createOidcMethod(resolveOptions(baseOptions))

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
      const method = createOidcMethod(resolveOptions(baseOptions))
      await assert.rejects(() => method.refresh(stale("r1")), /400 Bad Request/)

      fail = false
      const refreshed = await method.refresh(stale("r1"))
      assert.equal(refreshed.access, "fresh")
      assert.equal(refreshed.refresh, "r1")
    },
  )
})

test("label names the signed-in account from the access token's claims", () => {
  const method = createOidcMethod(resolveOptions(baseOptions))
  const credential = { ...stale("r"), access: fakeJwt({ preferred_username: "hauke", exp: 1 }) }
  assert.equal(method.label(credential), "hauke @ id.example.com")
  assert.equal(method.label({ ...credential, access: "opaque" }), undefined)
})
