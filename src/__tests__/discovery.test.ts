import { test } from "node:test"
import assert from "node:assert/strict"
import { discoverIssuer } from "../discovery.js"

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return run().finally(() => {
    globalThis.fetch = original
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

test("discoverIssuer fetches the well-known document and caches it per issuer", async () => {
  let calls = 0
  await withMockFetch(
    (async (input: string | URL | Request) => {
      calls++
      assert.equal(String(input), "https://id.example.com/realms/cloud/.well-known/openid-configuration")
      return jsonResponse({
        issuer: "https://id.example.com/realms/cloud",
        authorization_endpoint: "https://id.example.com/realms/cloud/protocol/openid-connect/auth",
        token_endpoint: "https://id.example.com/realms/cloud/protocol/openid-connect/token",
      })
    }) as typeof fetch,
    async () => {
      const issuer = "https://id.example.com/realms/cloud"
      const first = await discoverIssuer(issuer)
      const second = await discoverIssuer(issuer)
      assert.equal(first, second)
      assert.equal(calls, 1)
      assert.equal(first.token_endpoint, "https://id.example.com/realms/cloud/protocol/openid-connect/token")
    },
  )
})

test("discoverIssuer trims a trailing slash before appending the well-known path and matching issuer", async () => {
  await withMockFetch(
    (async (input: string | URL | Request) => {
      assert.equal(String(input), "https://id.example.com/realms/trailing/.well-known/openid-configuration")
      return jsonResponse({
        issuer: "https://id.example.com/realms/trailing",
        authorization_endpoint: "https://id.example.com/realms/trailing/protocol/openid-connect/auth",
        token_endpoint: "https://id.example.com/realms/trailing/protocol/openid-connect/token",
      })
    }) as typeof fetch,
    () => discoverIssuer("https://id.example.com/realms/trailing/"),
  )
})

test("discoverIssuer does not cache a failed lookup", async () => {
  let calls = 0
  await withMockFetch(
    (async () => {
      calls++
      return new Response("boom", { status: 500, statusText: "Internal Server Error" })
    }) as typeof fetch,
    async () => {
      const issuer = "https://id.example.com/realms/flaky"
      await assert.rejects(() => discoverIssuer(issuer))
      await assert.rejects(() => discoverIssuer(issuer))
      assert.equal(calls, 2)
    },
  )
})

test("discoverIssuer rejects a document whose issuer claim doesn't match", async () => {
  await withMockFetch(
    (async () =>
      jsonResponse({
        issuer: "https://attacker.example.com",
        authorization_endpoint: "https://id.example.com/realms/mismatch/protocol/openid-connect/auth",
        token_endpoint: "https://id.example.com/realms/mismatch/protocol/openid-connect/token",
      })) as typeof fetch,
    async () => {
      await assert.rejects(() => discoverIssuer("https://id.example.com/realms/mismatch"), /claims issuer/)
    },
  )
})

test("discoverIssuer rejects a non-https authorization_endpoint", async () => {
  await withMockFetch(
    (async () =>
      jsonResponse({
        issuer: "https://id.example.com/realms/downgrade",
        authorization_endpoint: "http://id.example.com/realms/downgrade/protocol/openid-connect/auth",
        token_endpoint: "https://id.example.com/realms/downgrade/protocol/openid-connect/token",
      })) as typeof fetch,
    async () => {
      await assert.rejects(() => discoverIssuer("https://id.example.com/realms/downgrade"), /non-https authorization_endpoint/)
    },
  )
})

test("discoverIssuer rejects a non-https token_endpoint", async () => {
  await withMockFetch(
    (async () =>
      jsonResponse({
        issuer: "https://id.example.com/realms/downgrade2",
        authorization_endpoint: "https://id.example.com/realms/downgrade2/protocol/openid-connect/auth",
        token_endpoint: "http://id.example.com/realms/downgrade2/protocol/openid-connect/token",
      })) as typeof fetch,
    async () => {
      await assert.rejects(() => discoverIssuer("https://id.example.com/realms/downgrade2"), /non-https token_endpoint/)
    },
  )
})

test("discoverIssuer rejects a non-https end_session_endpoint when present", async () => {
  await withMockFetch(
    (async () =>
      jsonResponse({
        issuer: "https://id.example.com/realms/downgrade3",
        authorization_endpoint: "https://id.example.com/realms/downgrade3/protocol/openid-connect/auth",
        token_endpoint: "https://id.example.com/realms/downgrade3/protocol/openid-connect/token",
        end_session_endpoint: "http://id.example.com/realms/downgrade3/protocol/openid-connect/logout",
      })) as typeof fetch,
    async () => {
      await assert.rejects(() => discoverIssuer("https://id.example.com/realms/downgrade3"), /non-https end_session_endpoint/)
    },
  )
})
