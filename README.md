
<div align="center">
<img width="576" height="252" alt="image" src="https://github.com/user-attachments/assets/e608becd-b141-428f-afa4-14fe0c514996" />

# Telegram Channel to ~~JSON~~ API

A read-only public JSON API for a Telegram channel, running entirely on **Cloudflare Pages Functions**.

</div>

```
Telegram Channel (@chfless)
        │  channel_post / edited_channel_post
        ▼
Official Telegram Bot API
        │  webhook push (HTTPS, secret-token authenticated)
        ▼
Cloudflare Pages Function ──► Workers KV (feed JSON + Discord markers)
        │                              │
        │                              ▼
        │                       GET /posts.json   GET /latest.json   GET /
        │                              │
        │                              ▼
        │                       your website's fetch()
        │
        └─► Discord Incoming Webhook ──► your Discord channel
            (best-effort fan-out, same Function, no second bot)
```

No GitHub Actions. No server. No database. No dashboard, login, or frontend framework. The bot token and the Discord webhook URL live only in Cloudflare and never reach a browser.

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
  - [8. Forward to Discord (optional)](#8-forward-to-discord-optional)
- [Discord forwarding](#discord-forwarding)
- [Consuming the feed](#consuming-the-feed)
- [Local development](#local-development)
- [The optional Go collector](#the-optional-go-collector)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Why this architecture

**Webhook, not `getUpdates`.** `getUpdates` is a *destructive queue* with a cursor: whatever you read is acknowledged and gone. Cloudflare's runtime is stateless and handles requests concurrently, so polling from a Function would need a persisted offset, and two overlapping invocations could drain each other's updates and lose posts permanently. With a webhook, Telegram pushes each update to us and retries on any non-2xx response. **There is no cursor to store at all.** Duplicate deliveries are made harmless by deduplicating on Telegram's message ID, which makes the whole endpoint idempotent.

**Workers KV, not a database.** Cloudflare isolates are ephemeral - a module-level array is *not* storage and would silently lose posts between requests, colocations, and deploys. The feed therefore lives in a single KV key holding one small JSON document. That is the simplest Cloudflare-native persistence that exists; no D1, Neon, or ORM is involved.

**Pages Functions, not a Worker + separate static site.** One project serves the JSON and deploys straight from Git, so `/posts.json` and any future static asset share a domain and need no cross-origin plumbing.

**Discord fan-out, not a second bot.** After a post is validated and persisted, the *same* Function invocation forwards it to Discord through an Incoming Webhook (`?wait=true`). There is no polling loop, no second bot, no GitHub Action, and no database - just one extra HTTPS call inside `/telegram/webhook`, isolated so a Discord outage can never break the JSON feed (see [Discord forwarding](#discord-forwarding)).

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /posts.json` | The full feed - channel metadata plus the latest ~20 posts |
| `GET /latest.json` | Channel metadata plus only the newest post |
| `GET /` | API metadata: schema version, post count, endpoint list |
| `POST /telegram/webhook` | Telegram-only ingestion endpoint, authenticated by a secret token. Persists to KV, then best-effort fan-out to Discord |

All read endpoints send:

- `Content-Type: application/json; charset=utf-8`
- `Cache-Control: public, max-age=60, s-maxage=60, stale-while-revalidate=300` - fast and cheap, but never permanently stale
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
| `posts[].id` | Telegram `message_id` - stable, used for deduplication |
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
  telegram/webhook.js         POST /telegram/webhook (+ Discord fan-out)
  _lib/
    normalize.js              Telegram message -> public schema (port of the Go logic)
    ingest.js                 Update filtering / channel-ID enforcement
    store.js                  KV-backed feed persistence
    telegram.js               Minimal Bot API client (getMe, getFile, file download)
    discord.js                Discord webhook fan-out (embeds, photo upload, markers)
    http.js                   CORS, caching, security headers, secret redaction
    config.js                 Env validation
public/                       Static assets served by Pages
scripts/set-webhook.mjs       One-off webhook registration helper
test/                         Node test-runner suite (no network, no credentials)
  discord.test.mjs            Mocked Discord + Telegram servers for fan-out tests
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

Use that `id`, including the `-100` prefix. The service accepts posts **only** from this exact numeric ID - a username is never trusted, because usernames can be released and re-registered by someone else.

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

Functions in `functions/` are picked up automatically. Every push to the branch redeploys - no GitHub Actions involved.

### 6. Configure variables and secrets

**Settings → Variables and Secrets.** Add these for both **Production** and **Preview**:

| Name | Type | Value |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | **Secret** (encrypted) | Your BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | **Secret** (encrypted) | `openssl rand -hex 32` |
| `DISCORD_WEBHOOK_URL` | **Secret** (encrypted) | Your Discord Incoming Webhook URL (see [step 8](#8-forward-to-discord-optional); leave unset for feed-only mode) |
| `TELEGRAM_CHANNEL_ID` | Plaintext variable | `-1001234567890` |
| `TELEGRAM_CHANNEL_USERNAME` | Plaintext variable | `chfless` |
| `POST_LIMIT` | Plaintext variable | `20` |
| `CACHE_TTL_SECONDS` | Plaintext variable | `60` |
| `ALLOWED_ORIGINS` | Plaintext variable | `https://thio.qzz.io` or `*` |
| `DISCORD_ENABLED` | Plaintext variable | `true` (set to `false` to pause Discord forwarding) |

Also bind the KV namespace: **Settings → Bindings → KV namespace**, variable name `FEED`.

> Use **Secret** (not plaintext) for the credentials - Cloudflare then encrypts them and hides them from the dashboard and logs. Never put the token or the Discord webhook URL in GitHub, `wrangler.toml`, or any committed file.

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

### 8. Forward to Discord (optional)

Each new channel post can also be mirrored to a Discord channel. This reuses the Telegram webhook above - there is nothing extra to deploy.

1. **Create a Discord Incoming Webhook.** In Discord: Server Settings → **Integrations** → **Webhooks** → **New Webhook** (or Channel Settings → **Integrations** → **Webhooks** → **New Webhook**). Pick the target channel, optionally set the name and avatar, then **Copy Webhook URL**. It looks like `https://discord.com/api/webhooks/<id>/<token>` - treat the whole URL as a secret.
2. **Store it in Cloudflare.** Dashboard → **Workers & Pages** → your project → **Settings** → **Variables and Secrets** → add `DISCORD_WEBHOOK_URL` as a **Secret** (encrypted), for both **Production** and **Preview**. Then redeploy (variable changes need a new deployment to take effect).
3. **Enable/disable.** `DISCORD_ENABLED=true` (the default in `wrangler.toml`) forwards whenever the secret is set. Set it to `false` to pause Discord delivery without deleting the secret; leaving the secret unset disables forwarding entirely (feed-only mode, safe for local dev).

Never commit the webhook URL to GitHub - not in `wrangler.toml`, `.env`, docs, or fixtures. `.env.example` carries an empty placeholder only.

## Discord forwarding

How the Telegram → Cloudflare → JSON + Discord flow works, per webhook call:

1. Telegram pushes `channel_post` / `edited_channel_post` to `POST /telegram/webhook`.
2. The Function validates the webhook secret and the exact numeric `TELEGRAM_CHANNEL_ID` (usernames are never trusted), normalizes the post, and persists it to Workers KV (`/posts.json`, `/latest.json`, `/` are unchanged).
3. The same invocation fans out to Discord via `context.waitUntil()`, so Telegram is acknowledged immediately:
   - **Text posts** become a clean embed: channel title as the webhook username, original text as the description, a `t.me` link back, `Telegram message #<id>` in the footer, and the publish timestamp. No raw JSON is ever dumped.
   - **Photo posts** resolve the largest rendition via `getFile`, download it server-side (other sizes are never fetched), and upload it as a webhook attachment with the caption preserved. The Telegram token only appears in server-side Telegram URLs and is redacted from all logs and Discord traffic. Oversized or failed downloads degrade to a caption-only embed.
   - **Video / document / other** posts send a caption-style embed with a type label and the `t.me` link (media bytes are not re-uploaded).
4. Discord delivery is **best-effort and idempotent**: one lightweight KV marker per Telegram message id (`discord:<channelId>:<messageId>`) stores the Discord message id returned with `?wait=true`. Duplicate Telegram deliveries find the marker and skip Discord, so retries never duplicate messages. A Discord outage is logged (redacted, no secrets) and the webhook still returns `200` to Telegram, because the feed is already persisted.
5. **Edits** PATCH the original Discord message in place using the stored id. Fallbacks (all bounded, never uncontrolled duplicates): an edit with no marker (original predates the integration) is posted once as a new message; a PATCH that hits `404` (Discord message manually deleted) reposts once; duplicate edit deliveries PATCH at most once. Edits can never corrupt the JSON feed - the feed merge is unchanged.

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
    li.append(new Date(post.published_at).toLocaleDateString(), " - ", link);
    list.append(li);
  }
</script>
```

Only need the newest post? Fetch `/latest.json` and read `feed.latest`.

## Local development

```bash
npm install

# Run the tests - no network, no credentials, mocked Telegram + Discord APIs
npm test

# Serve the Functions locally on http://127.0.0.1:8788
npm run dev
```

Discord forwarding is inert locally until you set a `DISCORD_WEBHOOK_URL` in `.dev.vars` - with it empty, the webhook behaves exactly as the feed-only version. The test suite (`test/discord.test.mjs`) covers text/photo forwarding, captions, Discord outages, duplicate-delivery idempotency, secret redaction, invalid config, and edit PATCHing against local mock servers, so the real Discord API is never touched.

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

Deploy manually (optional - Git pushes deploy automatically):

```bash
npm run deploy
```

## The optional Go collector

`cmd/` and `internal/` still contain the original Go collector. It is **not part of the Cloudflare deployment** and nothing depends on it. It remains useful if you ever want to snapshot the feed to a local file, run the collector on your own hardware, or work offline.

It uses `getUpdates` with a cursor in `data/state.json`, which is the correct approach for a long-lived single process but the wrong one for a stateless Worker - hence the webhook design above.

```bash
go test ./...
go build -o bin/collector ./cmd/collector
TELEGRAM_BOT_TOKEN=... TELEGRAM_CHANNEL_ID=-1001234567890 ./bin/collector
```

`internal/normalize` and `functions/_lib/normalize.js` implement the **same** public schema; `test/parity.test.mjs` pins the shared output shape so the two cannot drift apart silently. Note that `getUpdates` and a webhook are mutually exclusive - running the Go collector while a webhook is registered will fail until you `npm run delete-webhook`.

If you have no use for it, delete `cmd/`, `internal/`, and `go.mod`; nothing else references them.

## Security

- The bot token is a **credential equivalent to a password**. Anyone holding it controls your bot.
- The Discord webhook URL is equally secret: anyone holding it can post to your Discord channel. Store **both only** as Cloudflare **Secrets**. Never in GitHub, never in `wrangler.toml`, never in `public/`, never in frontend JavaScript, never in docs or test fixtures.
- The browser never receives either secret: it only ever talks to Cloudflare, and Cloudflare talks to Telegram/Discord server-side. `/posts.json`, `/latest.json`, and `/` contain no secrets (covered by tests).
- Secrets are never logged, never returned in an error body, and never included in generated JSON, KV markers, or Discord payloads. Redaction covers exact matches, Telegram's token format, and Discord webhook token segments (`/api/webhooks/<id>/[REDACTED]`).
- `/telegram/webhook` requires Telegram's `X-Telegram-Bot-Api-Secret-Token` header, so nobody can inject fake posts.
- Channel identity is enforced by numeric chat ID. A different channel using the same `@chfless` username is rejected - this is covered by a test.
- `.env` and `.dev.vars` are git-ignored; only `.env.example` / `.dev.vars.example` with empty placeholders are committed.
- If the bot token ever leaks, revoke it immediately with `/revoke` in BotFather and update the Cloudflare secret. If the Discord webhook URL leaks, regenerate it in Discord (Webhook Settings → **Regenerate**) and update the Cloudflare secret.

## Troubleshooting

**`/posts.json` returns `{"posts": []}`**
- No posts have arrived yet. The feed only fills from the moment the webhook was registered - publish a new post.
- The bot is not a channel administrator.
- The webhook is not registered: check `getWebhookInfo`.

**`getWebhookInfo` shows a `last_error_message`**
- `Wrong response from the webhook: 401 Unauthorized` - `TELEGRAM_WEBHOOK_SECRET` in Cloudflare doesn't match the one used at registration. Re-run `npm run setup-webhook` with matching values.
- `500` - usually a missing variable or an unbound `FEED` KV namespace. Check the Function logs in the Cloudflare dashboard.

**Posts reach Telegram but not the feed**
- `TELEGRAM_CHANNEL_ID` doesn't match `chat.id` exactly (the `-100` prefix is required). Mismatched posts are intentionally, silently ignored.

**`{"error":"TELEGRAM_CHANNEL_ID must be a numeric chat id..."}`**
- You configured `@chfless`. Use the numeric ID from [step 3](#3-find-the-numeric-channel-id).

**`{"error":"TELEGRAM_BOT_TOKEN is not configured"}`**
- The secret is missing in this environment. Pages keeps **Production** and **Preview** variables separate - set both, then redeploy (variable changes need a new deployment to take effect).

**`Conflict: can't use getUpdates method while webhook is active`**
- Expected: you're running the Go collector while the webhook is live. Run `npm run delete-webhook` first.

**CORS error in the browser**
- Add your site's exact origin (scheme + host, no trailing slash) to `ALLOWED_ORIGINS`, or set it to `*`. Redeploy afterwards.

**Feed looks stale for up to a minute**
- That's `CACHE_TTL_SECONDS` (default 60) doing its job. Lower it if you want, at the cost of more Function invocations.

**Posts reach the feed but not Discord**
- `DISCORD_WEBHOOK_URL` is missing or invalid in this environment (Production and Preview are separate - set both, then redeploy). An invalid URL or `DISCORD_ENABLED=false` disables forwarding silently by design; the feed is unaffected. Check Function logs for a redacted `[discord]` line.
- The webhook was deleted or regenerated in Discord: copy the fresh URL into the Cloudflare secret.
- Photo posts appear as caption-only embeds: the Telegram download failed or exceeded ~10 MiB. Text and the `t.me` link are still delivered.

**Duplicate Discord messages**
- Should not happen: one KV marker per Telegram message id suppresses re-posts on Telegram retries (covered by tests). If you see duplicates, check for a second webhook/bot posting to the same Discord channel, or two Cloudflare deployments sharing one Discord webhook.

**Edited Telegram posts don't update Discord**
- Edits PATCH the original Discord message via its stored id. If the Discord message was manually deleted, the next edit reposts it once. Posts that predate the Discord integration post once on their first edit.

## License

GPL-3.0 - see [LICENSE](LICENSE).
