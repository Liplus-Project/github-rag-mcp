/**
 * Return true only when a cached Dynamic Client Registration can be reused for
 * every redirect URI requested by the current OAuth callback listener.
 */
export function supportsRedirectUris(registration, redirectUris) {
  if (
    registration === null ||
    typeof registration !== "object" ||
    typeof registration.client_id !== "string" ||
    registration.client_id.length === 0 ||
    !Array.isArray(registration.redirect_uris)
  ) {
    return false;
  }

  const registeredUris = new Set(
    registration.redirect_uris.filter((uri) => typeof uri === "string"),
  );

  return redirectUris.every((uri) => registeredUris.has(uri));
}
