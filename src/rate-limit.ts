/**
 * In-memory fixed-window limit on outbound Client ID Metadata Document fetches
 * (issue #299), following github-webhook-mcp worker/src/rate-limit.ts.
 *
 * Per isolate, so not consistent across Workers instances: requests spread over
 * many IPs or isolates pass it. A failed fetch is not remembered anywhere, since
 * draft-ietf-oauth-client-id-metadata-document-02 section 5.2 forbids caching
 * errors. The limit is what bounds repeated attempts.
 */

interface Counter {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_CLIENT_METADATA_CALLS = 10;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

const counters = new Map<string, Counter>();
let lastCleanup = 0;

function cleanup(now: number): void {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  for (const [key, counter] of counters) {
    if (now >= counter.resetAt) counters.delete(key);
  }
}

/** Counts this call. Returns false once the IP is over its limit for the window. */
export function checkClientMetadataFetchRateLimit(ip: string): boolean {
  const now = Date.now();
  cleanup(now);
  const existing = counters.get(ip);
  if (!existing || now >= existing.resetAt) {
    counters.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  existing.count++;
  return existing.count <= MAX_CLIENT_METADATA_CALLS;
}

export function rateLimitResponse(): Response {
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": "60" },
  });
}
