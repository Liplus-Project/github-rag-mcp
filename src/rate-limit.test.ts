import { afterEach, describe, expect, it, vi } from "vitest";
import { checkClientMetadataFetchRateLimit, rateLimitResponse } from "./rate-limit.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkClientMetadataFetchRateLimit", () => {
  it("allows 10 calls per IP in a window and refuses the 11th", () => {
    const allowed = Array.from({ length: 11 }, () => checkClientMetadataFetchRateLimit("198.51.100.1"));
    expect(allowed.filter(Boolean)).toHaveLength(10);
    expect(allowed.at(-1)).toBe(false);
  });

  it("keeps each IP on its own count", () => {
    for (let i = 0; i < 11; i++) checkClientMetadataFetchRateLimit("198.51.100.2");
    expect(checkClientMetadataFetchRateLimit("198.51.100.3")).toBe(true);
  });

  it("allows the IP again once the window has passed", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    for (let i = 0; i < 11; i++) checkClientMetadataFetchRateLimit("198.51.100.4");
    expect(checkClientMetadataFetchRateLimit("198.51.100.4")).toBe(false);
    now.mockReturnValue(1_000_000 + 60_000);
    expect(checkClientMetadataFetchRateLimit("198.51.100.4")).toBe(true);
  });
});

describe("rateLimitResponse", () => {
  it("is a 429 naming when to retry", () => {
    const response = rateLimitResponse();
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
  });
});
