/**
 * The bridge's client face toward the Cloudflare Worker.
 *
 * Split out of index.js for the same reason tools.js was: index.js connects the
 * stdio transport at import time, so nothing in it can be exercised by a test.
 * This module has no side effects on import, which lets the Worker <-> bridge
 * protocol contract be asserted directly (see
 * `src/mcp-stateless-contract.test.ts` in the repository root project).
 *
 * Protocol revision 2026-07-28, pinned (issue #224). The Worker serves that one
 * revision and rejects every other, so negotiation would only add a round trip
 * and a fallback branch that can never succeed. Pinning also means there is no
 * `initialize` handshake and no `mcp-session-id`: each request carries the
 * per-request `_meta` envelope the revision requires, and the SDK client
 * attaches it.
 *
 * There is no session to hold. What is cached here is the client object and its
 * transport, not server state — a dropped connection costs a reconnect, never a
 * lost session.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

/** The single protocol revision the Worker serves. */
export const WORKER_PROTOCOL_VERSION = "2026-07-28";

/**
 * Build a lazily-connecting MCP client for the Worker.
 *
 * @param {object} options
 * @param {string} options.workerUrl        Worker origin; `/mcp` is appended.
 * @param {string} options.clientVersion    Reported as this client's version.
 * @param {object} [options.authProvider]   Bearer credentials, per the SDK's
 *   `AuthProvider` shape (`token()` plus optional `onUnauthorized()`).
 * @param {typeof fetch} [options.fetch]    Fetch override; tests route it at an
 *   in-process handler instead of the network.
 */
export function createRemoteClient({ workerUrl, clientVersion, authProvider, fetch }) {
  let client = null;
  let connecting = null;

  async function getClient() {
    if (client) return client;

    // Concurrent tool calls must share one connect attempt, not race two.
    connecting ??= (async () => {
      const next = new Client(
        { name: "github-rag-mcp-bridge", version: clientVersion },
        { versionNegotiation: { mode: { pin: WORKER_PROTOCOL_VERSION } } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(`${workerUrl}/mcp`), {
        ...(authProvider ? { authProvider } : {}),
        ...(fetch ? { fetch } : {}),
      });
      await next.connect(transport);
      client = next;
      return next;
    })();

    try {
      return await connecting;
    } catch (err) {
      // Let the next call retry from scratch rather than inherit the failure.
      connecting = null;
      throw err;
    }
  }

  /** Forget the cached client. The next call reconnects. */
  async function reset() {
    const stale = client;
    client = null;
    connecting = null;
    if (stale) await stale.close().catch(() => {});
  }

  async function callTool(name, args) {
    const active = await getClient();
    try {
      return await active.callTool({ name, arguments: args });
    } catch (err) {
      // A dead transport would otherwise be cached forever. Dropping it costs
      // one reconnect on the next call; keeping it costs every later call.
      await reset();
      throw err;
    }
  }

  return { getClient, callTool, reset };
}
