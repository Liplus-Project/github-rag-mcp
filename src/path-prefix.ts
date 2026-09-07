/** Maximum string prefix Vectorize keeps in one metadata index entry. */
export const MAX_PATH_PREFIX_UTF8_BYTES = 64;

/**
 * Validate the intentionally narrow document-directory filter contract.
 * Fetch mode skips this check because named rows ignore every metadata filter.
 */
export function validateDocPathPrefix(
  pathPrefix: string | undefined,
  type: string | undefined,
): string | null {
  if (pathPrefix === undefined) return null;
  if (type !== "doc") return 'path_prefix requires type="doc"';
  if (pathPrefix.length === 0) return "path_prefix must not be empty";
  if (pathPrefix.startsWith("/")) {
    return "path_prefix must be repository-relative and must not start with /";
  }
  if (!pathPrefix.endsWith("/")) return "path_prefix must end with /";
  if (pathPrefix.includes("\\")) return "path_prefix must use / separators";
  if (pathPrefix.includes("\0")) return "path_prefix must not contain NUL";

  const segments = pathPrefix.slice(0, -1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "path_prefix must not contain empty, . or .. path segments";
  }

  if (new TextEncoder().encode(pathPrefix).length > MAX_PATH_PREFIX_UTF8_BYTES) {
    return `path_prefix must be at most ${MAX_PATH_PREFIX_UTF8_BYTES} UTF-8 bytes`;
  }
  return null;
}

/**
 * Half-open lexical range containing exactly the strings that start with a
 * validated directory prefix. The contract requires a trailing slash, so its
 * immediate successor (`/` -> `0`) is a safe upper bound for every suffix,
 * including supplementary-plane Unicode characters.
 */
export function pathPrefixRange(pathPrefix: string): { lower: string; upper: string } {
  return {
    lower: pathPrefix,
    upper: `${pathPrefix.slice(0, -1)}0`,
  };
}
