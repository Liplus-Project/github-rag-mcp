const CLIENT_METADATA_PATH = "/oauth/client-metadata.json";

/**
 * The Client ID Metadata Document URL to use as client_id, or null when the
 * authorization server does not advertise support or its issuer is not https
 * (a client_id URL must be https, so a local `wrangler dev` stays on DCR).
 */
export function metadataDocumentClientId(metadata) {
  if (metadata?.client_id_metadata_document_supported !== true) return null;
  try {
    const issuer = new URL(metadata.issuer);
    return issuer.protocol === "https:" ? `${issuer.origin}${CLIENT_METADATA_PATH}` : null;
  } catch {
    return null;
  }
}

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
