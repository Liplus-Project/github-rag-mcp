import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { exec } from "node:child_process";
import { supportsRedirectUris } from "./oauth-client-registration.js";

export class OAuthPendingError extends Error {
  constructor() {
    super("OAuth authentication required");
  }
}

function openBrowser(url) {
  const command = process.platform === "win32" ? 'start ""' :
    process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${command} "${url}"`);
  process.stderr.write("\n[github-rag-mcp] Opening browser for authentication...\n");
}

// Injected paths and browser/fetch functions keep tests away from real credentials.
export function createOAuthProvider({
  workerUrl,
  tokenDir = join(homedir(), ".github-rag-mcp"),
  fetch: request = globalThis.fetch,
  openBrowser: launchBrowser = openBrowser,
  createCallbackServer = createServer,
  now = Date.now,
  callbackTimeoutMs = 5 * 60 * 1000,
  initialWaitMs = 3000,
  pendingWaitMs = 2000,
}) {
  const tokenFile = join(tokenDir, "oauth-tokens.json");
  const clientFile = join(tokenDir, "oauth-client.json");
  const rejectedAccess = new Set();
  const rejectedRefresh = new Set();
  let pending = null;
  let starting = null;
  let acquiring = null;
  let lastIssued = null;

  async function readJson(path) {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch { return null; }
  }

  async function saveJson(path, data) {
    const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
    try {
      await mkdir(tokenDir, { recursive: true });
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    } catch {
      throw new Error("OAuth credential storage failed");
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async function discover() {
    try {
      const res = await request(`${workerUrl}/.well-known/oauth-authorization-server`);
      if (!res.ok) throw new Error();
      return await res.json();
    } catch { throw new Error("OAuth discovery failed"); }
  }

  async function register(metadata, redirectUris) {
    const existing = await readJson(clientFile);
    if (supportsRedirectUris(existing, redirectUris)) return existing;
    if (!metadata.registration_endpoint) {
      throw new Error("OAuth server does not support dynamic client registration");
    }
    let registration;
    try {
      const res = await request(metadata.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "github-rag-mcp-cli", redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"], token_endpoint_auth_method: "none",
        }),
      });
      if (!res.ok) throw new Error();
      registration = await res.json();
      if (!registration.client_id) throw new Error();
    } catch { throw new Error("OAuth client registration failed"); }
    await saveJson(clientFile, registration);
    return registration;
  }

  function tokensFrom(data, refreshToken, clientId) {
    if (typeof data.access_token !== "string" || !data.access_token) {
      throw new Error("OAuth token response has no access token");
    }
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      client_id: clientId,
      expires_at: data.expires_in ? now() + data.expires_in * 1000 : undefined,
    };
  }

  async function startFlow() {
    const metadata = await discover();
    const server = createCallbackServer();
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = server.address().port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const client = await register(metadata, [redirectUri, `http://localhost:${port}/callback`]);
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(16).toString("hex");
      const authUrl = new URL(metadata.authorization_endpoint);
      for (const [key, value] of Object.entries({
        response_type: "code", client_id: client.client_id, redirect_uri: redirectUri,
        state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
      })) authUrl.searchParams.set(key, value);

      let settle;
      const flow = { result: null, promise: new Promise(resolve => { settle = resolve; }) };
      pending = flow;
      const controller = new AbortController();
      let processing = false;
      let response = null;
      function page(res, status, title) {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<html><body><h1>${title}</h1><p>You can close this tab.</p></body></html>`);
      }
      function finish(result) {
        if (flow.result) return;
        flow.result = result;
        clearTimeout(timeout);
        controller.abort();
        server.close();
        settle(result); // Outcomes resolve: late failure cannot become an unhandled rejection.
      }
      const timeout = setTimeout(() => {
        if (response) page(response, 504, "Authorization timed out");
        finish({ error: new Error("OAuth callback timed out after 5 minutes") });
      }, callbackTimeoutMs);
      server.on("error", () => {
        if (response && !flow.result) page(response, 500, "Authorization failed");
        finish({ error: new Error("OAuth callback listener failed") });
      });
      server.on("request", async (req, res) => {
        let url;
        try { url = new URL(req.url || "/", redirectUri); }
        catch { page(res, 400, "Invalid callback"); return; }
        if (url.pathname !== "/callback") { res.writeHead(404); res.end("Not found"); return; }
        if (url.searchParams.get("state") !== state) { page(res, 400, "Invalid callback"); return; }
        if (flow.result || processing) { page(res, 409, "Authorization already handled"); return; }
        if (url.searchParams.has("error")) {
          page(res, 400, "Authorization failed");
          finish({ error: new Error("OAuth authorization failed") });
          return;
        }
        const code = url.searchParams.get("code");
        if (!code) { page(res, 400, "Invalid callback"); return; }
        processing = true;
        response = res;
        try {
          let tokens;
          try {
            const tokenRes = await request(metadata.token_endpoint, {
              method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({ grant_type: "authorization_code", code,
                redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier }),
              signal: controller.signal,
            });
            if (!tokenRes.ok) throw new Error();
            tokens = tokensFrom(await tokenRes.json(), undefined, client.client_id);
          } catch { throw new Error("OAuth token exchange failed"); }
          if (flow.result) return;
          await saveJson(tokenFile, tokens);
          if (flow.result) return;
          page(res, 200, "Authorization successful");
          finish({ tokens });
        } catch (error) {
          if (flow.result) return;
          page(res, 500, "Authorization failed");
          finish({ error });
        }
      });
      try { launchBrowser(authUrl.toString()); }
      catch {
        finish({ error: new Error("OAuth browser launch failed") });
      }
      return flow;
    } catch {
      server.close();
      throw new Error("OAuth authorization setup failed");
    }
  }

  async function authorize() {
    const alreadyPending = Boolean(pending || starting);
    if (!pending) {
      starting ??= startFlow();
      try { await starting; } finally { starting = null; }
    }
    const flow = pending;
    let timer;
    const outcome = await Promise.race([
      flow.promise,
      new Promise(resolve => { timer = setTimeout(() => resolve(null), alreadyPending ? pendingWaitMs : initialWaitMs); }),
    ]);
    clearTimeout(timer);
    if (!outcome) throw new OAuthPendingError();
    if (pending === flow) pending = null;
    if (outcome.error) throw outcome.error;
    return outcome.tokens;
  }

  function usable(tokens) {
    return tokens && typeof tokens.access_token === "string" && tokens.access_token &&
      !rejectedAccess.has(tokens.access_token) &&
      (!tokens.expires_at || tokens.expires_at > now() + 60_000);
  }

  async function acquire() {
    let tokens = await readJson(tokenFile);
    if (usable(tokens)) {
      // A successful callback already persisted its result. Forget its completed wait.
      if (pending?.result?.tokens) pending = null;
      return tokens.access_token;
    }
    if (tokens?.refresh_token && !rejectedRefresh.has(tokens.refresh_token)) {
      const stale = tokens;
      try {
        const metadata = await discover();
        const clientId = stale.client_id || (await readJson(clientFile))?.client_id;
        if (!clientId) throw new Error();
        const res = await request(metadata.token_endpoint, {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stale.refresh_token, client_id: clientId }),
        });
        if (!res.ok) throw new Error();
        tokens = tokensFrom(await res.json(), stale.refresh_token, clientId);
        const latest = await readJson(tokenFile);
        if (latest?.access_token !== stale.access_token && usable(latest)) return latest.access_token;
        if (!usable(tokens)) throw new Error();
        await saveJson(tokenFile, tokens);
        return tokens.access_token;
      } catch {
        rejectedAccess.add(stale.access_token);
        rejectedRefresh.add(stale.refresh_token);
        const latest = await readJson(tokenFile);
        if (usable(latest)) return latest.access_token;
      }
    }
    if (tokens?.access_token) rejectedAccess.add(tokens.access_token);
    const authorized = await authorize();
    if (!usable(authorized)) throw new Error("OAuth authorization returned an unusable token");
    return authorized.access_token;
  }

  async function token() {
    acquiring ??= acquire();
    const acquisition = acquiring;
    try { lastIssued = await acquisition; return lastIssued; }
    finally { if (acquiring === acquisition) acquiring = null; }
  }

  async function onUnauthorized(context) {
    // The transport fetch records the actual request's rejected bearer, including
    // the SDK's final retry. A newer concurrently issued token must stay usable.
    if (!context && lastIssued) rejectedAccess.add(lastIssued);
    await token();
  }

  async function authenticatedFetch(input, init) {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const bearer = headers.get("authorization");
    const response = await request(input, init);
    if (response.status === 401 && bearer?.startsWith("Bearer ")) {
      rejectedAccess.add(bearer.slice(7));
    }
    return response;
  }

  return { token, onUnauthorized, fetch: authenticatedFetch };
}
