import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuthProvider, OAuthPendingError } from "../server/oauth.js";

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function harness(t, options = {}) {
  const tokenDir = await mkdtemp(join(tmpdir(), "rag-oauth-test-"));
  const servers = [];
  const browsers = [];
  let refreshes = 0;
  let exchanges = 0;
  const metadata = {
    authorization_endpoint: "https://oauth.test/authorize",
    token_endpoint: "https://oauth.test/token",
    registration_endpoint: "https://oauth.test/register",
  };
  const provider = createOAuthProvider({
    workerUrl: "https://oauth.test", tokenDir,
    initialWaitMs: 5, pendingWaitMs: 5, callbackTimeoutMs: 2000,
    createCallbackServer: () => {
      const server = createServer(); servers.push(server); return server;
    },
    openBrowser: url => { browsers.push(new URL(url)); },
    fetch: async (url, init) => {
      if (options.remote && (url instanceof Request ? url.url : String(url)).endsWith("/mcp")) return options.remote(url, init);
      if (url.endsWith("/.well-known/oauth-authorization-server")) return Response.json(metadata);
      if (url === metadata.registration_endpoint) {
        if (options.registrationFails) return new Response("sensitive registration detail", { status: 400 });
        return Response.json({ client_id: "synthetic-client", redirect_uris: JSON.parse(init.body).redirect_uris });
      }
      assert.equal(url, metadata.token_endpoint);
      if (init.body.get("grant_type") === "refresh_token") {
        refreshes++;
        return options.refresh ? await options.refresh(init) : new Response("sensitive refresh detail", { status: 400 });
      }
      exchanges++;
      return options.exchange ? await options.exchange(init) : Response.json({ access_token: "synthetic-new", refresh_token: "synthetic-refresh", expires_in: 3600 });
    },
    ...options.provider,
  });
  t.after(async () => {
    for (const server of servers) {
      server.emit("error", new Error("test cleanup"));
      server.closeAllConnections();
      server.close();
    }
    await rm(tokenDir, { recursive: true, force: true });
  });
  const tokenFile = join(tokenDir, "oauth-tokens.json");
  async function save(tokens) { await writeFile(tokenFile, JSON.stringify(tokens)); }
  async function callback(params = {}, browser = browsers.at(-1)) {
    const url = new URL(browser.searchParams.get("redirect_uri"));
    url.searchParams.set("state", browser.searchParams.get("state"));
    url.searchParams.set("code", "synthetic-code");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return await fetch(url);
  }
  return { provider, browsers, servers, tokenDir, tokenFile, save, callback,
    counts: () => ({ refreshes, exchanges }) };
}

test("failed refresh followed by delayed authorization uses saved token on the next call", async t => {
  const h = await harness(t);
  await h.save({ access_token: "synthetic-old", refresh_token: "synthetic-stale-refresh", expires_at: 1 });
  await writeFile(join(h.tokenDir, "oauth-client.json"), JSON.stringify({ client_id: "synthetic-client" }));
  await assert.rejects(h.provider.token(), OAuthPendingError);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  assert.equal(h.browsers.length, 1);
  const response = await h.callback();
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authorization successful/);
  assert.equal(await h.provider.token(), "synthetic-new");
  assert.equal(h.browsers.length, 1);
  assert.deepEqual(h.counts(), { refreshes: 1, exchanges: 1 });
});

test("valid existing credentials and another process's file update are used without a browser", async t => {
  const h = await harness(t);
  await h.save({ access_token: "synthetic-existing" });
  assert.equal(await h.provider.token(), "synthetic-existing");
  await h.save({ access_token: "synthetic-other-process" });
  assert.equal(await h.provider.token(), "synthetic-other-process");
  assert.equal(h.browsers.length, 0);
});

test("401 excludes the same disk token and accepts another process's replacement while pending", async t => {
  const h = await harness(t);
  await h.save({ access_token: "synthetic-rejected" });
  await h.provider.token();
  await assert.rejects(h.provider.onUnauthorized(), OAuthPendingError);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  assert.equal(h.browsers.length, 1);
  await h.save({ access_token: "synthetic-replacement" });
  assert.equal(await h.provider.token(), "synthetic-replacement");
  assert.equal(h.browsers.length, 1);
});

test("401 silently refreshes instead of reusing the rejected access token", async t => {
  const h = await harness(t, { refresh: () => Response.json({ access_token: "synthetic-refreshed", expires_in: 3600 }) });
  await h.save({ access_token: "synthetic-rejected", refresh_token: "synthetic-refresh" });
  await writeFile(join(h.tokenDir, "oauth-client.json"), JSON.stringify({ client_id: "synthetic-client" }));
  await h.provider.token();
  await h.provider.onUnauthorized();
  assert.equal(await h.provider.token(), "synthetic-refreshed");
  assert.equal(h.browsers.length, 0);
  assert.equal(h.counts().refreshes, 1);
});

