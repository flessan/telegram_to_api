# Telegram Channel to JSON

A read-only public JSON API for a Telegram channel, running entirely on **Cloudflare Pages Functions**.

```
Telegram Channel (@chfless)
        │  channel_post / edited_channel_post
        ▼
Official Telegram Bot API
        │  webhook push (HTTPS, secret-token authenticated)
        ▼
Cloudflare Pages Function  ──►  Workers KV (one small JSON key)
        │
        ▼
   GET /posts.json   GET /latest.json   GET /
        │
        ▼
   your website's fetch()
```

No GitHub Actions. No server. No database. No dashboard, login, or frontend framework. The bot token lives only in Cloudflare and never reaches a browser.

---

## Contents

- [Why this architecture](#why-this-architecture)
- [Endpoints](#endpoints)
- [JSON schema](#json-schema)
- [Repository layout](#repository-layout)
- [Setup](#setup)
  - [1. Create the bot](#1-create-the-bot)
  - [2. Add the bot to the channel](#2-add-the-bot-to-the-channel)
  - [3. Find the numeric channel ID](#3-find-the-numeric-channel-id)
  - [4. Create the KV namespace](#4-create-the-kv-namespace)
  - [5. Connect the repo to Cloudflare Pages](#5-connect-the-repo-to-cloudflare-pages)
  - [6. Configure variables and secrets](#6-configure-variables-and-secrets)
  - [7. Register the Telegram webhook](#7-register-the-telegram-webhook)
- [Consuming the feed](#consuming-the-feed)
- [Local development](#local-development)
- [The optional Go collector](#the-optional-go-collector)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why this architecture

**Webhook, not `getUpdates`.** `getUpdates` is a *destructive queue* with a cursor: whatever you read is acknowledged and gone. Cloudflare's runtime is stateless and handles requests concurrently, so polling from a Function would need a persisted offset, and two overlapping invocations could drain each other's updates and lose posts permanently. With a webhook, Telegram pushes each update to us and retries on any non-2xx response. **There is no cursor to store at all.** Duplicate deliveries are made harmless by deduplicating on Telegram's message ID, which makes the whole endpoint idempotent.

**Workers KV, not a database.** Cloudflare isolates are ephemeral — a module-level array is *not* storage and would silently lose posts between requests, colocations, and deploys. The feed therefore lives in a single KV key holding one small JSON document. That is the simplest Cloudflare-native persistence that exists; no D1, Neon, or ORM is involved.

**Pages Functions, not a Worker + separate static site.** One project serves the JSON and deploys straight from Git, so `/posts.json` and any future static asset share a domain and need no cross-origin plumbing.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /posts.json` | The full feed — channel metadata plus the latest ~20 posts |
| `GET /latest.json` | Channel metadata plus only the newest post |
| `GET /` | API metadata: schema version, post count, endpoint list |
| `POST /telegram/webhook` | Telegram-only ingestion endpoint, authenticated by a secret token |

All read endpoints send:

- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300` — fast and cheap, but never permanently stale
- CORS headers (see [`ALLOWED_ORIGINS`](#6-configure-variables-and-secrets)), with `OPTIONS` preflight returning `204`
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: cross-origin`

Errors return a JSON `{"error": "..."}` body with `Cache-Control: no-store` and an appropriate status (`400`, `401`, `405`, `500`, `503`). Error text is always scrubbed of anything token-shaped.

## JSON schema

`GET /posts.json`:

```json
{
  "version": 1,
  "channel": {
    "id": -1001234567890,
    "title": "chfless",
    "username": "chfless",
    "url": "https://t.me/chfless"
  },
  "updated_at": "2026-09-05T14:01:33Z",
  "latest": {
    "id": 11,
    "type": "photo",
    "text": "A photo caption",
    "published_at": "2023-11-14T22:23:20Z",
    "url": "https://t.me/chfless/11",
    "media": {
      "type": "photo",
      "file_id": "AgACBIG",
      "unique_id": "ubig",
      "width": 1280,
      "height": 853
    }
  },
  "posts": [
    {
      "id": 10,
      "type": "text",
      "text": "Hello from the channel",
      "published_at": "2023-11-14T22:13:20Z",
      "url": "https://t.me/chfless/10"
    },
    {
      "id": 11,
      "type": "photo",
      "text": "A photo caption",
      "published_at": "2023-11-14T22:23:20Z",
      "url": "https://t.me/chfless/11",
      "media": {
        "type": "photo",
        "file_id": "AgACBIG",
        "unique_id": "ubig",
        "width": 1280,
        "height": 853
      }
    }
  ]
}
```

| Field | Notes |
| --- | --- |
| `version` | Schema version; bumped only on breaking changes |
| `updated_at` | RFC 3339 UTC, last time the feed changed |
| `latest` | Newest retained post, or `null` when the feed is empty |
| `posts` | Oldest → newest. Always an array, never `null` |
| `posts[].id` | Telegram `message_id` — stable, used for deduplication |
| `posts[].type` | `text`, `photo`, `video`, `document`, or `other` |
| `posts[].text` | Message text, or the caption for media posts; `""` when absent |
| `posts[].published_at` | RFC 3339 UTC |
| `posts[].edited_at` | Present only on edited posts |
| `posts[].url` | `https://t.me/<username>/<id>`; `""` for channels with no username |
| `posts[].media` | Media posts only. `file_id` lets *you* resolve a download via `getFile`; it is not a secret and is useless without the token |

Raw Telegram payloads, sender objects, `update_id`s, and Bot API internals are never exposed.

## Repository layout

```
functions/                    Cloudflare Pages Functions (the deployed product)
  index.js                    GET /
  posts.json.js               GET /posts.json
  latest.json.js              GET /latest.json
  telegram/webhook.js         POST /telegram/webhook
  _lib/
    normalize.js              Telegram message -> public schema (port of the Go logic)
    ingest.js                 Update filtering / channel-ID enforcement
    store.js                  KV-backed feed persistence
    telegram.js               Minimal Bot API client (getMe)
    http.js                   CORS, caching, security headers, secret redaction
    config.js                 Env validation
public/                       Static assets served by Pages
scripts/set-webhook.mjs       One-off webhook registration helper
test/                         Node test-runner suite (no network, no credentials)
cmd/, internal/               Optional Go collector for local/self-hosted use
wrangler.toml                 Pages + KV configuration
```

There is deliberately **no `.github/workflows/` directory**; Cloudflare deploys directly from Git.

## Setup

### 1. Create the bot

Message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the prompts. He replies with a token like `123456789:AAH...`. **Keep it secret.**

### 2. Add the bot to the channel

A bot only receives `channel_post` updates for channels where it is an administrator.

Channel → **Manage Channel** → **Administrators** → **Add Administrator** → pick your bot. No special rights are needed.

### 3. Find the numeric channel ID

Post a test message in the channel, then run:

```bash
curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" | jq '.result[].channel_post.chat'
```

```json
{ "id": -1001234567890, "title": "chfless", "username": "chfless", "type": "channel" }
```

Use that `id`, including the `-100` prefix. The service accepts posts **only** from this exact numeric ID — a username is never trusted, because usernames can be released and re-registered by someone else.

### 4. Create the KV namespace

```bash
npx wrangler kv namespace create FEED
npx wrangler kv namespace create FEED --preview
```

Paste the returned IDs into `wrangler.toml` (`id` and `preview_id`). Alternatively create it in the dashboard under **Storage & Databases → KV** and bind it as `FEED` in your Pages project.

### 5. Connect the repo to Cloudflare Pages

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git** → select this repository.

Build configuration:

| Setting | Value |
| --- | --- |
| Framework preset | **None** |
| Build command | *(leave empty)* |
| Build output directory | `public` |
| Root directory | *(leave empty)* |

Functions in `functions/` are picked up automatically. Every push to the branch redeploys — no GitHub Actions involved.

### 6. Configure variables and secrets

**Settings → Variables and Secrets.** Add these for both **Production** and **Preview**:

| Name | Type | Value |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | **Secret** (encrypted) | Your BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | **Secret** (encrypted) | `openssl rand -hex 32` |
| `TELEGRAM_CHANNEL_ID` | Plaintext variable | `-1001234567890` |
| `TELEGRAM_CHANNEL_USERNAME` | Plaintext variable | `chfless` |
| `POST_LIMIT` | Plaintext variable | `20` |
| `CACHE_TTL_SECONDS` | Plaintext variable | `60` |
| `ALLOWED_ORIGINS` | Plaintext variable | `https://thio.qzz.io` or `*` |

Also bind the KV namespace: **Settings → Bindings → KV namespace**, variable name `FEED`.

> Use **Secret** (not plaintext) for the two credentials — Cloudflare then encrypts them and hides them from the dashboard and logs. Never put the token in GitHub.

`ALLOWED_ORIGINS` accepts a comma-separated allowlist. Unknown origins receive a non-matching `Access-Control-Allow-Origin`, so browsers block the read. Use `*` only if you want the feed readable from anywhere (it is public channel content, so that is often fine).

### 7. Register the Telegram webhook

Once deployed, point Telegram at your Function:

```bash
TELEGRAM_BOT_TOKEN=<your-token> \
TELEGRAM_WEBHOOK_SECRET=<same-secret-as-cloudflare> \
PUBLIC_BASE_URL=https://<your-project>.pages.dev \
npm run setup-webhook
```

This calls `setWebhook` with `allowed_updates=["channel_post","edited_channel_post"]` and `drop_pending_updates=true`. The script never prints the token.

Verify, and unregister if ever needed:

```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | jq
npm run delete-webhook
```

Now publish a post in the channel and refresh `https://<your-project>.pages.dev/posts.json`.

> **Note:** the feed contains posts received *from the moment the webhook is registered onward*. The Bot API cannot retrieve a channel's history, so this is a live collector, not an archival export.

## Consuming the feed

```js
const res = await fetch("https://your-project.pages.dev/posts.json");
if (!res.ok) throw new Error(`feed unavailable: ${res.status}`);

const feed = await res.json();

// Newest first for display
for (const post of [...feed.posts].reverse()) {
  console.log(post.published_at, post.type, post.text, post.url);
}
```

Rendering the latest few posts:

```html
<ul id="posts"></ul>
<script type="module">
  const feed = await fetch("https://your-project.pages.dev/posts.json").then((r) => r.json());
  const list = document.getElementById("posts");

  for (const post of [...feed.posts].reverse().slice(0, 5)) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = post.url;
    link.textContent = post.text || `(${post.type})`;
    li.append(new Date(post.published_at).toLocaleDateString(), " — ", link);
    list.append(li);
  }
</script>
```

Only need the newest post? Fetch `/latest.json` and read `feed.latest`.

## Local development

```bash
npm install

# Run the tests — no network, no credentials, mocked Telegram API
npm test

# Serve the Functions locally on http://127.0.0.1:8788
npm run dev
```

`npm run dev` picks up local values from `.dev.vars` (git-ignored). Start from the template:

```bash
cp .dev.vars.example .dev.vars   # then fill in placeholder values
```

You can exercise the whole pipeline without Telegram by posting an update yourself:

```bash
curl -s -X POST http://127.0.0.1:8788/telegram/webhook \
  -H 'X-Telegram-Bot-Api-Secret-Token: <your-local-secret>' \
  -H 'Content-Type: application/json' \
  -d '{"update_id":1,"channel_post":{"message_id":10,"date":1700000000,
       "chat":{"id":-1001234567890,"type":"channel","title":"chfless","username":"chfless"},
       "text":"Hello from the channel"}}'

curl -s http://127.0.0.1:8788/posts.json
```

Deploy manually (optional — Git pushes deploy automatically):

```bash
npm run deploy
```

## The optional Go collector

`cmd/` and `internal/` still contain the original Go collector. It is **not part of the Cloudflare deployment** and nothing depends on it. It remains useful if you ever want to snapshot the feed to a local file, run the collector on your own hardware, or work offline.

It uses `getUpdates` with a cursor in `data/state.json`, which is the correct approach for a long-lived single process but the wrong one for a stateless Worker — hence the webhook design above.

```bash
go test ./...
go build -o bin/collector ./cmd/collector
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHANNEL_ID=-1001234567890 ./bin/collector
```

`internal/normalize` and `functions/_lib/normalize.js` implement the **same** public schema; `test/parity.test.mjs` pins the shared output shape so the two cannot drift apart silently. Note that `getUpdates` and a webhook are mutually exclusive — running the Go collector while a webhook is registered will fail until you `npm run delete-webhook`.

If you have no use for it, delete `cmd/`, `internal/`, and `go.mod`; nothing else references them.

## Security

- The bot token is a **credential equivalent to a password**. Anyone holding it controls your bot.
- Store it **only** as a Cloudflare **Secret**. Never in GitHub, never in `wrangler.toml`, never in `public/`, never in frontend JavaScript.
- The browser never receives the token: it only ever talks to Cloudflare, and Cloudflare talks to Telegram server-side.
- The token is never logged, never returned in an error body, and never included in the generated JSON. Two layers of redaction (exact match, plus a token-shaped regex) scrub anything that slips into an error string.
- `/telegram/webhook` requires Telegram's `X-Telegram-Bot-Api-Secret-Token` header, so nobody can inject fake posts.
- Channel identity is enforced by numeric chat ID. A different channel using the same `@chfless` username is rejected — this is covered by a test.
- `.env` and `.dev.vars` are git-ignored; only `.env.example` / `.dev.vars.example` with empty placeholders are committed.
- If a token ever leaks, revoke it immediately with `/revoke` in BotFather and update the Cloudflare secret.

## Troubleshooting

**`/posts.json` returns `{"posts": []}`**
- No posts have arrived yet. The feed only fills from the moment the webhook was registered — publish a new post.
- The bot is not a channel administrator.
- The webhook is not registered: check `getWebhookInfo`.

**`getWebhookInfo` shows a `last_error_message`**
- `Wrong response from the webhook: 401 Unauthorized` — `TELEGRAM_WEBHOOK_SECRET` in Cloudflare doesn't match the one used at registration. Re-run `npm run setup-webhook` with matching values.
- `500` — usually a missing variable or an unbound `FEED` KV namespace. Check the Function logs in the Cloudflare dashboard.

**Posts reach Telegram but not the feed**
- `TELEGRAM_CHANNEL_ID` doesn't match `chat.id` exactly (the `-100` prefix is required). Mismatched posts are intentionally, silently ignored.

**`{"error":"TELEGRAM_CHANNEL_ID must be a numeric chat id..."}`**
- You configured `@chfless`. Use the numeric ID from [step 3](#3-find-the-numeric-channel-id).

**`{"error":"TELEGRAM_BOT_TOKEN is not configured"}`**
- The secret is missing in this environment. Pages keeps **Production** and **Preview** variables separate — set both, then redeploy (variable changes need a new deployment to take effect).

**`Conflict: can't use getUpdates method while webhook is active`**
- Expected: you're running the Go collector while the webhook is live. Run `npm run delete-webhook` first.

**CORS error in the browser**
- Add your site's exact origin (scheme + host, no trailing slash) to `ALLOWED_ORIGINS`, or set it to `*`. Redeploy afterwards.

**Feed looks stale for up to a minute**
- That's `CACHE_TTL_SECONDS` (default 60) doing its job. Lower it if you want, at the cost of more Function invocations.

## License

GPL-3.0 — see [LICENSE](LICENSE).
