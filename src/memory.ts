// Long-term memory backed by the self-hosted mem0 service (hauke-cloud/mem0-server).
//
// Who the memories belong to is decided by the server, from the access token:
// this module sends the token of the provider's OIDC login (Keycloak adds the
// mem0 audience to it), so there is no second login and no API key. opencode's
// integration.connection.resolve() refreshes that token through this plugin's
// own refresh() when it is about to expire, so this file never touches the
// refresh token itself -- Keycloak rotates it, and a second refresher would
// end the session.
//
// Three things happen:
//   tools    memory_search / memory_add / memory_list / memory_delete, always
//            available to the model.
//   recall   before each model request, memories relevant to the latest user
//            message are added to the system prompt.
//   capture  each user message is sent to mem0, whose extraction model keeps
//            only durable facts (preferences, decisions, environment) and
//            merges them with what it already knows.
//
// recall and capture call mem0's models in llama-swap, which share an
// exclusive group with some local models. With any other local model loaded,
// touching them would evict it, so both only run when the session's model is
// either not local or in `sharedModels`. The tools always work -- calling one
// is an explicit choice.

import type { Plugin } from "@opencode/plugin"
import { execFileSync } from "node:child_process"
import path from "node:path"

export interface MemoryOptions {
  /** mem0-server base URL. */
  baseURL: string
  /** agent_id memories from opencode are filed under. */
  agentID: string
  autoRecall: boolean
  autoCapture: boolean
  /** Memories added to the system prompt per user message. */
  recallLimit: number
  /** Minimum similarity for a recalled memory; unset uses mem0's default. */
  recallThreshold?: number
  /** Recall is skipped rather than holding up the request past this. */
  recallTimeoutMs: number
  /** Providers whose models live in llama-swap next to the mem0 models. */
  localProviders: string[]
  /** Local models that run beside the mem0 models without being evicted. */
  sharedModels: string[]
  /** User messages shorter than this are not captured. */
  captureMinChars: number
}

export const MEMORY_DEFAULTS: Omit<MemoryOptions, "localProviders"> = {
  baseURL: "https://mem0.llm.lab.hauke.cloud",
  agentID: "opencode",
  autoRecall: true,
  autoCapture: true,
  recallLimit: 6,
  recallTimeoutMs: 15000,
  sharedModels: ["qwen3.8-27b-q4"],
  captureMinChars: 20,
}

export interface MemoryItem {
  id: string
  memory: string
  score?: number
  metadata?: Record<string, unknown> | null
  agent_id?: string
  created_at?: string
  updated_at?: string
}

type Context = Parameters<Plugin.Plugin["setup"]>[0]

class NotSignedIn extends Error {}

// owner/repo from the origin remote, so the same repository checked out in two
// places (or on two machines) shares its project memories.
export function projectFromRemote(url: string): string | undefined {
  return url.trim().match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]
}

function projectOf(directory: string): string {
  try {
    const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    })
    const project = projectFromRemote(url)
    if (project) return project
  } catch {
    // not a git checkout, or no origin
  }
  return path.basename(directory)
}

