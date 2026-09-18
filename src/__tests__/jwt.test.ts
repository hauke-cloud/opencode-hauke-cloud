import { test } from "node:test"
import assert from "node:assert/strict"
import { decodeJwtExpiryMs } from "../jwt.js"

function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.signature`
}

test("decodeJwtExpiryMs reads the exp claim as milliseconds", () => {
  const token = fakeJwt({ exp: 1_700_000_000 })
  assert.equal(decodeJwtExpiryMs(token), 1_700_000_000_000)
})

test("decodeJwtExpiryMs returns null for a non-JWT (opaque) token", () => {
  assert.equal(decodeJwtExpiryMs("not-a-jwt"), null)
  assert.equal(decodeJwtExpiryMs("only.two"), null)
})

test("decodeJwtExpiryMs returns null when exp is missing or not a number", () => {
  assert.equal(decodeJwtExpiryMs(fakeJwt({ sub: "user" })), null)
  assert.equal(decodeJwtExpiryMs(fakeJwt({ exp: "soon" })), null)
})

test("decodeJwtExpiryMs returns null for a malformed base64 payload", () => {
  assert.equal(decodeJwtExpiryMs("header.not-json-!!!.signature"), null)
})
