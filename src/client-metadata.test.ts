import { describe, expect, it } from "vitest";
import wranglerToml from "../wrangler.toml?raw";
import {
  CLIENT_METADATA_PATH,
  buildBridgeClientMetadata,
  isClientMetadataUrl,
  isFetchableClientIdUrl,
  isUsableMetadataClient,
  tokenRequestClientId,
  withClientMetadataDeadline,
} from "./client-metadata.js";

describe("isFetchableClientIdUrl", () => {
  it.each([
    "https://client.example.com/oauth/metadata.json",
    "https://client.example.com:443/metadata.json",
    "https://sub.client.co.jp/a/b.json?v=1",
  ])("accepts %s", (url) => {
    expect(isFetchableClientIdUrl(url)).toBe(true);
  });

  it.each([
    ["a non-https scheme", "http://client.example.com/metadata.json"],
    ["no path", "https://client.example.com/"],
    ["userinfo", "https://user:pw@client.example.com/metadata.json"],
    ["userinfo without a password", "https://user@client.example.com/metadata.json"],
    ["a fragment", "https://client.example.com/metadata.json#x"],
    ["an empty fragment", "https://client.example.com/metadata.json#"],
    ["a dot segment", "https://client.example.com/a/./metadata.json"],
    ["a double-dot segment", "https://client.example.com/a/../metadata.json"],
    ["an encoded double-dot segment", "https://client.example.com/a/%2E%2e/metadata.json"],
    ["a non-default port", "https://client.example.com:8443/metadata.json"],
    ["an IPv4 literal", "https://192.0.2.1/metadata.json"],
    ["a decimal IPv4 host", "https://3221225985/metadata.json"],
    ["an IPv6 literal", "https://[::1]/metadata.json"],
    ["a single-label host", "https://intranet/metadata.json"],
    ["localhost", "https://localhost/metadata.json"],
    ["a name under localhost", "https://a.localhost/metadata.json"],
    ["a trailing-dot special-use name", "https://printer.local./metadata.json"],
    ["a home.arpa name", "https://nas.home.arpa/metadata.json"],
    ["a backslash", "https://client.example.com\\@10.0.0.1/metadata.json"],
    ["whitespace", "https://client.example.com/meta data.json"],
    ["an over-long URL", `https://client.example.com/${"a".repeat(2048)}`],
  ])("rejects %s", (_name, url) => {
    expect(isFetchableClientIdUrl(url)).toBe(false);
  });
});

describe("isClientMetadataUrl", () => {
  it("does not take a registered client_id for a document URL", () => {
    expect(isClientMetadataUrl("kXv9Qw3pZ1")).toBe(false);
    expect(isClientMetadataUrl("")).toBe(false);
    expect(isClientMetadataUrl("https://client.example.com/")).toBe(false);
    expect(isClientMetadataUrl("https://client.example.com/metadata.json")).toBe(true);
  });
});

describe("buildBridgeClientMetadata", () => {
  const origin = "https://rag.example.com";
  const document = buildBridgeClientMetadata(origin);

  it("is its own client_id and carries the fields MCP requires", () => {
    expect(document.client_id).toBe(`${origin}${CLIENT_METADATA_PATH}`);
    expect(isFetchableClientIdUrl(document.client_id)).toBe(true);
    expect(document.client_name).not.toBe("");
    expect(document.redirect_uris.length).toBeGreaterThan(0);
  });

  it("declares only the loopback address the bridge listens on, with no port", () => {
    expect(document.redirect_uris).toEqual(["http://127.0.0.1/callback"]);
  });

  it("stays within the library's 5 KiB document limit", () => {
    expect(new TextEncoder().encode(JSON.stringify(document)).length).toBeLessThan(5 * 1024);
  });
});

describe("isUsableMetadataClient", () => {
  const usable = {
    clientName: "Example",
    tokenEndpointAuthMethod: "none",
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
  };

  it("accepts a public authorization_code client", () => {
    expect(isUsableMetadataClient(usable)).toBe(true);
  });

  it.each([
    ["no client", null],
    ["no client_name", { ...usable, clientName: undefined }],
    ["an empty client_name", { ...usable, clientName: "" }],
    ["private_key_jwt", { ...usable, tokenEndpointAuthMethod: "private_key_jwt" }],
    ["no authorization_code grant", { ...usable, grantTypes: ["refresh_token"] }],
    ["no code response type", { ...usable, responseTypes: [] }],
  ])("rejects %s", (_name, client) => {
    expect(isUsableMetadataClient(client)).toBe(false);
  });
});

describe("withClientMetadataDeadline", () => {
  it("passes a result through", async () => {
    await expect(withClientMetadataDeadline(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });

  it("rejects work that outlives the deadline", async () => {
    await expect(withClientMetadataDeadline(new Promise(() => {}), 5)).rejects.toThrow(/deadline/);
  });
});

describe("tokenRequestClientId", () => {
  function tokenRequest(body: string, headers: Record<string, string> = {}): Request {
    return new Request("https://rag.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body,
    });
  }

  it("reads the form field and leaves the body for the library", async () => {
    const request = tokenRequest("grant_type=refresh_token&client_id=https%3A%2F%2Fc.example.com%2Fm.json");
    expect(await tokenRequestClientId(request)).toBe("https://c.example.com/m.json");
    expect((await request.formData()).get("grant_type")).toBe("refresh_token");
  });

  it("reads HTTP Basic the way the library does", async () => {
    const credentials = btoa(`${encodeURIComponent("https://c.example.com/m.json")}:secret`);
    const request = tokenRequest("grant_type=refresh_token", { Authorization: `Basic ${credentials}` });
    expect(await tokenRequestClientId(request)).toBe("https://c.example.com/m.json");
  });

  it("joins a repeated client_id as the library's stringified array", async () => {
    const request = tokenRequest("client_id=https%3A%2F%2Fa.example.com%2Fm&client_id=b");
    expect(await tokenRequestClientId(request)).toBe("https://a.example.com/m,b");
  });

  it("answers empty on a body the library would refuse", async () => {
    const request = new Request("https://rag.example.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(await tokenRequestClientId(request)).toBe("");
  });
});

// global_fetch_strictly_public changes where every global fetch() goes when its
// target is on the Worker's own zone. These two tests hold what that change is
// safe on: the flag is present, and no other outbound host is on that zone.
describe("the compatibility flag CIMD depends on", () => {
  it("is set in wrangler.toml, without which the library refuses every URL client_id", () => {
    const compatibilityFlags = wranglerToml.match(/^compatibility_flags = (.*)$/m)?.[1];
    expect(compatibilityFlags).toContain('"global_fetch_strictly_public"');
    expect(compatibilityFlags).toContain('"nodejs_compat"');
  });

  it("leaves the Worker's outbound calls on GitHub hosts only", () => {
    const sources = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./**/*.d.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const hosts = new Set(
      Object.values(sources).flatMap((source) =>
        [...source.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)].map((match) => match[1]),
      ),
    );
    // Neither of the other two is a global fetch() target: `store` is the
    // placeholder host of Durable Object stub requests, and 127.0.0.1 is the
    // redirect URI the bridge's metadata document declares.
    expect([...hosts].sort()).toEqual([
      "127.0.0.1",
      "api.github.com",
      "github.com",
      "raw.githubusercontent.com",
      "store",
    ]);
  });
});
