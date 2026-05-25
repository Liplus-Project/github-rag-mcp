/**
 * Ingest filters shared by the webhook + poller paths.
 *
 * Centralises the noise-floor predicates that decide whether a freshly
 * arrived comment / review body is worth embedding (bot author, body length).
 */

/**
 * Minimum trimmed body length for comment / review ingest.
 * Filters out "LGTM", "+1", emoji-only reactions, etc.
 */
export const MIN_COMMENT_BODY_CHARS = 10;

/**
 * Returns true when the login looks like a GitHub App / bot account.
 *
 * Bot accounts end in the `[bot]` suffix on the sender.login field. We
 * filter them out because bot-authored comments (CI notes, dependabot
 * summaries, auto-merge status) add noise without judgment history.
 */
export function isBotSender(login: string | null | undefined): boolean {
  if (!login) return false;
  return /\[bot\]$/.test(login);
}

/**
 * Returns true when the body is too short (or empty) to carry judgment
 * history. Trim first so whitespace-only payloads count as empty.
 */
export function isBodyTooShort(body: string | null | undefined): boolean {
  if (!body) return true;
  return body.trim().length < MIN_COMMENT_BODY_CHARS;
}
