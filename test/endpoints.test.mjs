/**
 * Endpoint-level tests: webhook ingestion, the public JSON endpoints, CORS,
 * caching, error handling and secret redaction.
 *
 * Everything runs in-process against an in-memory KV; no network, no
 * credentials, no real Telegram API.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { onRequestPost as webhookPost, onRequestGet as webhookGet } from "../functions/telegram/webhook.js";
import { onRequestGet as postsGet, onRequestOptions as postsOptions } from "../functions/posts.json.js";
import { onRequestGet as latestGet } from "../functions/latest.json.js";
import { onRequestGet as indexGet } from "../functions/index.js";
import { redact, resolveOrigin } from "../functions/_lib/http.js";

import {
  CHANNEL_ID,
  FAKE_TOKEN,
  editedUpdate,
  getRequest,
  makeEnv,
  photoUpdate,
  textUpdate,
  webhookRequest,
} from "./helpers.mjs";

async function post(env, update, opts) {
  return webhookPost({ request: webhookRequest(update, opts), env });
}

async function readFeed(env) {
  const res = await postsGet({ request: getRequest("/posts.json"), env });
  return { res, body: await res.json() };
}

// --- webhook ingestion -----------------------------------------------------

test("stores a text post and serves it from /posts.json", async () => {
  const env = makeEnv();
  const res = await post(env, textUpdate(1, 10, 1700000000, "hello"));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, stored: true });

  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 1);
  assert.equal(body.posts[0].text, "hello");
  assert.equal(body.posts[0].url, "https://t.me/chfless/10");
  assert.equal(body.latest.id, 10);
  assert.equal(body.channel.id, CHANNEL_ID);
  assert.equal(body.channel.url, "https://t.me/chfless");
});

test("stores a photo post with its caption and media metadata", async () => {
  const env = makeEnv();
  await post(env, photoUpdate(1, 11, 1700000100, "a caption"));

  const { body } = await readFeed(env);
  assert.equal(body.posts[0].type, "photo");
  assert.equal(body.posts[0].text, "a caption");
  assert.equal(body.posts[0].media.file_id, "large");
  assert.equal(body.posts[0].media.width, 1280);
});

test("an edited post updates in place without duplicating", async () => {
  const env = makeEnv();
  await post(env, textUpdate(1, 10, 1700000000, "typo"));
  await post(env, editedUpdate(2, 10, 1700000000, 1700000300, "fixed"));

  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 1);
  assert.equal(body.posts[0].text, "fixed");
  assert.equal(body.posts[0].edited_at, "2023-11-14T22:18:20Z");
});

test("duplicate webhook deliveries are idempotent and skip the KV write", async () => {
  const env = makeEnv();
  const update = textUpdate(1, 10, 1700000000, "hello");

  await post(env, update);
  const writesAfterFirst = env.FEED.writes;

  const res = await post(env, update); // Telegram retry
  assert.deepEqual(await res.json(), { ok: true, stored: false });
  assert.equal(env.FEED.writes, writesAfterFirst, "no redundant KV write");

  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 1);
});

test("rejects a foreign channel reusing the @chfless username", async () => {
  const env = makeEnv();
  const spoof = textUpdate(1, 10, 1700000000, "impersonation");
  spoof.channel_post.chat.id = -1009999999999; // different numeric id
  assert.equal(spoof.channel_post.chat.username, "chfless"); // same username

  const res = await post(env, spoof);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, stored: false });

  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 0, "spoofed post must never enter the feed");
});

test("ignores unsupported update types and non-channel chats", async () => {
  const env = makeEnv();
  await post(env, { update_id: 1, message: { message_id: 1, text: "dm" } });
  await post(env, { update_id: 2, poll: { id: "x" } });

  const group = textUpdate(3, 12, 1700000000, "group");
  group.channel_post.chat.type = "supergroup";
  await post(env, group);

  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 0);
});

test("malformed JSON body is rejected with 400 and not retried", async () => {
  const env = makeEnv();
  const res = await post(env, "{not json");
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /not valid JSON/);
});

test("malformed update shapes never crash the handler", async () => {
  const env = makeEnv();
  const shapes = [null, [], 42, "text", { channel_post: null }, { channel_post: { chat: null } }];
  for (const payload of shapes) {
    // Pre-serialize so each shape is transmitted as valid JSON; parsing itself
    // is covered by the malformed-body test above.
    const res = await post(env, JSON.stringify(payload));
    assert.equal(res.status, 200, `payload ${JSON.stringify(payload)} should be acknowledged`);
  }
  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 0);
});

test("retention limit is enforced across separate webhook calls", async () => {
  const env = makeEnv({ POST_LIMIT: "3" });
  for (let i = 1; i <= 5; i += 1) {
    await post(env, textUpdate(i, i, 1700000000 + i, `p${i}`));
  }
  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 3);
  assert.deepEqual(body.posts.map((p) => p.id), [3, 4, 5]);
  assert.equal(body.latest.id, 5);
});

// --- webhook authentication ------------------------------------------------

test("webhook rejects a wrong or missing secret token", async () => {
  const env = makeEnv();
  const bad = await post(env, textUpdate(1, 10, 1700000000, "x"), { secret: "wrong" });
  assert.equal(bad.status, 401);

  const missing = await post(env, textUpdate(1, 10, 1700000000, "x"), { secret: null });
  assert.equal(missing.status, 401);

  const { body } = await readFeed(env);
  assert.equal(body.posts.length, 0);
});

test("webhook rejects GET", async () => {
  const res = await webhookGet({ request: getRequest("/telegram/webhook"), env: makeEnv() });
  assert.equal(res.status, 405);
});

// --- configuration validation ----------------------------------------------

test("missing credentials fail cleanly with 500 and a non-secret message", async () => {
  const noToken = await postsGet({ request: getRequest(), env: makeEnv({ TELEGRAM_BOT_TOKEN: "" }) });
  assert.equal(noToken.status, 500);
  assert.match((await noToken.json()).error, /TELEGRAM_BOT_TOKEN is not configured/);

  const noChannel = await postsGet({ request: getRequest(), env: makeEnv({ TELEGRAM_CHANNEL_ID: "" }) });
  assert.equal(noChannel.status, 500);
  assert.match((await noChannel.json()).error, /TELEGRAM_CHANNEL_ID is not configured/);
});

test("a username as channel id is rejected", async () => {
  const res = await postsGet({ request: getRequest(), env: makeEnv({ TELEGRAM_CHANNEL_ID: "@chfless" }) });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /numeric chat id/);
});

test("storage failure degrades to 503 rather than leaking details", async () => {
  const env = makeEnv();
  env.FEED = {
    get() {
      throw new Error("KV exploded");
    },
  };
  const res = await postsGet({ request: getRequest(), env });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.match(body.error, /temporarily unavailable/);
  assert.ok(!body.error.includes("KV exploded"));
});

// --- response contract -----------------------------------------------------

test("/posts.json has correct content type, cache and security headers", async () => {
  const env = makeEnv();
  await post(env, textUpdate(1, 10, 1700000000, "hello"));
  const { res } = await readFeed(env);

  assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.match(res.headers.get("Cache-Control"), /max-age=60/);
  assert.match(res.headers.get("Cache-Control"), /stale-while-revalidate=300/);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("CORS allowlist echoes permitted origins and blocks others", async () => {
  const env = makeEnv({ ALLOWED_ORIGINS: "https://thio.qzz.io,https://www.thio.qzz.io" });

  const allowed = await postsGet({ request: getRequest("/posts.json", { origin: "https://thio.qzz.io" }), env });
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), "https://thio.qzz.io");
  assert.equal(allowed.headers.get("Vary"), "Origin");

  const denied = await postsGet({ request: getRequest("/posts.json", { origin: "https://evil.example" }), env });
  assert.notEqual(denied.headers.get("Access-Control-Allow-Origin"), "https://evil.example");
  assert.notEqual(denied.headers.get("Access-Control-Allow-Origin"), "*");
});

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const res = await postsOptions({ request: getRequest("/posts.json"), env: makeEnv() });
  assert.equal(res.status, 204);
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /GET/);
  assert.equal(res.headers.get("Access-Control-Max-Age"), "86400");
});

test("configurable cache TTL is honoured", async () => {
  const res = await postsGet({ request: getRequest(), env: makeEnv({ CACHE_TTL_SECONDS: "15" }) });
  assert.match(res.headers.get("Cache-Control"), /max-age=15/);
});

test("/latest.json exposes only the newest post", async () => {
  const env = makeEnv();
  await post(env, textUpdate(1, 10, 1700000000, "older"));
  await post(env, textUpdate(2, 11, 1700000100, "newest"));

  const res = await latestGet({ request: getRequest("/latest.json"), env });
  const body = await res.json();
  assert.equal(body.latest.text, "newest");
  assert.equal(body.posts, undefined);
  assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
});

test("/ returns API metadata without exposing the numeric channel id or token", async () => {
  const env = makeEnv();
  await post(env, textUpdate(1, 10, 1700000000, "hello"));

  const res = await indexGet({ request: getRequest("/"), env });
  const body = await res.json();
  assert.equal(body.schema_version, 1);
  assert.equal(body.post_count, 1);
  assert.deepEqual(body.endpoints, { posts: "/posts.json", latest: "/latest.json" });

  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(FAKE_TOKEN));
  assert.ok(!serialized.includes(String(CHANNEL_ID)));
});

test("empty feed is still valid, well-shaped JSON", async () => {
  const { res, body } = await readFeed(makeEnv());
  assert.equal(res.status, 200);
  assert.equal(body.version, 1);
  assert.deepEqual(body.posts, []);
  assert.equal(body.latest, null);
});

// --- secret redaction ------------------------------------------------------

test("redact removes the exact configured token", () => {
  const message = `request to /bot${FAKE_TOKEN}/getMe failed`;
  const safe = redact(message, FAKE_TOKEN);
  assert.ok(!safe.includes(FAKE_TOKEN));
  assert.match(safe, /\[REDACTED\]/);
});

test("redact removes token-shaped strings even without the configured token", () => {
  const leaked = "error at https://api.telegram.org/bot987654321:AAHfakefakefakefakefakefakefakefake12/getMe";
  const safe = redact(leaked, undefined);
  assert.ok(!safe.includes("AAHfakefakefakefakefakefakefakefake12"));
});

test("no response body ever contains the bot token", async () => {
  const env = makeEnv();
  await post(env, textUpdate(1, 10, 1700000000, "hello"));

  const bodies = await Promise.all([
    postsGet({ request: getRequest("/posts.json"), env }).then((r) => r.text()),
    latestGet({ request: getRequest("/latest.json"), env }).then((r) => r.text()),
    indexGet({ request: getRequest("/"), env }).then((r) => r.text()),
    postsGet({ request: getRequest(), env: makeEnv({ TELEGRAM_CHANNEL_ID: "@bad" }) }).then((r) => r.text()),
  ]);

  for (const body of bodies) {
    assert.ok(!body.includes(FAKE_TOKEN), "token leaked into a response body");
    assert.ok(!body.includes("TEST-FAKE-TOKEN"), "token fragment leaked");
  }
});

test("resolveOrigin falls back safely for unknown origins", () => {
  const request = getRequest("/posts.json", { origin: "https://evil.example" });
  assert.equal(resolveOrigin(request, "https://good.example"), "https://good.example");
  assert.equal(resolveOrigin(request, "*"), "*");
  assert.equal(resolveOrigin(request, ""), "*");
});
