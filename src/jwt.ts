// Reads a JWT's payload segment without verifying its signature. That's fine
// here: the token isn't being trusted for authorization by this code, only
// used to schedule our own refresh and label the saved connection -- the
// resource server verifies the signature for real.
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown
    if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>
  } catch {
    // Not a JWT, or a malformed one.
  }
  return null
}

// Reads the "exp" claim; null means the caller falls back to expires_in.
export function decodeJwtExpiryMs(token: string): number | null {
  const exp = decodeJwtClaims(token)?.exp
  if (typeof exp === "number" && Number.isFinite(exp)) {
    return exp * 1000
  }
  return null
}
