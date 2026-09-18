export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  end_session_endpoint?: string
}

const cache = new Map<string, Promise<OidcDiscovery>>()

// Cached per issuer for the life of the opencode process: discovery documents
// change essentially never, and loader() may consult this on every request
// once an access token is close to expiry.
export function discoverIssuer(issuer: string): Promise<OidcDiscovery> {
  const existing = cache.get(issuer)
  if (existing) return existing

  const promise = fetchDiscovery(issuer)
  promise.catch(() => cache.delete(issuer))
  cache.set(issuer, promise)
  return promise
}

async function fetchDiscovery(issuer: string): Promise<OidcDiscovery> {
  const normalizedIssuer = issuer.replace(/\/+$/, "")
  const url = `${normalizedIssuer}/.well-known/openid-configuration`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`opencode-oidc-plugin: discovery request to ${url} failed (${res.status} ${res.statusText})`)
  }
  const doc = (await res.json()) as OidcDiscovery

  // The issuer here is operator-configured, not attacker-controlled, but the
  // document it points to is fetched over the network on every fresh start.
  // A misrouted proxy or MITM that serves a different issuer's discovery doc
  // (or endpoints on plain http) would otherwise have opencode send the PKCE
  // code exchange -- and the token that comes back from it -- to whatever
  // token_endpoint that document names. OIDC Discovery requires the "issuer"
  // member to equal the URL discovery was fetched from, so checking it costs
  // nothing and catches exactly that.
  if (doc.issuer !== normalizedIssuer) {
    throw new Error(
      `opencode-oidc-plugin: discovery document from ${url} claims issuer "${doc.issuer}", expected "${normalizedIssuer}" -- refusing to trust it.`,
    )
  }

  assertHttps(doc.authorization_endpoint, "authorization_endpoint", url)
  assertHttps(doc.token_endpoint, "token_endpoint", url)
  if (doc.end_session_endpoint !== undefined) {
    assertHttps(doc.end_session_endpoint, "end_session_endpoint", url)
  }

  return doc
}

function assertHttps(value: string | undefined, field: string, discoveryUrl: string): asserts value is string {
  if (!value || !value.startsWith("https://")) {
    throw new Error(
      `opencode-oidc-plugin: discovery document from ${discoveryUrl} has a non-https ${field} ("${value}") -- refusing to use it.`,
    )
  }
}