test("refresh uses the token's issuing client even after another process changes registration", async t => {
  let usedClient;
  const h = await harness(t, { refresh: init => {
    usedClient = init.body.get("client_id");
    return Response.json({ access_token: "synthetic-refreshed", expires_in: 3600 });
  } });
  await h.save({ access_token: "synthetic-expired", refresh_token: "synthetic-refresh", client_id: "synthetic-issuing-client", expires_at: 1 });
  await writeFile(join(h.tokenDir, "oauth-client.json"), JSON.stringify({ client_id: "synthetic-other-client" }));
  assert.equal(await h.provider.token(), "synthetic-refreshed");
  assert.equal(usedClient, "synthetic-issuing-client");
  assert.equal(JSON.parse(await readFile(h.tokenFile)).client_id, "synthetic-issuing-client");
});

test("a rejected access token returned again by refresh is not adopted", async t => {
  const h = await harness(t, { refresh: () => Response.json({ access_token: "synthetic-rejected", expires_in: 3600 }) });
  await h.save({ access_token: "synthetic-rejected", refresh_token: "synthetic-refresh", client_id: "synthetic-client" });
  await h.provider.token();
  await assert.rejects(h.provider.onUnauthorized(), OAuthPendingError);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  assert.equal(h.counts().refreshes, 1);
  assert.equal(h.browsers.length, 1);
});

test("a 401 invalidates the bearer actually sent, including a final retry, without rejecting a newer token", async t => {
  const h = await harness(t, { remote: () => new Response(null, { status: 401 }) });
  await h.save({ access_token: "synthetic-request-old" });
  await h.provider.token();
  await h.save({ access_token: "synthetic-concurrent-new" });
  await h.provider.token();
  await h.provider.fetch("https://oauth.test/mcp", { headers: { Authorization: "Bearer synthetic-request-old" } });
  await h.provider.onUnauthorized({});
  assert.equal(await h.provider.token(), "synthetic-concurrent-new");
  await h.provider.fetch(new Request("https://oauth.test/mcp", { headers: { Authorization: "Bearer synthetic-concurrent-new" } }));
  await assert.rejects(h.provider.token(), OAuthPendingError);
  assert.equal(h.browsers.length, 1);
});

test("an external replacement during refresh failure is used without opening a browser", async t => {
  const h = await harness(t, { refresh: async () => {
    await h.save({ access_token: "synthetic-external" });
    return new Response("failure", { status: 400 });
  } });
  await h.save({ access_token: "synthetic-expired", refresh_token: "synthetic-refresh", expires_at: 1 });
  await writeFile(join(h.tokenDir, "oauth-client.json"), JSON.stringify({ client_id: "synthetic-client" }));
  assert.equal(await h.provider.token(), "synthetic-external");
  assert.equal(h.browsers.length, 0);
});

test("refresh does not overwrite an external replacement saved while the request was in flight", async t => {
  const h = await harness(t, { refresh: async () => {
    await h.save({ access_token: "synthetic-external" });
    return Response.json({ access_token: "synthetic-refreshed", expires_in: 3600 });
  } });
  await h.save({ access_token: "synthetic-expired", refresh_token: "synthetic-refresh", expires_at: 1 });
  await writeFile(join(h.tokenDir, "oauth-client.json"), JSON.stringify({ client_id: "synthetic-client" }));
  assert.equal(await h.provider.token(), "synthetic-external");
  assert.equal(JSON.parse(await readFile(h.tokenFile)).access_token, "synthetic-external");
});

test("concurrent calls start one browser flow and keep polling that same flow", async t => {
  const h = await harness(t);
  const results = await Promise.allSettled([h.provider.token(), h.provider.token(), h.provider.token()]);
  assert.ok(results.every(result => result.status === "rejected" && result.reason instanceof OAuthPendingError));
  assert.equal(h.browsers.length, 1);
  await h.callback();
  assert.deepEqual(await Promise.all([h.provider.token(), h.provider.token()]), ["synthetic-new", "synthetic-new"]);
});

test("browser success waits for token exchange and persisted credentials", async t => {
  const exchangeStarted = deferred();
  const exchangeResult = deferred();
  const h = await harness(t, { exchange: () => { exchangeStarted.resolve(); return exchangeResult.promise; } });
  await assert.rejects(h.provider.token(), OAuthPendingError);
  let responded = false;
  const callback = h.callback().then(res => { responded = true; return res; });
  await exchangeStarted.promise;
  assert.equal(responded, false);
  exchangeResult.resolve(Response.json({ access_token: "synthetic-new" }));
  const response = await callback;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authorization successful/);
  assert.equal(JSON.parse(await readFile(h.tokenFile)).access_token, "synthetic-new");
});

