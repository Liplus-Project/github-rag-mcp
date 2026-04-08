/**
 * GitHub webhook receiver — signature verification and IP allowlist.
 *
 * Verifies incoming webhook requests using HMAC-SHA256 signature
 * and GitHub IP allowlist before processing events.
 * Event-specific handlers will be added in #54.
 */

import type { Env } from "./types.js";
import { isGitHubWebhookIP } from "./github-ip.js";

/**
 * Verify GitHub webhook signature using WebCrypto HMAC-SHA256.
 *
 * Compares the X-Hub-Signature-256 header value against the
 * computed HMAC of the request body.
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
  const expected =
    "sha256=" +
    Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return expected === signature;
}

/**
 * Handle incoming GitHub webhook request.
 *
 * Auth chain: IP allowlist -> signature verification -> parse event.
 * Returns 202 on success with event type acknowledgement.
 * Event-specific handlers will be added in #54.
 */
export async function handleWebhook(request: Request, env: Env): Promise<Response> {
  // 1. IP allowlist check
  const ipAllowed = await isGitHubWebhookIP(request);
  if (!ipAllowed) {
    return new Response("Forbidden", { status: 403 });
  }

  // 2. Signature verification
  if (!env.GITHUB_WEBHOOK_SECRET) {
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const signature = request.headers.get("X-Hub-Signature-256");
  if (!signature) {
    return new Response("Missing signature", { status: 401 });
  }

  const body = await request.text();
  const valid = await verifyGitHubSignature(env.GITHUB_WEBHOOK_SECRET, body, signature);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  // 3. Parse event
  const eventType = request.headers.get("X-GitHub-Event") ?? "unknown";

  // Event-specific handlers will be added in #54.
  // For now, acknowledge receipt.
  return new Response(JSON.stringify({ received: true, event: eventType }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}
