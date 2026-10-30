/**
 * OAuth wiring against the real @cloudflare/workers-oauth-provider inside workerd,
 * with the production compatibility flags (issue #299). Only the network is faked:
 * GitHub, third-party document hosts, and the path back to this Worker's own front
 * door, which `global_fetch_strictly_public` provides in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import worker from "./index.js";
import { CLIENT_METADATA_PATH } from "./client-metadata.js";

const ORIGIN = "https://rag.example.com";
const BRIDGE_CLIENT_ID = `${ORIGIN}${CLIENT_METADATA_PATH}`;
const THIRD_PARTY_ID = "https://client.example.com/oauth/metadata.json";
const VERIFIER = "synthetic-verifier-synthetic-verifier-synthetic-verifier";

let documentResponses: Map<string, () => Response>;
let outbound: string[];
let nextGitHubUser: number;

async function callWorker(input: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(input, init), env as never, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

beforeEach(() => {
  documentResponses = new Map();
  outbound = [];
  nextGitHubUser = Math.floor(Math.random() * 1e9) + 1;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    outbound.push(url);
    if (url.startsWith(`${ORIGIN}/`)) return callWorker(url);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "ghu_synthetic", refresh_token: "ghr_synthetic" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: nextGitHubUser, login: "synthetic-user" });
    }
    const document = documentResponses.get(url);
    return document ? document() : new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function codeChallenge(): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function authorize(clientId: string, redirectUri: string): Promise<Response> {
  const url = new URL(`${ORIGIN}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: "synthetic-state",
    code_challenge: await codeChallenge(),
    code_challenge_method: "S256",
  })) url.searchParams.set(key, value);
  return callWorker(url.toString());
}

/** Browser path: authorize -> GitHub -> callback -> the client's redirect URI. */
async function completeAuthorization(clientId: string, redirectUri: string): Promise<string> {
  const start = await authorize(clientId, redirectUri);
  expect(start.status).toBe(302);
  const github = new URL(start.headers.get("Location")!);
  expect(github.origin).toBe("https://github.com");
  const callback = new URL(`${ORIGIN}/oauth/callback`);
  callback.searchParams.set("code", "synthetic-github-code");
  callback.searchParams.set("state", github.searchParams.get("state")!);
  const finished = await callWorker(callback.toString());
  expect(finished.status).toBe(302);
  const landed = new URL(finished.headers.get("Location")!);
  expect(landed.origin + landed.pathname).toBe(new URL(redirectUri).origin + "/callback");
  return landed.searchParams.get("code")!;
}

