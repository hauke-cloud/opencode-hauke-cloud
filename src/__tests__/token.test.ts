import { test } from "node:test"
import assert from "node:assert/strict"
import { exchangeCode, refreshAccessToken, resolveExpiryMs, type TokenResponse } from "../token.js"

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

test("exchangeCode posts the authorization_code grant with PKCE verifier, no client secret", async () => {
  let body = ""
  await withMockFetch(
    (async (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body)
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 300, token_type: "Bearer" }), { status: 200 })
    }) as typeof fetch,
    async () => {
      const tokens = await exchangeCode("https://id.example.com/token", {
        clientId: "opencode",
        code: "the-code",
        redirectUri: "http://127.0.0.1:51121/callback",
        codeVerifier: "the-verifier",
      })
      assert.equal(tokens.access_token, "a")
      assert.equal(tokens.refresh_token, "r")
    },
  )

  const params = new URLSearchParams(body)
  assert.equal(params.get("grant_type"), "authorization_code")
  assert.equal(params.get("client_id"), "opencode")
  assert.equal(params.get("code"), "the-code")
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:51121/callback")
  assert.equal(params.get("code_verifier"), "the-verifier")
  assert.equal(params.get("client_secret"), null)
})

test("refreshAccessToken posts the refresh_token grant", async () => {
  let body = ""
  await withMockFetch(
    (async (_input: string | URL | Request, init?: RequestInit) => {
      body = String(init?.body)
      return new Response(JSON.stringify({ access_token: "new-access", expires_in: 300, token_type: "Bearer" }), { status: 200 })
    }) as typeof fetch,
    () => refreshAccessToken("https://id.example.com/token", { clientId: "opencode", refreshToken: "old-refresh" }),
  )

  const params = new URLSearchParams(body)
  assert.equal(params.get("grant_type"), "refresh_token")
  assert.equal(params.get("refresh_token"), "old-refresh")
})

test("a non-2xx token response raises with status and body for diagnosis", async () => {
  await withMockFetch(
    (async () => new Response("invalid_grant", { status: 400, statusText: "Bad Request" })) as typeof fetch,
    async () => {
      await assert.rejects(
        () => refreshAccessToken("https://id.example.com/token", { clientId: "opencode", refreshToken: "expired" }),
        /400.*invalid_grant/s,
      )
    },
  )
})

test("resolveExpiryMs prefers the access token's own exp claim over expires_in", () => {
  const tokens: TokenResponse = {
    access_token: fakeJwt({ exp: 1_700_000_000 }),
    expires_in: 999999, // deliberately inconsistent with exp, to prove exp wins
    token_type: "Bearer",
  }
  assert.equal(resolveExpiryMs(tokens), 1_700_000_000_000)
})

test("resolveExpiryMs falls back to expires_in for an opaque access token", () => {
  const before = Date.now()
  const tokens: TokenResponse = { access_token: "opaque-token", expires_in: 300, token_type: "Bearer" }
  const expiry = resolveExpiryMs(tokens)
  assert.ok(expiry >= before + 300_000)
  assert.ok(expiry <= Date.now() + 300_000)
})

test("resolveExpiryMs throws rather than guessing when neither exp nor a usable expires_in exists", () => {
  const tokens = { access_token: "opaque-token", expires_in: Number.NaN, token_type: "Bearer" } as TokenResponse
  assert.throws(() => resolveExpiryMs(tokens), /refusing to guess an expiry/)
})
