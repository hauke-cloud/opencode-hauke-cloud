import { test } from "node:test"
import assert from "node:assert/strict"
import { discoverProviderModels } from "../index.js"
import { fetchModels, toModelInfo } from "../models.js"

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return run().finally(() => {
    globalThis.fetch = original
  })
}

test("fetchModels sends the bearer token and reads ids and llama-swap names, deduped and sorted", async () => {
  let seen: { url: string; auth: string | null } | null = null
  await withMockFetch(
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") }
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "qwen", name: "Qwen", object: "model" },
            { id: "gpt-oss", object: "model" },
            { id: "qwen", name: "Duplicate" },
            { id: "" },
            { name: "no id" },
          ],
        }),
        { status: 200 },
      )
    }) as typeof fetch,
    async () => {
      const models = await fetchModels("https://llm.example.com/v1/", "token-1")
      assert.deepEqual(models, [{ id: "gpt-oss" }, { id: "qwen", name: "Duplicate" }])
    },
  )
  assert.deepEqual(seen, { url: "https://llm.example.com/v1/models", auth: "Bearer token-1" })
})

test("fetchModels raises on a non-2xx response or a body without a data array", async () => {
  await withMockFetch(
    (async () => new Response("nope", { status: 403, statusText: "Forbidden" })) as typeof fetch,
    () => assert.rejects(() => fetchModels("https://llm.example.com/v1", "t"), /403 Forbidden/),
  )
  await withMockFetch(
    (async () => new Response("{}", { status: 200 })) as typeof fetch,
    () => assert.rejects(() => fetchModels("https://llm.example.com/v1", "t"), /no "data" array/),
  )
})

test("toModelInfo falls back to the id for the name", () => {
  const info = toModelInfo("llama-swap", { id: "gpt-oss" })
  assert.equal(info.name, "gpt-oss")
  assert.equal(info.providerID, "llama-swap")
  assert.deepEqual(info.capabilities.input, ["text"])
})

