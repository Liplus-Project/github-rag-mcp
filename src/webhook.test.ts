import { describe, it, expect } from "vitest";
import { verifyGitHubSignature } from "./webhook.js";

// GitHub's own published example (docs.github.com, "Validating webhook deliveries"):
//   secret  = "It's a Secret to Everybody"
//   payload = "Hello, World!"
//   X-Hub-Signature-256 = sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17
// Used here as an independent oracle for the HMAC-SHA256 contract.
const SECRET = "It's a Secret to Everybody";
const BODY = "Hello, World!";
const VALID = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

describe("webhook: verifyGitHubSignature (HMAC-SHA256, X-Hub-Signature-256)", () => {
  it("accepts a signature matching GitHub's published example vector", async () => {
    expect(await verifyGitHubSignature(SECRET, BODY, VALID)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    expect(await verifyGitHubSignature(SECRET, "Hello, World?", VALID)).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    expect(await verifyGitHubSignature("wrong-secret", BODY, VALID)).toBe(false);
  });

  it("rejects malformed / unprefixed / empty signatures", async () => {
    const bareHex = VALID.replace("sha256=", "");
    expect(await verifyGitHubSignature(SECRET, BODY, bareHex)).toBe(false); // missing "sha256=" prefix
    expect(await verifyGitHubSignature(SECRET, BODY, "")).toBe(false);
    expect(await verifyGitHubSignature(SECRET, BODY, "sha256=deadbeef")).toBe(false);
  });

  // NOTE: verifyGitHubSignature compares with `===` (not constant-time) — tracked as
  // #167. These tests pin the functional contract (accept valid / reject invalid),
  // which holds regardless of the timing-safety fix; the timing property itself is
  // not unit-observable.
});
