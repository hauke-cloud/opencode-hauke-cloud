import { decodeJwtExpiryMs } from "./jwt.js"

export interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
}

// Prefers the access token's own "exp" claim over doing Date.now() +
// expires_in arithmetic on our end: it's the authoritative value the
// resource server itself will check, and some IdPs round or omit
// expires_in in ways that drift from it. If the access token isn't a JWT
// (opaque tokens are legal OIDC), or a response has neither a decodable exp
// claim nor a sane expires_in, fail loudly -- silently computing a NaN or
// negative expiry means loader() would either never refresh or refresh on
// every single request.
export function resolveExpiryMs(tokens: TokenResponse): number {
  const fromJwt = decodeJwtExpiryMs(tokens.access_token)
  if (fromJwt !== null) return fromJwt

  if (typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in) && tokens.expires_in > 0) {
    return Date.now() + tokens.expires_in * 1000
  }

  throw new Error(
    'opencode-oidc-plugin: token response had no decodable JWT "exp" claim and no usable expires_in -- refusing to guess an expiry.',
  )
}

async function postForm(endpoint: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => "")
    throw new Error(`opencode-oidc-plugin: token request to ${endpoint} failed (${res.status} ${res.statusText}): ${detail}`)
  }
  return (await res.json()) as TokenResponse
}

export function exchangeCode(
  endpoint: string,
  params: { clientId: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<TokenResponse> {
  return postForm(endpoint, {
    grant_type: "authorization_code",
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  })
}

export function refreshAccessToken(
  endpoint: string,
  params: { clientId: string; refreshToken: string },
): Promise<TokenResponse> {
  return postForm(endpoint, {
    grant_type: "refresh_token",
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  })
}
