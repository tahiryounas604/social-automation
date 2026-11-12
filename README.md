# social-automation

Schedule and publish social media posts — X, LinkedIn, Instagram, TikTok —
from a local SQLite queue, with a worker loop, per-post analytics, and a
fully working mock provider for demos and tests.

Part of the [Tytechlabs](https://www.linkedin.com/in/tahiryounas604)
open-source line. Open-core: this core is free (GPL-3.0); a hosted/pro
version may follow later.

## Features

- **Post queue (SQLite)** — add, list, reschedule, cancel, retry. Persists
  in one file (`~/.social-automation/social-automation.db` by default).
  Uses Node 24's built-in `node:sqlite` — zero runtime dependencies.
- **Scheduling** — `run-once` publishes every due post; `worker` runs the
  loop on an interval (default 60s). Published posts are never re-run;
  a failed post keeps its error on the row and can be retried.
- **Provider abstraction** — one `Provider` interface. Real clients for
  **X**, **LinkedIn**, **Instagram**, and **TikTok**, plus a **mock**
  provider that writes published posts to a local outbox log
  (`outbox.jsonl`) — used by the tests and the demo below.
- **Validation** — per-provider text limits (X 280, LinkedIn 3000,
  Instagram/TikTok 2200) and the media requirement for Instagram/TikTok
  are enforced when a post is queued, not at publish time.
- **Analytics** — import engagement metrics as JSON, get a summary report
  (totals, per-provider breakdown, average engagement, engagement rate,
  best post). Text or JSON output.

## Install

Requires **Node.js 24+** (the queue uses the built-in `node:sqlite`).

```bash
git clone https://github.com/tahiryounas604/social-automation.git
cd social-automation
npm install
npm run build
```

No runtime dependencies — only TypeScript (dev) is installed.

## Usage

```bash
# Queue a post for X (due immediately)
npm start -- add --provider x --text "Hello from social-automation"

# Queue a post for a future time
npm start -- add --provider mock --text "Demo post" --at 2026-11-12T18:00:00Z

# See what's queued
npm start -- list
npm start -- list --status queued --provider x
npm start -- list --json

# Move / cancel / retry
npm start -- schedule <id> --at 2026-11-13T09:00:00Z
npm start -- cancel <id>
npm start -- retry <id>

# Publish everything that's due right now (exit 2 if any post fails)
npm start -- run-once

# Run the worker loop (publishes due posts every 60s, Ctrl+C to stop)
npm start -- worker
npm start -- worker --interval-ms 30000

# Analytics: import metrics, then report
npm start -- metrics import --file examples/metrics.json
npm start -- report
npm start -- report --json

# Which providers exist
npm start -- providers
```

Or use the installed binary directly after `npm link`: `social-automation …`.

### Demo (no credentials needed)

```bash
npm start -- add --provider mock --text "My first scheduled post"
npm start -- run-once
cat ~/.social-automation/outbox.jsonl   # the "published" post, as JSON
npm start -- report
```

### Metrics file format

```json
[
  {
    "postId": "<id from list>",
    "provider": "x",
    "likes": 42,
    "comments": 3,
    "shares": 5,
    "views": 1200,
    "collectedAt": "2026-11-12T05:00:00.000Z"
  }
]
```

An example file lives at `examples/metrics.json`. Importing the same
`postId` again replaces the previous snapshot (latest wins).

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SOCIAL_AUTOMATION_DIR` | `~/.social-automation` | Directory for the DB + outbox |
| `SOCIAL_AUTOMATION_DB` | `$DIR/social-automation.db` | SQLite database path |
| `SOCIAL_AUTOMATION_OUTBOX` | `$DIR/outbox.jsonl` | Mock provider outbox log |

## Provider setup

Real providers need **your own** API credentials — none are in this repo,
and none are ever logged. Set the variables below, then queue posts with
that provider and run `run-once` / `worker`.

### X

1. Create an app at <https://developer.x.com> with write permission
   (`tweet.write` scope).
2. Generate a bearer / OAuth 2.0 user token.
3. `export X_BEARER_TOKEN="…"`

Client: `POST https://api.x.com/2/tweets`.

### LinkedIn

1. Create an app at <https://www.linkedin.com/developers> and request
   **Share on LinkedIn** (`w_member_social` scope).
2. Complete OAuth and note your access token and your person URN
   (`urn:li:person:…` — from `GET /v2/userinfo` `sub` is not the URN;
   use the URN shown in the developer portal / `userinfo` response).
3. `export LINKEDIN_ACCESS_TOKEN="…"` and `export LINKEDIN_AUTHOR_URN="urn:li:person:…"`

Client: `POST https://api.linkedin.com/v2/ugcPosts`.

### Instagram

1. Set up the Instagram Graph API at
   <https://developers.facebook.com> (Business/Creator account, connected
   Facebook Page).
