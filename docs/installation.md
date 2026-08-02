# github-rag-mcp Installation Guide

Language: English | [Japanese](installation.ja.md)

## Prerequisites

- Cloudflare account
- GitHub account with access to the target repositories
- Node.js 18+
- npm
- Wrangler CLI

Install Wrangler if needed:

```bash
npm install -g wrangler
```

## 1. Clone and install dependencies

```bash
git clone https://github.com/Liplus-Project/github-rag-mcp.git
cd github-rag-mcp
npm install
```

## 2. Log in to Cloudflare

```bash
wrangler login
```

## 3. Create Cloudflare resources

### 3.1 Vectorize index

```bash
wrangler vectorize create github-rag-issues --dimensions 1024 --metric cosine
```

### 3.2 Metadata indexes

Create metadata indexes before relying on structured filters.

```bash
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name repo
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name type
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name state
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name milestone
# Expanded label/assignee fields (stored for future Vectorize OR-filter support)
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_0
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_1
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_2
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name label_3
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name assignee_0
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name assignee_1
```

### 3.3 KV namespace

```bash
wrangler kv namespace create OAUTH_KV
```

Update `wrangler.toml` with the returned namespace ID.

### 3.4 D1 database (FTS5 sparse side of hybrid retrieval)

Create a D1 database for the BM25 / FTS5 sparse index.

```bash
wrangler d1 create github-rag-fts
```

Update `wrangler.toml` with the returned `database_id`:

```toml
[[d1_databases]]
binding = "DB_FTS"
database_name = "github-rag-fts"
database_id = "<paste-the-id-here>"
migrations_dir = "migrations"
```

Apply the initial migration (creates `search_docs` + the two FTS5 virtual tables):

```bash
wrangler d1 migrations apply github-rag-fts
```

For the first deploy against a brand-new D1 database, also run the same command with `--remote`:

```bash
wrangler d1 migrations apply github-rag-fts --remote
```

## 4. Create the GitHub App

Create a GitHub App for OAuth and repository access.

Recommended settings:

| Field | Value |
|---|---|
| Homepage URL | `https://<your-worker>.workers.dev` |
| Callback URL | `https://<your-worker>.workers.dev/oauth/callback` |
| Webhook URL | `https://<your-worker>.workers.dev/webhooks/github` |
| Webhook active | enabled |

Recommended repository permissions:

- Issues: read
- Pull requests: read
- Checks: read
- Commit statuses: read
- Contents: read
- Metadata: read

Subscribe to these events:

- Issues
- Pull requests
- Push
- Release

Install the app on the repositories you want to track.

## 5. Configure secrets

