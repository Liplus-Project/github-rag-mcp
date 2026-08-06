/**
 * Types for `remote-client.js`.
 *
 * Hand-written because the bridge is plain JavaScript while the repository's
 * `tsc --noEmit` gate covers `src/`, and `src/mcp-stateless-contract.test.ts`
 * imports this module to assert the Worker <-> bridge protocol contract. The
 * surface is three functions; keep this file in step when it changes.
 */

import type { Client } from "@modelcontextprotocol/client";

export declare const WORKER_PROTOCOL_VERSION: "2026-07-28";

export interface RemoteClientOptions {
  /** Worker origin; `/mcp` is appended. */
  workerUrl: string;
  /** Reported as this client's version. */
  clientVersion: string;
  /** Bearer credentials, per the SDK's `AuthProvider` shape. */
  authProvider?: {
    token(): Promise<string | undefined>;
    onUnauthorized?(): Promise<void>;
  };
  /** Fetch override; tests route it at an in-process handler. */
  fetch?: typeof fetch;
}

export interface RemoteClient {
  /** Connect on first use, then reuse. */
  getClient(): Promise<Client>;
  /** Call a Worker tool, dropping the cached client on failure. */
  callTool(name: string, args: unknown): Promise<unknown>;
  /** Forget the cached client. The next call reconnects. */
  reset(): Promise<void>;
}

export declare function createRemoteClient(options: RemoteClientOptions): RemoteClient;
