/**
 * Client ID Metadata Document (CIMD) checks layered over
 * @cloudflare/workers-oauth-provider (issue #299).
 *
 * The library fetches the document, caps its size and compares its client_id.
 * What it leaves open is closed here: the client_id URL shape of draft-ietf-
 * oauth-client-id-metadata-document-02 section 3, a bound on the whole fetch
 * (its timer stops at the response headers), and the document fields MCP
 * 2026-07-28 client-registration requires. See docs/0-requirements.md.
 */

/** Where this Worker serves the bridge's own metadata document. */
export const CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/** The bridge callback listener binds 127.0.0.1 only, on an ephemeral port. */
const BRIDGE_REDIRECT_URI = "http://127.0.0.1/callback";

const MAX_CLIENT_ID_URL_LENGTH = 2048;

/** Longer than the library's own 10 s header timeout, so that one fires first. */
const CLIENT_METADATA_DEADLINE_MS = 15_000;

const SPECIAL_USE_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "invalid",
  "test",
  "example",
  "onion",
  "alt",
];

/** Same predicate as the library's isClientMetadataUrl: these ids trigger its fetch. */
export function isClientMetadataUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && url.pathname !== "/";
  } catch {
    return false;
  }
}

/**
 * Whether a URL-form client_id may be fetched at all. Checked on the raw string
 * where the URL parser would normalize the violation away.
 */
export function isFetchableClientIdUrl(clientId: string): boolean {
  if (clientId.length > MAX_CLIENT_ID_URL_LENGTH) return false;
  // Whitespace, control characters and backslashes get rewritten by the parser.
  if (/[\s\u0000-\u001f\u007f\\]/.test(clientId)) return false;
  if (clientId.includes("#")) return false;
  // A dot segment disappears on parsing, percent-encoded forms included.
  const rawPath = clientId.replace(/^[^/]*\/\/[^/?#]*/, "").split("?")[0];
  if (rawPath.split("/").some((segment) => /^(\.|%2e){1,2}$/i.test(segment))) return false;

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.pathname === "/") return false;
  if (url.username !== "" || url.password !== "" || clientId.includes("@")) return false;
  // Only the default port: anything else turns this endpoint into a port probe.
  if (url.port !== "") return false;

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return false;
  if (!host.includes(".")) return false;
  return !SPECIAL_USE_SUFFIXES.some((name) => host === name || host.endsWith(`.${name}`));
}

/** The document of this Worker's own bridge; `origin` is the served origin. */
export function buildBridgeClientMetadata(origin: string) {
  return {
    client_id: `${origin}${CLIENT_METADATA_PATH}`,
    client_name: "github-rag-mcp-cli",
    redirect_uris: [BRIDGE_REDIRECT_URI],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export function handleClientMetadata(request: Request): Response {
  return Response.json(buildBridgeClientMetadata(new URL(request.url).origin), {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}

/**
 * Bound work that may read a client-supplied document. The library's own timer
 * is cleared once headers arrive, so a server dripping a body under the size cap
 * would otherwise hold the request open. An abandoned read dies with the request.
 */
export async function withClientMetadataDeadline<T>(
  work: Promise<T>,
  deadlineMs: number = CLIENT_METADATA_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Client ID Metadata Document deadline exceeded")), deadlineMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The fields a resolved document has to carry for this server's only flow. */
export function isUsableMetadataClient(client: {
  clientName?: string;
  tokenEndpointAuthMethod?: string;
  grantTypes?: string[];
  responseTypes?: string[];
} | null): boolean {
  return (
    client !== null &&
    typeof client.clientName === "string" &&
    client.clientName.length > 0 &&
    // The library accepts private_key_jwt in a document but cannot verify it at
    // the token endpoint: such a client would be sent to log in, then refused.
    client.tokenEndpointAuthMethod === "none" &&
    (client.grantTypes ?? []).includes("authorization_code") &&
    (client.responseTypes ?? []).includes("code")
  );
}

/** The same answer for every cause, so this endpoint cannot be used as a probe. */
export function clientMetadataError(status: 400 | 401): Response {
  return Response.json(
    {
      error: "invalid_client",
      error_description: "Client ID Metadata Document could not be resolved or is invalid",
    },
    { status },
  );
}

/** client_id of a token endpoint request, read the way the library reads it. */
export async function tokenRequestClientId(request: Request): Promise<string> {
  const header = request.headers.get("Authorization");
  try {
    if (header?.startsWith("Basic ")) {
      return decodeURIComponent(atob(header.slice(6)).split(":", 2)[0]);
    }
    const contentType = request.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/x-www-form-urlencoded")) return "";
    // Joined: the library turns a repeated client_id into an array, and an array
    // reaches its URL check and its fetch stringified this same way.
    return (await request.clone().formData()).getAll("client_id").join(",");
  } catch {
    return "";
  }
}