Set these secrets in Cloudflare:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_TOKEN`
- `GITHUB_WEBHOOK_SECRET`

Example:

```bash
echo "<client-id>" | wrangler secret put GITHUB_CLIENT_ID
echo "<client-secret>" | wrangler secret put GITHUB_CLIENT_SECRET
echo "<github-token>" | wrangler secret put GITHUB_TOKEN
echo "<webhook-secret>" | wrangler secret put GITHUB_WEBHOOK_SECRET
```

## 6. Configure variables

Set `POLL_REPOS` to a comma-separated list of repositories.

Example:

```toml
[vars]
POLL_REPOS = "owner/repo1,owner/repo2"
```

## 7. Deploy the worker

```bash
wrangler deploy
```

## 8. Verify the deployment

Check the following:

- OAuth callback works
- webhook deliveries return success
- cron runs appear in Cloudflare logs
- the MCP endpoint is reachable

Recommended verification flow:

1. Open the worker URL and complete OAuth.
2. Edit an issue in a tracked repository.
3. Confirm a webhook delivery reaches the worker.
4. Confirm the record appears in search results.

## 9. Re-index if metadata filtering was added later

If metadata indexes were created after vectors already existed, reset stored hashes so the next cron run re-embeds everything.

Admin endpoint:

```text
POST /admin/reset-hashes?repo=owner/repo
```

Authentication:

- send the same `GITHUB_TOKEN` value in the `GITHUB_TOKEN` header

## 10. Replay a commit-diff period (gap backfill)

If commit diffs are missing for a period — an older poller version dropped them, or a commit keeps failing and holds the watermark — rewind the diff poller watermark. The next `:30` cron re-covers the period from `since`, walking it oldest-first without skipping.

Admin endpoint:

```text
POST /admin/diff-watermark?repo=owner/repo&since=2026-07-06T00:00:00Z
```

Parameters:

- `repo` — `owner/repo`, must be listed in `POLL_REPOS`
- `since` — any parseable timestamp; stored as the watermark the next run resumes from
- `phase` — `forward` (default) rewinds `diffs:{repo}`; `backfill` moves `diffs_backfill:{repo}` (used to release a stalled historical walk)

Authentication:

- send the same `GITHUB_TOKEN` value in the `GITHUB_TOKEN` header

Operational notes:

- catch-up rate is 5 commits per repo per cron run (~120 commits/day at the hourly `:30` trigger), so a multi-week gap takes several days to drain
- new commits are unaffected while a replay is in flight: the webhook path indexes them in real time
- upserts are idempotent on `(repo, commit_sha, file_path)`, so re-covering an already-indexed period is safe
- verify progress with the `{repo} diffs: forward [...]` line in the worker logs, or by searching `type: "diff"` for the period

## 11. Re-segment the full-text index after applying migration 0006

Migration `0006_fts5_segmented_nat_index.sql` adds the `content_fts` column and seeds it with a copy of the raw content. The actual word segmentation only exists in JavaScript (`Intl.Segmenter`), so rows indexed before the migration stay unsegmented until this endpoint walks them. Until it finishes, Japanese phrase queries keep returning zero sparse candidates for those rows.

Run it once after applying the migration. Rows indexed after the deploy are already segmented by the ingest path.

Order the upgrade as **apply migration → deploy the worker → run this backfill**. Between the migration and the deploy, the still-running previous version writes no `content_fts`, so rows it indexes in that window land in the v3 index as empty text; the backfill rewrites them from the raw `content`, so the window heals itself. The reverse order does not work: a worker deployed before the migration hits `no such column: content_fts` on every upsert.

Admin endpoint:

```text
POST /admin/backfill-fts-segments
```

Parameters:

- `repo` — optional `owner/repo` filter; omit to walk every repository
- `cursor` — `rowid` to resume from (default `0`); pass back the `nextCursor` of the previous response
- `limit` — rows per call, `1..200` (default `50`)

Authentication:

- send the same `GITHUB_TOKEN` value in the `GITHUB_TOKEN` header

Response:

```json
{ "repo": null, "cursor": 0, "limit": 50, "scanned": 50, "updated": 41, "nextCursor": 812, "done": false }
```

Operational notes:

- call it repeatedly, feeding `nextCursor` back in, until `done` is `true`
- safe to restart from `cursor=0` at any point: a row whose segmentation already matches is skipped without a write, so a re-run of a finished backfill reports `updated: 0`
- each call issues at most two D1 operations, so an interrupted run never leaves a half-written batch
- verify with a Japanese phrase query in `fusion: "sparse_only"` mode — `sparse_candidates` should be non-zero

## 12. Index a wiki without waiting for the cron

The `:45` wiki cron walks a bounded number of pages per run and resumes from a stored cursor, so a deep wiki reaches full coverage in ceil(pages / 20) hours. Use this endpoint when that is too slow — a freshly connected repository, a bulk wiki import, or a coverage repair after a poller fix.

Admin endpoint:

```text
POST /admin/backfill-wiki?repo=owner/repo
```

Parameters:

- `repo` — `owner/repo`, must be listed in `POLL_REPOS`
- `limit` — raw-content fetch attempts per call, `1..40` (default `20`)
- `cursor` — page slug to resume after; omit to continue from the stored cursor, or pass empty (`cursor=`) to restart from the head of the enumeration (which restarts the lap there too)

Authentication:

- send the same `GITHUB_TOKEN` value in the `GITHUB_TOKEN` header

Response:

```json
{ "repo": "owner/repo", "pages": 77, "fetches": 20, "visited": 20, "embedded": 18,
  "skipped": 2, "failed": 0, "removed": 3, "orphansDeferred": 5, "orphansWithheld": 0,
  "startCursor": "", "nextCursor": "current-architecture-as-concession",
  "lapAnchor": "", "wrapped": false, "enumerated": true, "done": false }
