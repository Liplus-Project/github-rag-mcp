/**
 * GitHub webhook signature verification (#227, hardened in #229).
 *
 * Validates GitHub's `X-Hub-Signature-256` header — an HMAC-SHA256 digest of the
 * raw request body keyed with the shared webhook secret — using Web Crypto's
 * `crypto.subtle.verify`, which recomputes the HMAC and compares it in CONSTANT
 * TIME. The previous implementation compared the recomputed digest with the
 * supplied signature via `===`, which early-exits on the first mismatched
 * character and leaks the expected signature through response timing — a timing
 * side-channel at the webhook trust boundary. The functional contract is
 * unchanged: a correct signature returns true; any mismatch (tampered body,
 * wrong secret, malformed signature) returns false. This is the webhook trust
 * boundary: it proves both authentic GitHub origin and body integrity.
 */
export async function verifyGitHubSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const hex = signature.slice(prefix.length);
  // An HMAC-SHA256 digest is 32 bytes = exactly 64 hex chars. Reject any other
  // shape before touching crypto so malformed input fails fast and uniformly.
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return false;

  const sigBytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    sigBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // verify() recomputes the HMAC and compares it in constant time.
  return crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(body));
}
