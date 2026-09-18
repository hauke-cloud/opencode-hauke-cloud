// Reads the "exp" claim out of a JWT's payload segment without verifying its
// signature. That's fine here: the token isn't being trusted for
// authorization by this code, only used to schedule our own refresh -- the
// resource server verifies the signature for real.
export function decodeJwtExpiryMs(token: string): number | null {
  const parts = token.split(".")
  if (parts.length !== 3) return null

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: unknown }
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return payload.exp * 1000
    }
  } catch {
    // Not a JWT, or a malformed one -- caller falls back to expires_in.
  }
  return null
}