```

Operational notes:

- call it repeatedly until `done` is `true`; it shares the cron's cursor, so the two advance one another rather than fighting
- `done` (= `wrapped`) means the cursor completed a lap of the enumeration, not that one call covered every page. A wiki with more `pages` than `limit` cannot finish in one call; the lap closes after `ceil(pages / limit)` calls — 4 for a 77-page wiki at the default `limit=20` (issue #188)
- `lapAnchor` is the slug the current lap started after (`""` = the head of the enumeration). The lap runs from the page after the anchor around to the anchor itself, so `lapAnchor` plus `nextCursor` shows how far the lap has come
- `enumerated: false` means the `/wiki/_pages` scrape failed — nothing was indexed and, deliberately, nothing was reaped; retry rather than treating it as an empty wiki
- `orphansDeferred` counts reap candidates the call never reached, because it hit either the per-run delete cap or the per-run probe cap; keep calling until it reaches 0. A candidate that was reached and withheld is reported by `orphansWithheld`, not here — the two budgets are separate so a withheld candidate cannot spend a delete slot and stall the real deletions ordering behind it (issue #197)
- `fetches` may exceed `limit` by up to 3 on a call whose *first* page needs more candidates than the budget allows. Probing a page is up to 4 attempts (two filename candidates x `md` / `markdown`), and a probe cut short mid-list is not an observed result, so the walk would otherwise re-probe that page on every call without ever moving the cursor. The first page of each call is therefore allowed to finish its candidate list; every page after it stops at the budget (issue #192)
- `orphansWithheld` counts reap candidates whose content still served (or whose existence probe could not conclude), so the delete was withheld. Non-zero means the `_pages` scrape came back **short of the live wiki** — the pages themselves are intact and were protected, but the enumeration is what to investigate; the worker log names each withheld page (issue #187)
- verify coverage by comparing `search_docs` rows (`type = 'wiki_doc'`) against the page list at `https://github.com/{repo}/wiki/_pages`

## 13. Purge pre-migration doc vectors (one-off)

Vector IDs moved from plain text (`{repo}#doc-{path}`) to a hashed scheme in April 2026. Every delete path computes the *current* ID, so doc vectors written before that migration can never be named again: they stay in Vectorize, answer dense queries with their pre-migration content, and take a candidate slot away from the live row for the same file. Deleting the file does not help — the reap removes the current-generation row and leaves the legacy one (issue #204).

Run this once per repository indexed before the migration. It deletes only IDs it rebuilds in the legacy format, and re-embeds nothing.

Admin endpoint:

```text
POST /admin/purge-legacy-vectors?repo=owner/repo
```

Parameters:

- `repo` — `owner/repo`
- `dry_run` — `true` reports the counts and calls Vectorize not at all
- `surface` — `doc` (default), the only value accepted. The migration changed every surface's ID, but doc is the only surface where orphans have actually been measured
- `limit` — IDs per call, `1..2000` (default `500`)
- `cursor` — offset to resume from; pass back the `nextCursor` of the previous response

Body (optional):

```json
{ "paths": [".claude/CLAUDE.md", ".claude/rules/model/absolute.md"] }
```

Paths already deleted from the repository. Their legacy IDs cannot be enumerated from anything the worker still holds, so they have to be named explicitly. Candidates from `paths` are covered before the tree, so a capped run reaches them first.

Authentication:

- send the same `GITHUB_TOKEN` value in the `GITHUB_TOKEN` header

Response:

```json
{ "repo": "owner/repo", "surface": "doc", "dryRun": false, "candidates": 512,
  "skippedOversize": 3, "treeTruncated": false, "cursor": 0, "limit": 500,
  "targeted": 500, "deleted": 500, "remaining": 12, "nextCursor": 500, "done": false }
```

Operational notes:

- call it repeatedly, feeding `nextCursor` back in, until `done` is `true`. `remaining` is the count the per-run cap left behind. Send the same `paths` body on every call of a walk: the cursor indexes an ordered list that starts with them, so dropping them shifts every later position
- safe to repeat: deleting an absent ID is a no-op, so a re-run of a finished purge reports the same `candidates` and changes nothing. If a call fails mid-walk, resume from the same `cursor`
- `skippedOversize` counts legacy IDs longer than Vectorize's 64-byte ID cap. Those were rejected at upsert time — that overflow is what forced the migration — so no vector is keyed to them and they are not sent
- `treeTruncated: true` means the Git Trees API cut its listing short, so the tree half of the candidate set is partial. The explicit `paths` half is unaffected
- current-generation vectors are never at risk: the two ID formats are disjoint (`{repo}#doc-…` vs `d:…`) and only rebuilt legacy IDs are passed to the delete call
- the residue is closed, not growing — the legacy scheme stopped writing at the migration — so this endpoint is a one-off per repository, not a recurring job
- verify by searching for a file that was double-indexed: the pre-migration copy (old content, dense-only) should stop appearing

## Troubleshooting

### `GITHUB_TOKEN not configured`

The worker secret is missing or misconfigured.

### `POLL_REPOS not configured`

The plain-text variable is missing.

### GitHub API 401 or 403

The token is expired or missing required scopes.

### OAuth callback fails

The GitHub App callback URL does not exactly match the worker callback URL.

### Webhook verification fails

`GITHUB_WEBHOOK_SECRET` does not match the value configured in the GitHub App.
