/**
 * GitHub webhook signature verification (#227).
 *
 * Verifies GitHub's `X-Hub-Signature-256` header — an HMAC-SHA256 digest of the
 * raw request body keyed with the shared webhook secret — using Web Crypto
 * (`crypto.subtle`). Returns true only when the recomputed `sha256=<hex>` digest
 * exactly matches the supplied signature string; any mismatch (tampered body,
 * wrong secret, malformed signature) returns false. This is the webhook trust
 * boundary: it proves both authentic GitHub origin and body integrity.
 */
export async function verifyGitHubSignature(
  secret: string,
  body: string,
  signature: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signature;
}
