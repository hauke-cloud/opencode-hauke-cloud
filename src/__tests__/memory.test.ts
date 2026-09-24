import { test } from "node:test"
import assert from "node:assert/strict"
import { MEMORY_DEFAULTS, formatMemories, projectFromRemote, setupMemory } from "../memory.js"

function withMockFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return run().finally(() => {
    globalThis.fetch = original
  })
}

test("projectFromRemote reads owner/repo from ssh and https remotes", () => {
  assert.equal(projectFromRemote("git@github.com:hauke-cloud/mem0-server.git\n"), "hauke-cloud/mem0-server")
  assert.equal(projectFromRemote("https://github.com/hauke-cloud/mem0-server"), "hauke-cloud/mem0-server")
  assert.equal(projectFromRemote("https://github.com/hauke-cloud/mem0-server.git/"), "hauke-cloud/mem0-server")
  assert.equal(projectFromRemote("not a remote"), undefined)
})

test("formatMemories tags each memory with its project", () => {
  assert.equal(
    formatMemories(
      [
        { id: "1", memory: "uses zsh", metadata: null },
        { id: "2", memory: "tabs", metadata: { project: "a/b" } },
        { id: "3", memory: "spaces", metadata: { project: "c/d" } },
      ],
      "a/b",
    ),
    "- [general] uses zsh (id 1)\n- [this project] tabs (id 2)\n- [c/d] spaces (id 3)",
  )
})

// The slice of opencode's plugin context memory uses: a signed-in connection,
// the tool editor and the session "context" hook.
function fakeContext(signedIn = true) {
  const state = {
    tools: [] as { name: string; execute: (input: unknown, context: { signal?: AbortSignal }) => Promise<{ content: string }> }[],
    hook: null as ((input: unknown) => Promise<void>) | null,
  }
  const ctx = {
    location: { directory: "/tmp/not-a-checkout" },
    integration: {
      connection: {
        active: async () => (signedIn ? { type: "credential", id: "cred_1" } : undefined),
        resolve: async () => ({ type: "oauth", methodID: "oidc", access: "access-a", refresh: "r", expires: 0 }),
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (tool: (typeof state.tools)[number]) => state.tools.push(tool) })
        return { dispose: async () => {} }
      },
    },
    session: {
      hook: async (name: string, hook: (input: unknown) => Promise<void>) => {
        assert.equal(name, "context")
        state.hook = hook
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, state }
}

const turn = (text: string, model = { providerID: "anthropic", id: "claude" }) => {
  const system: { type: string; text: string }[] = []
  return {
    input: {
      sessionID: "ses_1",
      model,
      system,
      messages: [{ id: "msg_1", role: "user", content: [{ type: "text", text }] }],
    },
    system,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test("memory registers its tools and recalls once per user message, capturing it in the background", async () => {
  const { ctx, state } = fakeContext()
  const calls: { method: string; url: string; auth: string | null; body: any }[] = []

  await withMockFetch(
    (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      const results = String(input).endsWith("/search") ? [{ id: "m1", memory: "prefers tabs", metadata: null }] : []
      return new Response(JSON.stringify({ results }), { status: 200 })
    }) as typeof fetch,
    async () => {
      const opts = { ...MEMORY_DEFAULTS, baseURL: "https://mem0.example.com/", localProviders: ["hauke-cloud"] }
      await setupMemory(ctx as never, "hauke-cloud", opts, "test")
      assert.deepEqual(
        state.tools.map((t) => t.name),
        ["memory_search", "memory_add", "memory_list", "memory_delete"],
      )

      const first = turn("please remember that I always use tabs for indentation")
      await state.hook!(first.input)
      await settle()
      assert.match(first.system[0].text, /<memories>[\s\S]*- \[general\] prefers tabs \(id m1\)/)
      assert.deepEqual(
        calls.map((c) => [c.method, c.url, c.auth]),
        [
          ["POST", "https://mem0.example.com/memories", "Bearer access-a"],
          ["POST", "https://mem0.example.com/search", "Bearer access-a"],
        ],
      )
      assert.equal(calls[0].body.messages[0].content, "please remember that I always use tabs for indentation")

      // The agent loop's next request for the same message reuses the block.
      const again = turn("please remember that I always use tabs for indentation")
      await state.hook!(again.input)
      assert.equal(again.system[0].text, first.system[0].text)
      assert.equal(calls.length, 2)

      // A local model that would be evicted by mem0's models leaves them alone.
      const local = turn("something else entirely, long enough to capture", { providerID: "hauke-cloud", id: "gpt-oss" })
      await state.hook!(local.input)
      assert.deepEqual(local.system, [])
      assert.equal(calls.length, 2)

      const search = state.tools.find((t) => t.name === "memory_search")!
      assert.equal((await search.execute({ query: "tabs" }, {})).content, "- [general] prefers tabs (id m1)")
    },
  )
})

test("memory stays quiet when not signed in", async () => {
  const { ctx, state } = fakeContext(false)
  const warn = console.warn
  const warnings: unknown[] = []
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    await withMockFetch(
      (async () => {
        throw new Error("no request expected")
      }) as typeof fetch,
      async () => {
        await setupMemory(ctx as never, "hauke-cloud", { ...MEMORY_DEFAULTS, localProviders: [] }, "test")
        const { input, system } = turn("a message that is long enough to be captured")
        await state.hook!(input)
        await settle()
        assert.deepEqual(system, [])
        assert.deepEqual(warnings, [])
      },
    )
  } finally {
    console.warn = warn
  }
})
