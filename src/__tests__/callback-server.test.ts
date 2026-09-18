import { test } from "node:test"
import assert from "node:assert/strict"
import { startCallbackServer } from "../callback-server.js"

// Ports are picked per test (not 0/ephemeral) since startCallbackServer's
// contract is a fixed, pre-registered redirect_uri port -- exercise it the
// way a real IdP redirect would hit it.
let nextPort = 51200
function port(): number {
  return nextPort++
}

test("resolves with the code on a matching state", async () => {
  const p = port()
  const server = await startCallbackServer({ port: p, path: "/callback", state: "expected-state" })
  const res = await fetch(`http://127.0.0.1:${p}/callback?code=abc123&state=expected-state`)
  assert.equal(res.status, 200)
  assert.deepEqual(await server.result, { code: "abc123" })
})

test("resolves with the IdP's error and error_description on a denied login", async () => {
  const p = port()
  const server = await startCallbackServer({ port: p, path: "/callback", state: "s" })
  await fetch(`http://127.0.0.1:${p}/callback?error=access_denied&error_description=user+cancelled`)
  assert.deepEqual(await server.result, { error: "access_denied", errorDescription: "user cancelled" })
})

test("resolves with invalid_state when the state doesn't match", async () => {
  const p = port()
  const server = await startCallbackServer({ port: p, path: "/callback", state: "expected" })
  const res = await fetch(`http://127.0.0.1:${p}/callback?code=abc&state=wrong`)
  assert.equal(res.status, 400)
  assert.deepEqual(await server.result, { error: "invalid_state" })
})

test("resolves with invalid_state when code is missing", async () => {
  const p = port()
  const server = await startCallbackServer({ port: p, path: "/callback", state: "expected" })
  await fetch(`http://127.0.0.1:${p}/callback?state=expected`)
  assert.deepEqual(await server.result, { error: "invalid_state" })
})

test("ignores requests to other paths and keeps waiting", async () => {
  const p = port()
  const server = await startCallbackServer({ port: p, path: "/callback", state: "s" })
  const probe = await fetch(`http://127.0.0.1:${p}/favicon.ico`)
  assert.equal(probe.status, 404)

  await fetch(`http://127.0.0.1:${p}/callback?code=real&state=s`)
  assert.deepEqual(await server.result, { code: "real" })
})

test("times out if no redirect ever arrives", async () => {
  const p = port()
  const server = await startCallbackServer({ port: p, path: "/callback", state: "s", timeoutMs: 50 })
  const result = await server.result
  assert.equal(result.error, "timeout")
  assert.match(result.errorDescription ?? "", /Timed out waiting/)
})

test("rejects startup if the port is already bound", async () => {
  const p = port()
  const first = await startCallbackServer({ port: p, path: "/callback", state: "s" })
  await assert.rejects(() => startCallbackServer({ port: p, path: "/callback", state: "s" }))
  first.close()
})
