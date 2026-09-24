import type { Model } from "@opencode/plugin"

export interface RemoteModel {
  id: string
  name?: string
}

// Reads an OpenAI-compatible "GET <baseURL>/models" listing. llama-swap adds a
// display "name" to each entry, which is used when present; plain OpenAI-style
// servers only send "id".
export async function fetchModels(baseURL: string, accessToken: string): Promise<RemoteModel[]> {
  const endpoint = `${baseURL.replace(/\/+$/, "")}/models`
  const res = await fetch(endpoint, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`opencode-hauke-cloud: model listing ${endpoint} failed (${res.status} ${res.statusText}): ${detail}`)
  }

  const body = (await res.json()) as { data?: unknown }
  if (!Array.isArray(body?.data)) {
    throw new Error(`opencode-hauke-cloud: model listing ${endpoint} returned no "data" array.`)
  }

  const models = new Map<string, RemoteModel>()
  for (const entry of body.data as { id?: unknown; name?: unknown }[]) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) continue
    const name = typeof entry.name === "string" && entry.name.length > 0 ? entry.name : undefined
    models.set(entry.id, { id: entry.id, ...(name ? { name } : {}) })
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// What the plugin's "models" option can set on a discovered model, keyed by
// model id or by a pattern where "*" matches any run of characters.
export interface ModelOverride {
  name?: string
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] }
  limit?: { context?: number; output?: number }
}

// The overrides that apply to a model id: patterns in the order they're
// written, then the exact entry, so the most specific one wins.
export function matchOverrides(overrides: Record<string, ModelOverride>, id: string): ModelOverride[] {
  const patterns = Object.entries(overrides)
    .filter(([key]) => key !== id && key.includes("*") && globToRegExp(key).test(id))
    .map(([, override]) => override)
  return overrides[id] ? [...patterns, overrides[id]] : patterns
}

function globToRegExp(glob: string): RegExp {
  const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${source}$`)
}

// A model definition as opencode's catalog stores it, with the same defaults
// opencode gives a model it knows nothing else about. The listing carries no
// limits or modalities, so these are conservative: text only, tool calling on.
// The plugin's "models" option adjusts them, and a same-named entry under the
// provider's "models" in opencode.json is applied on top of that by opencode.
export function toModelInfo(providerID: string, remote: RemoteModel, overrides: ModelOverride[] = []): Model.Info {
  // The ids are branded in opencode's schema; brands are compile-time only.
  const id = remote.id as Model.ID
  let name = remote.name ?? remote.id
  let capabilities = { tools: true, input: ["text"], output: ["text"] }
  let limit = { context: 200_000, output: 32_000 }
  for (const override of overrides) {
    name = override.name ?? name
    capabilities = { ...capabilities, ...override.capabilities }
    limit = { ...limit, ...override.limit }
  }
  return {
    id,
    modelID: id,
    providerID: providerID as Model.Info["providerID"],
    name,
    capabilities,
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit,
  }
}
