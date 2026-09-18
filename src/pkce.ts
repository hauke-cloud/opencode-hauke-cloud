import { createHash, randomBytes } from "node:crypto"

export interface Pkce {
  verifier: string
  challenge: string
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// RFC 7636: verifier is 43-128 chars of the base64url alphabet; 32 random
// bytes encodes to 43, the minimum, which is also all a public client needs.
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  return { verifier, challenge }
}

export function generateState(): string {
  return base64url(randomBytes(16))
}