// A stand-in for the slice of opencode's plugin context discovery uses: one
// provider transform, a connection that can be switched, and an event stream.
function fakeContext() {
  const state = {
    connection: { type: "credential", id: "cred_1", label: "a" } as { type: string; id: string; label: string } | undefined,
    access: "access-a",
    reloads: 0,
    transform: null as ((editor: unknown) => void) | null,
    events: [] as ((event: unknown) => void)[],
  }
  const configured = new Map([
    ["gpt-oss", { id: "gpt-oss", name: "GPT-OSS from config" }],
    // Configured without a name, e.g. only to set limits.
    ["qwen", { id: "qwen", name: "qwen" }],
  ])

  const ctx = {
    provider: {
      transform: async (callback: (editor: unknown) => void) => {
        state.transform = callback
        return { dispose: async () => {} }
      },
      reload: async () => {
        state.reloads++
      },
      get: async () => ({ data: { settings: { baseURL: "https://llm.example.com/v1" } } }),
    },
    integration: {
      connection: {
        active: async () => state.connection,
        resolve: async () => ({ type: "oauth", methodID: "oidc", access: state.access, refresh: "r", expires: 0 }),
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            yield await new Promise((resolve) => state.events.push(resolve))
          }
        },
      }),
    },
  }

  // Runs the registered transform against a provider record the config defined,
  // or -- as opencode does for a provider only opencode.json defines, whose
  // record the config transform creates after plugin transforms -- none at all.
  type Added = { models: { id: string; name: string }[]; sourceConnection: unknown }
  function fold({ recordExists = true } = {}): Added | null {
    const result: { added: Added | null } = { added: null }
    let record = recordExists ? { provider: { id: "llama-swap" }, models: configured } : undefined
    state.transform!({
      get: () => record,
      update: (id: string, edit: (info: { id: string }) => void) => {
        record ??= { provider: { id }, models: new Map() }
        edit(record.provider)
      },
      add: (definition: Added) => {
        result.added = definition
      },
    })
    return result.added
  }

  const emit = (event: unknown) => state.events.splice(0).forEach((resolve) => resolve(event))
  return { ctx, state, fold, emit }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test("discovery adds listed models next to configured ones, bound to the listing account, and follows account switches", async () => {
  const { ctx, state, fold, emit } = fakeContext()
  const controller = new AbortController()

  await withMockFetch(
    (async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization")
      const data = auth === "Bearer access-a" ? [{ id: "gpt-oss", name: "GPT-OSS 120B" }, { id: "qwen", name: "Qwen" }, { id: "tiny" }] : [{ id: "only-b" }]
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as typeof fetch,
    async () => {
      await discoverProviderModels(ctx as never, "llama-swap", controller.signal)
      assert.equal(fold(), null, "nothing is added before the first listing arrives")

      await settle()
      assert.equal(state.reloads, 1)
      const first = fold()!
      assert.deepEqual(
        first.models.map((m) => [m.id, m.name]),
        [
          ["gpt-oss", "GPT-OSS from config"],
          ["qwen", "Qwen"],
          ["tiny", "tiny"],
        ],
      )
      assert.deepEqual(first.sourceConnection, { type: "credential", id: "cred_1", label: "a" })

      // Token refreshes and other integrations' switches don't trigger a new listing.
      emit({ type: "credential.updated", data: {} })
      await settle()
      emit({ type: "credential.switched", data: { integrationID: "other", credentialID: "x" } })
      await settle()
      assert.equal(state.reloads, 1)

      state.connection = { type: "credential", id: "cred_2", label: "b" }
      state.access = "access-b"
      emit({ type: "credential.switched", data: { integrationID: "llama-swap", credentialID: "cred_2" } })
      await settle()
      assert.equal(state.reloads, 2)
      const second = fold()!
      assert.deepEqual(second.models.map((m) => m.id), ["gpt-oss", "qwen", "only-b"])
      assert.deepEqual(second.sourceConnection, { type: "credential", id: "cred_2", label: "b" })

      state.connection = undefined
      emit({ type: "credential.switched", data: { integrationID: "llama-swap", credentialID: null } })
      await settle()
      assert.equal(state.reloads, 3)
      assert.equal(fold(), null, "signing out drops the discovered models")
    },
  )
  controller.abort()
  emit({ type: "shutdown" })
})

test("discovery creates the provider record when the config transform hasn't run yet", async () => {
  const { ctx, fold, emit } = fakeContext()
  const controller = new AbortController()

  await withMockFetch(
    (async () => new Response(JSON.stringify({ data: [{ id: "tiny", name: "Tiny" }] }), { status: 200 })) as typeof fetch,
    async () => {
      await discoverProviderModels(ctx as never, "llama-swap", controller.signal)
      assert.equal(fold({ recordExists: false }), null, "no record is created before the first listing arrives")
      await settle()
      const added = fold({ recordExists: false })!
      assert.deepEqual(added.models.map((m) => [m.id, m.name]), [["tiny", "Tiny"]])
      assert.deepEqual(added.sourceConnection, { type: "credential", id: "cred_1", label: "a" })
    },
  )
  controller.abort()
  emit({ type: "shutdown" })
})

test("a failed listing keeps the last good models instead of dropping them", async () => {
  const { ctx, state, fold, emit } = fakeContext()
  const controller = new AbortController()
  let up = true
  const warn = console.warn
  console.warn = () => {}

  try {
    await withMockFetch(
      (async () =>
        up
          ? new Response(JSON.stringify({ data: [{ id: "tiny" }] }), { status: 200 })
          : new Response("down", { status: 502, statusText: "Bad Gateway" })) as typeof fetch,
      async () => {
        await discoverProviderModels(ctx as never, "llama-swap", controller.signal)
        await settle()
        assert.equal(state.reloads, 1)

        up = false
        emit({ type: "credential.switched", data: { integrationID: "llama-swap", credentialID: "cred_1" } })
        await settle()
        assert.equal(state.reloads, 1)
        assert.deepEqual(fold()!.models.map((m) => m.id), ["gpt-oss", "qwen", "tiny"])
      },
    )
  } finally {
    console.warn = warn
    controller.abort()
    emit({ type: "shutdown" })
  }
})