2. Get a long-lived user access token and your Instagram account id.
3. `export INSTAGRAM_ACCESS_TOKEN="…"` and `export INSTAGRAM_ACCOUNT_ID="…"`

Client: two-step — `POST /{ig-user-id}/media` then
`POST /{ig-user-id}/media_publish`. **Text-only posts are not supported
by the Graph API** — every Instagram post needs a public `mediaUrl`.

### TikTok

1. Create an app at <https://developers.tiktok.com> with the
   **Content Posting API** (`video.upload` scope) and complete Login Kit
   OAuth.
2. `export TIKTOK_ACCESS_TOKEN="…"`
   (optional: `TIKTOK_PRIVACY_LEVEL=SELF_ONLY` for private test posts;
   default `PUBLIC_TO_EVERYONE`).
3. Queue posts with a public video URL as `--media-url`.

Client: `POST https://open.tiktokapis.com/v2/post/publish/video/init/`
(pull-from-URL source). TikTok then encodes/publishes the video; the
returned `publish_id` is stored as the post's external id.

## Library use

```ts
import { QueueStore, Scheduler, defaultResolver, summarizeStore } from "social-automation";

const store = new QueueStore("./social.db");
store.add({ provider: "mock", text: "Hello", scheduledAt: new Date().toISOString() });
const scheduler = new Scheduler(store, { resolveProvider: defaultResolver("./outbox.jsonl") });
console.log(await scheduler.runOnce());
console.log(summarizeStore(store));
```

## Development

```bash
npm test          # node:test, runs on the TypeScript source directly
npm run build     # tsc -> dist/
npm run test:built  # build, then run the tests against the compiled output
```

## Known limits (honest)

- **Live posting NOT tested.** The X, LinkedIn, Instagram, and TikTok
  clients are real code paths (correct endpoints, auth, payloads) and
  their request shapes are verified in tests with stubbed HTTP — but no
  live post has ever been published from this repo, because it holds no
  credentials. Verify with a test account and `TIKTOK_PRIVACY_LEVEL=SELF_ONLY`
  before trusting a real provider end to end.
- **Analytics are manual.** Metrics are imported from JSON you supply
  (exported from each platform, or mock data). v0.1 does not call any
  platform's analytics API.
- **No media upload.** Instagram/TikTok need a *public URL* for the media;
  v0.1 does not upload files to any platform.
- **No retries with backoff.** A failed post stays failed until you
  `retry` it; the worker does not re-attempt failures automatically.
- **Single-machine queue.** SQLite is local; there is no multi-user,
  multi-process locking beyond SQLite itself.
- **TikTok publish is asynchronous.** The API returns a `publish_id`
  when the upload is accepted; encoding/publishing completes on
  TikTok's side, and v0.1 does not poll its status.
- **LinkedIn** uses the `ugcPosts` API; **Instagram** uses Graph API
  v21.0. Platform APIs change — if a call starts failing, check the
  provider's current docs first.

## License

GPL-3.0 — see [LICENSE](LICENSE).

## Author

Built by Tahir Younas — Penetration Tester & Application Security Engineer — https://www.linkedin.com/in/tahiryounas604 | Tytechlabs
