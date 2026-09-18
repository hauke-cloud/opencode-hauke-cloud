import { createHash } from "node:crypto"
import { test } from "node:test"
import assert from "node:assert/strict"
import { generatePkce, generateState } from "../pkce.js"

const BASE64URL = /^[A-Za-z0-9_-]+$/

test("generatePkce produces a base64url verifier of the RFC 7636 minimum length", () => {
  const { verifier } = generatePkce()
  assert.equal(verifier.length, 43)
  assert.match(verifier, BASE64URL)
})

test("generatePkce challenge is the base64url SHA-256 of the verifier", () => {
  const { verifier, challenge } = generatePkce()
  const expected = createHash("sha256").update(verifier).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  assert.equal(challenge, expected)
})

test("generatePkce and generateState are not reused across calls", () => {
  const a = generatePkce()
  const b = generatePkce()
  assert.notEqual(a.verifier, b.verifier)
  assert.notEqual(generateState(), generateState())
})
