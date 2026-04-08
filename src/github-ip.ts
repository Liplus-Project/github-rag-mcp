/**
 * GitHub IP allowlist for webhook endpoint protection.
 *
 * Fetches GitHub's webhook IP ranges from api.github.com/meta,
 * caches them with Cache API + in-memory, and checks incoming
 * requests against the allowlist.
 * Falls back to hardcoded ranges if the API is unreachable.
 */

// Hardcoded fallback — GitHub webhook IPs as of 2026-03.
// Update periodically or rely on the live fetch.
const FALLBACK_CIDRS = [
  "140.82.112.0/20",
  "185.199.108.0/22",
  "192.30.252.0/22",
  "143.55.64.0/20",
];

const CACHE_KEY = "https://api.github.com/meta#hooks";
const CACHE_TTL_SECONDS = 3600; // 1 hour

/** In-memory cache for the current isolate lifetime */
let memCache: { cidrs: string[]; expiresAt: number } | null = null;

/**
 * Parse an IPv4 CIDR and return [networkInt, maskInt].
 * Returns null for IPv6 or invalid input.
 */
function parseIPv4CIDR(cidr: string): [number, number] | null {
  const match = cidr.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!match) return null;
  const ip = match[1];
  const prefix = parseInt(match[2], 10);
  if (prefix < 0 || prefix > 32) return null;

  const parts = ip.split(".").map(Number);
  if (parts.some((p) => p < 0 || p > 255)) return null;

  const ipInt = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return [ipInt >>> 0, mask];
}

/** Parse an IPv4 address to a 32-bit unsigned integer. Returns null for IPv6. */
function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

/** Check if an IPv4 address matches any of the given CIDRs. */
function ipMatchesCIDRs(ip: string, cidrs: string[]): boolean {
  const ipInt = parseIPv4(ip);
  if (ipInt === null) {
    // IPv6 — allow through (GitHub rarely sends webhooks via IPv6)
    return true;
  }

  for (const cidr of cidrs) {
    const parsed = parseIPv4CIDR(cidr);
    if (!parsed) continue; // skip IPv6 CIDRs
    const [network, mask] = parsed;
    if ((ipInt & mask) === (network & mask)) return true;
  }
  return false;
}

/**
 * Fetch GitHub webhook IP ranges, with Cache API + in-memory caching.
 * Falls back to hardcoded ranges on failure.
 */
async function getGitHubHookCIDRs(): Promise<string[]> {
  // 1. Check in-memory cache
  if (memCache && Date.now() < memCache.expiresAt) {
    return memCache.cidrs;
  }

  // 2. Check Cache API
  try {
    const cache = caches.default;
    const cached = await cache.match(CACHE_KEY);
    if (cached) {
      const data = (await cached.json()) as { hooks?: string[] };
      if (data.hooks?.length) {
        memCache = { cidrs: data.hooks, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
        return data.hooks;
      }
    }
  } catch {
    // Cache API may not be available in some environments
  }

  // 3. Fetch from GitHub
  try {
    const res = await fetch("https://api.github.com/meta", {
      headers: { "User-Agent": "github-rag-mcp" },
    });
    if (res.ok) {
      const data = (await res.json()) as { hooks?: string[] };
      if (data.hooks?.length) {
        // Store in Cache API
        try {
          const cache = caches.default;
          await cache.put(
            CACHE_KEY,
            new Response(JSON.stringify(data), {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `max-age=${CACHE_TTL_SECONDS}`,
              },
            }),
          );
        } catch {
          // Cache write failure is non-fatal
        }

        memCache = { cidrs: data.hooks, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
        return data.hooks;
      }
    }
  } catch {
    // Network failure — fall through to hardcoded
  }

  // 4. Fallback
  return FALLBACK_CIDRS;
}

/**
 * Check if the request comes from a GitHub webhook IP.
 * Returns true if allowed, false if blocked.
 *
 * Skips the check when CF-Connecting-IP is absent (local dev).
 */
export async function isGitHubWebhookIP(request: Request): Promise<boolean> {
  const clientIP = request.headers.get("CF-Connecting-IP");

  // In local dev (wrangler dev), CF-Connecting-IP may be absent — allow through
  if (!clientIP) return true;

  const cidrs = await getGitHubHookCIDRs();
  return ipMatchesCIDRs(clientIP, cidrs);
}
