/**
 * Literal-token query detection for the search-mode `hint` field (issue #251).
 *
 * A query made of one literal token — `#N`, a bare number, or a hex SHA
 * fragment — is answered best by the sparse ranker alone: the dense side has no
 * representation of the token and brings in neighbours that do not contain it.
 * Under the default `rrf` fusion those neighbours share the result set with the
 * exact match, and a caller can read past the right row. The response therefore
 * carries a hint pointing at `fusion: "sparse_only"`; results, ranks and scores
 * are left exactly as they are.
 *
 * Precision over recall: the hint must not appear on a natural-language query,
 * so only the whole trimmed query is tested, and a hex fragment must contain at
 * least one digit — a 7+ letter word spelled only with a-f ("defaced",
 * "effaced") is not taken for a SHA.
 */

const LITERAL_QUERY = /^(?:#\d+|\d+|(?=[0-9a-f]*\d)[0-9a-f]{7,40})$/i;

/** True when the whole (trimmed) query is a single `#N`, digit-only, or 7-40 char hex token. */
export function isLiteralQuery(query: string): boolean {
  return LITERAL_QUERY.test(query.trim());
}

export type LiteralQueryHint = {
  reason: "literal_query";
  suggest: { fusion: "sparse_only" };
  message: string;
};

/**
 * Hint for a search-mode response, or undefined when none applies. Only an
 * omitted `fusion` qualifies: a caller that named a fusion mode chose it.
 */
export function literalQueryHint(query: string, fusionExplicit: boolean): LiteralQueryHint | undefined {
  if (fusionExplicit || !isLiteralQuery(query)) return undefined;
  return {
    reason: "literal_query",
    suggest: { fusion: "sparse_only" },
    message:
      "The query is a single literal token (#N, a number, or a hex SHA fragment). " +
      "Default rrf fusion also ranks dense-side neighbours that do not contain it; " +
      "repeat the call with fusion: \"sparse_only\" to rank exact matches alone.",
  };
}
