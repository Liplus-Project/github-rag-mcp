/**
 * OAuth Provider configuration for GitHub App OAuth 2.1
 *
 * Integrates @cloudflare/workers-oauth-provider to handle:
 * - RFC 8414 metadata discovery (/.well-known/oauth-authorization-server)
 * - RFC 7591 dynamic client registration (/oauth/register)
 * - Authorization code flow with PKCE (S256)
 * - Token issuance and refresh (/oauth/token)
 * - GitHub App OAuth as upstream identity provider
 *
 * Pattern ported from github-webhook-mcp/worker/src/oauth.ts
 */
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** GitHub OAuth endpoints */
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_API = "https://api.github.com/user";

const USER_AGENT = "github-rag-mcp";

/**
 * Props stored with each OAuth grant (encrypted in KV).
 * Contains the GitHub identity and upstream tokens for the authenticated user.
 */
export interface GitHubUserProps {
  /** GitHub user ID (numeric, stable identifier) */
  githubUserId: number;
  /** GitHub login (username) */
  githubLogin: string;
  /** GitHub access token (ghu_ prefix, 8h TTL) */
  githubAccessToken: string;
  /** GitHub refresh token (ghr_ prefix, 6mo TTL) */
  githubRefreshToken: string;
}

/**
 * Extended environment with OAuth-specific bindings.
 * OAUTH_KV is the KV namespace used by the provider for token/client/grant storage.
 */
export interface OAuthEnv {
  OAUTH_KV: KVNamespace;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

/**
 * Handle the /oauth/authorize endpoint.
 *
 * This is the authorization endpoint referenced in OAuthProvider config.
 * It receives the parsed OAuth request from the MCP client, then redirects
 * the user to GitHub's OAuth authorize page. The state parameter carries
 * the original OAuth request so we can complete it after GitHub callback.
 */
export async function handleAuthorize(
  request: Request,
  env: OAuthEnv,
  oauthHelpers: OAuthHelpers,
): Promise<Response> {
  const authRequest = await oauthHelpers.parseAuthRequest(request);

  // Encode original OAuth request in state for the GitHub callback
  const statePayload = JSON.stringify({
    oauthRequest: authRequest,
  });
  const state = btoa(statePayload);

  const githubAuthUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubAuthUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  // Redirect back to our /oauth/callback after GitHub auth
  const callbackUrl = new URL("/oauth/callback", request.url).toString();
  githubAuthUrl.searchParams.set("redirect_uri", callbackUrl);
  githubAuthUrl.searchParams.set("state", state);
  // GitHub App OAuth: scope is empty (fine-grained permissions via App settings)

  return Response.redirect(githubAuthUrl.toString(), 302);
}

/**
 * Handle the /oauth/callback endpoint.
 *
 * GitHub redirects here after the user authorizes. We exchange the code
 * for GitHub tokens, fetch the user profile, then complete the original
 * OAuth authorization by issuing our own authorization code.
 */
export async function handleGitHubCallback(
  request: Request,
  env: OAuthEnv,
  oauthHelpers: OAuthHelpers,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return new Response("Missing code or state", { status: 400 });
  }

  // Decode the original OAuth request from state
  let stateData: { oauthRequest: Awaited<ReturnType<OAuthHelpers["parseAuthRequest"]>> };
  try {
    stateData = JSON.parse(atob(state));
  } catch {
    return new Response("Invalid state parameter", { status: 400 });
  }

  // Exchange GitHub code for tokens
  const tokenRes = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    return new Response(
      `GitHub token exchange failed: ${tokenData.error_description || tokenData.error}`,
      { status: 400 },
    );
  }

  // Fetch GitHub user profile
  const userRes = await fetch(GITHUB_USER_API, {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
    },
  });

  if (!userRes.ok) {
    return new Response("Failed to fetch GitHub user profile", { status: 502 });
  }

  const user = (await userRes.json()) as { id: number; login: string };

  // Complete the original OAuth authorization with our provider
  const props: GitHubUserProps = {
    githubUserId: user.id,
    githubLogin: user.login,
    githubAccessToken: tokenData.access_token,
    githubRefreshToken: tokenData.refresh_token || "",
  };

  const { redirectTo } = await oauthHelpers.completeAuthorization({
    request: stateData.oauthRequest,
    userId: String(user.id),
    metadata: {
      label: `GitHub: ${user.login}`,
    },
    scope: stateData.oauthRequest.scope,
    props,
  });

  return Response.redirect(redirectTo, 302);
}

/**
 * Create the OAuthProvider instance.
 *
 * The provider wraps the existing Worker default handler, adding OAuth
 * endpoints and protecting API routes. Non-OAuth routes pass through
 * to the defaultHandler.
 *
 * @param defaultHandler - The existing Worker fetch handler to wrap
 */
export function createOAuthProvider(
  defaultHandler: ExportedHandler<OAuthEnv & Record<string, unknown>>,
): OAuthProvider<OAuthEnv & Record<string, unknown>> {
  return new OAuthProvider<OAuthEnv & Record<string, unknown>>({
    // API routes protected by OAuth access tokens
    apiRoute: ["/mcp"],

    // The existing Worker handler serves as both apiHandler and defaultHandler
    apiHandler: defaultHandler as ExportedHandler<OAuthEnv & Record<string, unknown>> &
      Pick<Required<ExportedHandler<OAuthEnv & Record<string, unknown>>>, "fetch">,
    defaultHandler,

    // OAuth endpoints
    authorizeEndpoint: "/oauth/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",

    // Token TTLs matching GitHub App token lifetimes
    // Access token: 1 hour (GitHub's ghu_ is 8h, but shorter is safer)
    accessTokenTTL: 3600,
    // Refresh token: 30 days (GitHub's ghr_ is 6mo)
    refreshTokenTTL: 30 * 24 * 3600,

    // PKCE: S256 only (OAuth 2.1 requirement for public clients)
    allowPlainPKCE: false,

    // Token exchange callback to propagate GitHub token refresh
    tokenExchangeCallback: async ({ grantType, props }) => {
      if (grantType === ("refresh_token" as never)) {
        // On refresh, we could re-validate GitHub tokens here in the future
        return { newProps: props };
      }
    },
  });
}