function textOf(message: { content?: ReadonlyArray<{ type: string; text?: string | null }> }): string {
  return (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

export function formatMemories(items: MemoryItem[], project: string): string {
  return items
    .map((item) => {
      const p = item.metadata?.project
      const tag = p === project ? "this project" : typeof p === "string" ? p : "general"
      return `- [${tag}] ${item.memory} (id ${item.id})`
    })
    .join("\n")
}

/** Registers the memory tools and the recall/capture hook; returns a disposer. */
export async function setupMemory(
  ctx: Context,
  integration: string,
  opts: MemoryOptions,
  logPrefix: string,
): Promise<() => Promise<void>> {
  const baseURL = opts.baseURL.replace(/\/+$/, "")
  const directory = ctx.location.project?.canonical ?? ctx.location.directory
  const project = projectOf(directory)

  async function token(): Promise<string> {
    const connection = await ctx.integration.connection.active(integration)
    const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
    if (credential?.type !== "oauth") {
      throw new NotSignedIn(`${logPrefix}: not signed in to "${integration}" -- run \`opencode auth login ${integration}\`.`)
    }
    return credential.access
  }

  async function api<T>(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${baseURL}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${await token()}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${logPrefix}: mem0 ${method} ${route} failed with HTTP ${response.status}: ${text}`)
    return (text ? JSON.parse(text) : undefined) as T
  }

  const search = (query: string, extra: Record<string, unknown>, signal?: AbortSignal) =>
    api<{ results: MemoryItem[] }>("POST", "/search", { query, ...extra }, signal).then((r) => r.results ?? [])

  // Whether mem0's models may be touched without evicting this session's model.
  function mayUseModels(model: { providerID: string; id: string }): boolean {
    return !opts.localProviders.includes(model.providerID) || opts.sharedModels.includes(model.id)
  }

  // ---------------------------------------------------------------- tools

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "memory_search",
      description:
        "Search your long-term memory about the user: preferences, decisions, conventions, environment " +
        "details and facts from earlier sessions. Use before asking the user something they may have told " +
        "you before.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, in natural language" },
          project_only: { type: "boolean", description: `Only memories about this project (${project})` },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum results (default 10)" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = raw as { query: string; project_only?: boolean; limit?: number }
        const items = await search(
          input.query,
          { top_k: input.limit ?? 10, ...(input.project_only ? { filters: { project } } : {}) },
          context.signal,
        )
        return { content: items.length ? formatMemories(items, project) : "No matching memories." }
      },
    })

    editor.add({
      name: "memory_add",
      description:
        "Save something worth remembering across sessions: a user preference, a decision and its reason, " +
        "a convention, or a fact about the user's environment. Not for transient task state. Scope " +
        "'project' ties it to the current repository, 'global' applies everywhere.",
      input: {
        type: "object",
        properties: {
          text: { type: "string", description: "The fact, as a self-contained statement" },
          scope: { type: "string", enum: ["project", "global"], description: "Default 'project'" },
          verbatim: {
            type: "boolean",
            description: "Store exactly this text instead of letting mem0 extract and merge facts (default false)",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = raw as { text: string; scope?: "project" | "global"; verbatim?: boolean }
        const scope = input.scope ?? "project"
        const result = await api<{ results: Array<{ id: string; memory: string; event?: string }> }>(
          "POST",
          "/memories",
          {
            messages: [{ role: "user", content: input.text }],
            agent_id: opts.agentID,
            metadata: scope === "project" ? { project, source: "opencode" } : { source: "opencode" },
            infer: !input.verbatim,
          },
          context.signal,
        )
        const events = result.results ?? []
        if (!events.length) return { content: "Nothing new to remember: mem0 found it already known or not durable." }
        return { content: events.map((e) => `${e.event ?? "ADD"}: ${e.memory} (id ${e.id})`).join("\n") }
      },
    })

    editor.add({
      name: "memory_list",
      description: "List stored memories about the user, optionally only those about the current project.",
      input: {
        type: "object",
        properties: {
          project_only: { type: "boolean", description: `Only memories about this project (${project})` },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum results (default 100)" },
        },
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = raw as { project_only?: boolean; limit?: number }
        const result = await api<{ results: MemoryItem[] }>(
          "GET",
          `/memories?limit=${input.limit ?? 100}`,
          undefined,
          context.signal,
        )
        let items = result.results ?? []
        if (input.project_only) items = items.filter((item) => item.metadata?.project === project)
        return { content: items.length ? formatMemories(items, project) : "No memories stored." }
      },
    })

    editor.add({
      name: "memory_delete",
      description: "Delete one stored memory by id, e.g. when it is wrong or the user asks to forget it.",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "Memory id, as shown by memory_search/memory_list" } },
        required: ["id"],
        additionalProperties: false,
      },
      async execute(raw, context) {
        const input = raw as { id: string }
        await api("DELETE", `/memories/${encodeURIComponent(input.id)}`, undefined, context.signal)
        return { content: `Deleted memory ${input.id}.` }
      },
    })
  })

  // ------------------------------------------------------- recall/capture

  // The context hook runs for every model request of the agent loop, i.e.
  // again after each tool round. Recall once per user message and reuse the
  // block, which also keeps the system prompt stable for prompt caching.
  const recalled = new Map<string, { key: string; block: string }>()
  const captured = new Set<string>()

  const registration = await ctx.session.hook("context", async (input) => {
    if (!opts.autoRecall && !opts.autoCapture) return
    if (!mayUseModels(input.model)) return

    const lastUser = [...input.messages].reverse().find((m) => m.role === "user")
    const text = lastUser ? textOf(lastUser) : ""
    if (!text) return
    const key = `${input.sessionID}:${lastUser?.id ?? ""}:${text.length}:${text.slice(0, 200)}`

    if (opts.autoCapture && !captured.has(key) && text.length >= opts.captureMinChars && !text.startsWith("/")) {
      captured.add(key)
      // Fire and forget: extraction takes a model call and must not hold
      // up the user's request.
      void api("POST", "/memories", {
        messages: [{ role: "user", content: text }],
        agent_id: opts.agentID,
        metadata: { project, source: "opencode" },
      }).catch((error) => {
        if (!(error instanceof NotSignedIn)) console.warn(`${logPrefix}: memory capture failed:`, error)
      })
    }

    if (!opts.autoRecall) return
    let entry = recalled.get(input.sessionID)
    if (entry?.key !== key) {
      let block = ""
      try {
        const items = await search(
          text.slice(0, 2000),
          {
            top_k: opts.recallLimit,
            ...(opts.recallThreshold === undefined ? {} : { threshold: opts.recallThreshold }),
          },
          AbortSignal.timeout(opts.recallTimeoutMs),
        )
        if (items.length) {
          block =
            "<memories>\n" +
            "Long-term memories about the user from earlier sessions (mem0), most relevant first. " +
            "They may be outdated: prefer what the user says now, and fix wrong ones with " +
            "memory_delete/memory_add.\n" +
            `Current project: ${project}\n` +
            formatMemories(items, project) +
            "\n</memories>"
        }
      } catch (error) {
        if (!(error instanceof NotSignedIn)) console.warn(`${logPrefix}: memory recall failed:`, error)
      }
      entry = { key, block }
      recalled.set(input.sessionID, entry)
    }
    if (entry.block) input.system.push({ type: "text", text: entry.block })
  })

  return () => registration.dispose()
}