async function tokenRequest(fields: Record<string, string>): Promise<Response> {
  return callWorker(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

async function exchange(clientId: string, redirectUri: string, code: string) {
  const response = await tokenRequest({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: VERIFIER,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { access_token: string; refresh_token: string };
}

async function refresh(clientId: string, refreshToken: string): Promise<Response> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
}

async function registerClient(redirectUris: string[]): Promise<string> {
  const response = await callWorker(`${ORIGIN}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "github-rag-mcp-cli",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

function serveDocument(url: string, fields: Record<string, unknown>, init?: ResponseInit): void {
  documentResponses.set(url, () => Response.json({ client_id: url, ...fields }, init));
}

const THIRD_PARTY_FIELDS = {
  client_name: "Third Party",
  redirect_uris: ["https://client.example.com/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

describe("server metadata", () => {
  it("advertises CIMD alongside the unchanged DCR endpoint", async () => {
    const response = await callWorker(`${ORIGIN}/.well-known/oauth-authorization-server`);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.client_id_metadata_document_supported).toBe(true);
    expect(metadata.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });
});

describe("the bridge's own document", () => {
  it("is served publicly, is cacheable, and names itself", async () => {
    const response = await callWorker(BRIDGE_CLIENT_ID);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(await response.json()).toMatchObject({
      client_id: BRIDGE_CLIENT_ID,
      redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    });
  });

  it("completes authorize, callback, token exchange and refresh on an ephemeral port", async () => {
    const redirectUri = "http://127.0.0.1:53412/callback";
    const code = await completeAuthorization(BRIDGE_CLIENT_ID, redirectUri);
    const tokens = await exchange(BRIDGE_CLIENT_ID, redirectUri, code);
    expect(outbound).toContain(BRIDGE_CLIENT_ID);

    const refreshed = await refresh(BRIDGE_CLIENT_ID, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { access_token: string }).access_token).toBeTruthy();
  });

  it("accepts another ephemeral port but no host the document does not declare", async () => {
    expect((await authorize(BRIDGE_CLIENT_ID, "http://127.0.0.1:61000/callback")).status).toBe(302);
    expect((await authorize(BRIDGE_CLIENT_ID, "http://localhost:61000/callback")).status).toBe(400);
    expect((await authorize(BRIDGE_CLIENT_ID, "http://127.0.0.1:61000/other")).status).toBe(400);
    expect((await authorize(BRIDGE_CLIENT_ID, "https://evil.example.com/callback")).status).toBe(400);
  });

  it("keeps a login on one machine from signing out another", async () => {
    const redirectUri = "http://127.0.0.1:53412/callback";
    const first = await exchange(BRIDGE_CLIENT_ID, redirectUri, await completeAuthorization(BRIDGE_CLIENT_ID, redirectUri));
    await exchange(BRIDGE_CLIENT_ID, redirectUri, await completeAuthorization(BRIDGE_CLIENT_ID, redirectUri));
    expect((await refresh(BRIDGE_CLIENT_ID, first.refresh_token)).status).toBe(200);
  });
});

describe("a third-party document", () => {
  it("completes the flow when the document is valid", async () => {
    serveDocument(THIRD_PARTY_ID, THIRD_PARTY_FIELDS);
    const redirectUri = "https://client.example.com/callback";
    const tokens = await exchange(THIRD_PARTY_ID, redirectUri, await completeAuthorization(THIRD_PARTY_ID, redirectUri));
    expect((await refresh(THIRD_PARTY_ID, tokens.refresh_token)).status).toBe(200);
  });

  it("requires an exact match on a non-loopback redirect URI", async () => {
    serveDocument(THIRD_PARTY_ID, THIRD_PARTY_FIELDS);
    expect((await authorize(THIRD_PARTY_ID, "https://client.example.com/callback/extra")).status).toBe(400);
  });

  it.each<[string, () => Response]>([
    ["a client_id that does not match the URL", () => Response.json({ ...THIRD_PARTY_FIELDS, client_id: "https://other.example.com/m.json" })],
    ["no client_name", () => Response.json({ ...THIRD_PARTY_FIELDS, client_id: THIRD_PARTY_ID, client_name: undefined })],
    ["no redirect_uris", () => Response.json({ ...THIRD_PARTY_FIELDS, client_id: THIRD_PARTY_ID, redirect_uris: [] })],
    ["private_key_jwt", () => Response.json({ ...THIRD_PARTY_FIELDS, client_id: THIRD_PARTY_ID, token_endpoint_auth_method: "private_key_jwt" })],
    ["client_secret_post", () => Response.json({ ...THIRD_PARTY_FIELDS, client_id: THIRD_PARTY_ID, token_endpoint_auth_method: "client_secret_post" })],
    ["no authorization_code grant", () => Response.json({ ...THIRD_PARTY_FIELDS, client_id: THIRD_PARTY_ID, grant_types: ["refresh_token"] })],
    ["a body over 5 KiB", () => Response.json({ ...THIRD_PARTY_FIELDS, client_id: THIRD_PARTY_ID, padding: "x".repeat(6000) })],
    ["a non-JSON body", () => new Response("<html></html>")],
    ["a 404", () => new Response("not found", { status: 404 })],
    ["a 500", () => new Response("error", { status: 500 })],
  ])("refuses %s with one uniform answer and no GitHub redirect", async (_name, document) => {
    documentResponses.set(THIRD_PARTY_ID, document);
    const response = await authorize(THIRD_PARTY_ID, "https://client.example.com/callback");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_client",
      error_description: "Client ID Metadata Document could not be resolved or is invalid",
    });
  });

  it("gives up on a document whose body never finishes, on both endpoints", async () => {
    // The library's own timer stops at the response headers.
    documentResponses.set(THIRD_PARTY_ID, () => new Response(new ReadableStream({ start() {} }), { status: 200 }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const authorization = authorize(THIRD_PARTY_ID, "https://client.example.com/callback");
      const token = refresh(THIRD_PARTY_ID, "a:b:c");
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await authorization).status).toBe(400);
      expect((await token).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetches no URL the document names", async () => {
    serveDocument(THIRD_PARTY_ID, {
      ...THIRD_PARTY_FIELDS,
      logo_uri: "https://logo.example.com/logo.png",
      jwks_uri: "https://jwks.example.com/keys",
    });
    await authorize(THIRD_PARTY_ID, "https://client.example.com/callback");
    expect(outbound.every((url) => url === THIRD_PARTY_ID)).toBe(true);
  });

  it.each([
    "https://user@client.example.com/metadata.json",
    "https://client.example.com/a/../metadata.json",
    "https://client.example.com/metadata.json#fragment",
    "https://client.example.com:8443/metadata.json",
    "https://192.0.2.1/metadata.json",
    "https://localhost/metadata.json",
  ])("never fetches %s", async (clientId) => {
    const authorization = await authorize(clientId, "https://client.example.com/callback");
    expect(authorization.status).toBe(400);
    const token = await refresh(clientId, "a:b:c");
    expect(token.status).toBe(401);
    expect(outbound).toEqual([]);
  });

  it("gives a token request the same refusal when the document cannot be resolved", async () => {
    const response = await refresh(THIRD_PARTY_ID, "a:b:c");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_client");
  });
});

describe("registered clients (DCR) are unchanged", () => {
  const redirectUri = "http://127.0.0.1:53412/callback";

  it("issues and refreshes through KV alone, without any document fetch", async () => {
    const clientId = await registerClient([redirectUri, "http://localhost:53412/callback"]);
    const tokens = await exchange(clientId, redirectUri, await completeAuthorization(clientId, redirectUri));
    const refreshed = await refresh(clientId, tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(outbound.filter((url) => url.includes("metadata"))).toEqual([]);
  });

  it("still revokes this user's earlier grant for the same client on re-authorization", async () => {
    const clientId = await registerClient([redirectUri]);
    const first = await exchange(clientId, redirectUri, await completeAuthorization(clientId, redirectUri));
    await exchange(clientId, redirectUri, await completeAuthorization(clientId, redirectUri));
    expect((await refresh(clientId, first.refresh_token)).status).toBe(400);
  });

  it("keeps refreshing a grant issued before the document path existed", async () => {
    const clientId = await registerClient([redirectUri]);
    const tokens = await exchange(clientId, redirectUri, await completeAuthorization(clientId, redirectUri));
    // A bridge that has moved on to the document still holds this refresh token.
    await completeAuthorization(BRIDGE_CLIENT_ID, redirectUri);
    expect((await refresh(clientId, tokens.refresh_token)).status).toBe(200);
  });

  it("keeps the library's answer for an unknown registered client_id", async () => {
    const response = await refresh("no-such-client", "a:b:c");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "invalid_client", error_description: "Client not found" });
  });
});
