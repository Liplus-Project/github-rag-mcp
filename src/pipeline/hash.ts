/**
 * Hashing and embedding-input preparation helpers.
 *
 * Houses the SHA-256 body hashers used for change detection, the per-surface
 * input formatters (issue/PR, diff, comment), and the public URL-safe base64
 * encoder. The byte-mode base64 helper used internally by vector-id sits
 * alongside `stableVectorId` to keep its only call site local.
 */

import { MAX_EMBEDDING_INPUT_CHARS } from "./embedding.js";

/**
 * Compute SHA-256 hash of title + body for change detection.
 * Returns hex-encoded hash string.
 */
export async function computeBodyHash(title: string, body: string): Promise<string> {
  const input = title + "\n\n" + body;
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Prepare embedding input text from issue title and body.
 * Concatenates title + "\n\n" + body, truncated to MAX_EMBEDDING_INPUT_CHARS.
 */
export function prepareEmbeddingInput(title: string, body: string | null): string {
  const text = title + "\n\n" + (body ?? "");
  if (text.length <= MAX_EMBEDDING_INPUT_CHARS) return text;
  return text.slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/**
 * Encode an arbitrary string to URL-safe base64 (RFC 4648 §5) without padding.
 * Retained because `stableVectorId` uses it to encode the SHA-256 digest.
 */
export function base64UrlEncode(input: string): string {
  // Encode UTF-8 -> binary string -> base64 via btoa
  const utf8Bytes = new TextEncoder().encode(input);
  let binary = "";
  for (let i = 0; i < utf8Bytes.length; i++) {
    binary += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Compute SHA-256 over UTF-8 bytes of the wiki content. Used as the change
 * detection signal in lieu of git blob SHAs (the wiki git protocol is not
 * exposed via REST, so we hash content directly).
 */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex;
}

/**
 * Build the embedding input for a single file-in-commit.
 * Format: "{commitMessage}\n\n{filePath}\n\n{patch}", truncated to MAX_EMBEDDING_INPUT_CHARS.
 * The file path is included inline so semantic search can match against it
 * even when the patch body alone does not mention it.
 */
export function prepareDiffEmbeddingInput(
  commitMessage: string,
  filePath: string,
  patch: string,
): string {
  const text = `${commitMessage}\n\n${filePath}\n\n${patch}`;
  if (text.length <= MAX_EMBEDDING_INPUT_CHARS) return text;
  return text.slice(0, MAX_EMBEDDING_INPUT_CHARS);
}

/**
 * Build the embedding input for a comment / review body.
 * Format: "{author}\n\n{body}", truncated to MAX_EMBEDDING_INPUT_CHARS.
 * The author prefix supplies speaker context so the dense embedding can
 * distinguish the same body authored by different reviewers.
 */
export function prepareCommentEmbeddingInput(
  author: string,
  body: string,
): string {
  const text = `${author}\n\n${body}`;
  if (text.length <= MAX_EMBEDDING_INPUT_CHARS) return text;
  return text.slice(0, MAX_EMBEDDING_INPUT_CHARS);
}