test("late token exchange failure shows failure and is observed on the next call", async t => {
  const h = await harness(t, { exchange: () => new Response("synthetic-secret-code-state", { status: 400 }) });
  await assert.rejects(h.provider.token(), OAuthPendingError);
  const response = await h.callback();
  assert.equal(response.status, 500);
  const body = await response.text();
  assert.match(body, /Authorization failed/);
  assert.doesNotMatch(body, /successful|synthetic-secret/);
  await assert.rejects(h.provider.token(), { message: "OAuth token exchange failed" });
  assert.equal(h.browsers.length, 1);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  assert.equal(h.browsers.length, 2);
});

test("storage failure does not claim success and safely reaches the next caller", async t => {
  const h = await harness(t);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  await mkdir(h.tokenFile);
  const response = await h.callback();
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /successful/);
  await assert.rejects(h.provider.token(), { message: "OAuth credential storage failed" });
});

test("a timeout after the pending caller returned is retained until observed, then retry starts a new flow", async t => {
  const h = await harness(t, { provider: { callbackTimeoutMs: 30 } });
  await assert.rejects(h.provider.token(), OAuthPendingError);
  await new Promise(resolve => setTimeout(resolve, 45));
  await assert.rejects(h.provider.token(), { message: "OAuth callback timed out after 5 minutes" });
  assert.equal(h.servers[0].listening, false);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  assert.equal(h.browsers.length, 2);
});

test("timeout during token exchange responds with failure and discards a late exchange result", async t => {
  const exchangeStarted = deferred();
  const exchangeResult = deferred();
  const h = await harness(t, { provider: { callbackTimeoutMs: 80 }, exchange: () => {
    exchangeStarted.resolve(); return exchangeResult.promise;
  } });
  await assert.rejects(h.provider.token(), OAuthPendingError);
  const callback = h.callback();
  await exchangeStarted.promise;
  const response = await callback;
  assert.equal(response.status, 504);
  assert.doesNotMatch(await response.text(), /successful/);
  exchangeResult.resolve(Response.json({ access_token: "synthetic-late" }));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(readFile(h.tokenFile), { code: "ENOENT" });
  await assert.rejects(h.provider.token(), /timed out/);
});

test("invalid state cannot complete a flow, and authorization errors are sanitized", async t => {
  const h = await harness(t);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  const invalid = await h.callback({ state: "synthetic-invalid-state" });
  assert.equal(invalid.status, 400);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  const denied = await h.callback({ error: "synthetic-sensitive-error" });
  assert.equal(denied.status, 400);
  assert.doesNotMatch(await denied.text(), /synthetic-sensitive/);
  await assert.rejects(h.provider.token(), { message: "OAuth authorization failed" });
});

test("registration setup failure closes the callback listener and allows retry", async t => {
  const h = await harness(t, { registrationFails: true });
  await assert.rejects(h.provider.token(), { message: "OAuth authorization setup failed" });
  assert.equal(h.servers[0].listening, false);
  assert.equal(h.browsers.length, 0);
  await assert.rejects(h.provider.token(), /setup failed/);
  assert.equal(h.servers[1].listening, false);
});

test("a pending listener error is retained for the next call", async t => {
  const h = await harness(t);
  await assert.rejects(h.provider.token(), OAuthPendingError);
  h.servers[0].emit("error", new Error("synthetic sensitive listener detail"));
  await assert.rejects(h.provider.token(), { message: "OAuth callback listener failed" });
  assert.equal(h.servers[0].listening, false);
});

test("a malformed token exchange cannot display or persist success", async t => {
  const h = await harness(t, { exchange: () => Response.json({ refresh_token: "synthetic-no-access" }) });
  await assert.rejects(h.provider.token(), OAuthPendingError);
  const response = await h.callback();
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /successful/);
  await assert.rejects(h.provider.token(), { message: "OAuth token exchange failed" });
  await assert.rejects(readFile(h.tokenFile), { code: "ENOENT" });
});

test("listener startup failure rejects promptly without an unhandled server error", async t => {
  const h = await harness(t, { provider: { createCallbackServer: () => {
    const server = createServer();
    server.listen = () => { queueMicrotask(() => server.emit("error", new Error("synthetic bind failure"))); return server; };
    return server;
  } } });
  await assert.rejects(h.provider.token(), { message: "OAuth authorization setup failed" });
});
