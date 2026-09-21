/**
 * Discord fan-out tests: every new Telegram channel post is forwarded to a
 * Discord Incoming Webhook from inside the existing /telegram/webhook handler.
 *
 * All Discord and Telegram HTTP traffic goes to local mock servers; the real
 * Discord and Telegram APIs are never contacted and no real credentials exist
 * anywhere in this suite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { onRequestPost as webhookPost } from "../functions/telegram/webhook.js";
import { onRequestGet as postsGet } from "../functions/posts.json.js";
import {
  buildDiscordPayload,
  discordMarkerKey,
  getDiscordMarker,
  readDiscordConfig,
  redactDiscordUrl,
} from "../functions/_lib/discord.js";
import { redact } from "../functions/_lib/http.js";

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

// Obviously fake webhook token fragments used only for mock URLs.
const FAKE_DISCORD_ID = "123456789012345678";
const FAKE_DISCORD_TOKEN = "FAKE-DISCORD-WEBHOOK-TOKEN-FOR-TESTS-ONLY-abc123XYZ";

function makeDiscordEnv(discordBaseUrl, overrides = {}) {
  return makeEnv({
    DISCORD_WEBHOOK_URL: `${discordBaseUrl}/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`,
    DISCORD_ENABLED: "true",
    ...overrides,
  });
}

/** Collects raw request bodies for later inspection. */
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Spins up a mock Discord webhook server. `handler` receives
 * `{ req, url, body, requests }` and must respond. Every request is recorded
 * in `requests` with `{ method, url, headers, body }`.
 */
async function mockDiscord(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await collectBody(req);
    const record = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body,
    };
    requests.push(record);
    try {
      await handler({ req, url: req.url, body, requests, record, res });
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `mock handler error: ${err.message}` }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Spins up a mock Telegram API serving getFile + file download for photo
 * forwarding tests.
 */
async function mockTelegramFiles({ filePath = "photos/test-photo.jpg", fileBytes = null, getFileError = null } = {}) {
  const bytes = fileBytes ?? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from("fake-png-bytes")]);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, "http://mock");
    if (url.pathname.endsWith("/getFile")) {
      if (getFileError) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error_code: 400, description: getFileError }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { file_id: "large", file_unique_id: "ul", file_size: bytes.length, file_path: filePath } }));
      return;
    }
    if (url.pathname.includes("/file/bot")) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length) });
      res.end(bytes);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error_code: 404, description: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    fileBytes: bytes,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function jsonOk(res, payload) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function post(env, update, opts, extra = {}) {
  return webhookPost({ request: webhookRequest(update, opts), env, ...extra });
}

async function feedBody(env) {
  const res = await postsGet({ request: getRequest("/posts.json"), env });
  return res.json();
}

/** Captures console.warn/error output during `fn`. */
async function captureLogs(fn) {
  const warnings = [];
  const errors = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...args) => warnings.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const result = await fn();
    return { result, warnings, errors };
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

// --- configuration ----------------------------------------------------------

test("discord is disabled by default when no webhook URL is configured", () => {
  assert.deepEqual(readDiscordConfig(makeEnv()).enabled, false);
  assert.deepEqual(readDiscordConfig(makeEnv({ DISCORD_ENABLED: "" })).enabled, false);
  // Explicitly enabled but no URL: still safely disabled.
  assert.deepEqual(readDiscordConfig(makeEnv({ DISCORD_ENABLED: "true" })).enabled, false);
});

test("DISCORD_ENABLED=false disables forwarding even with a URL set", () => {
  for (const value of ["false", "0", "no", "off", "disabled", "FALSE"]) {
    const cfg = readDiscordConfig(
      makeEnv({ DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`, DISCORD_ENABLED: value }),
    );
    assert.equal(cfg.enabled, false, `DISCORD_ENABLED=${value} should disable`);
  }
});

test("invalid discord webhook URLs are rejected safely", () => {
  const bad = [
    "not-a-url",
    "https://evil.example.com/api/webhooks/123/token",
    "https://discord.com/not-a-webhook",
    "https://discord.com/api/webhooks/notanid/token",
    "http://discord.com/api/webhooks/123/token", // non-localhost http rejected
    "ftp://discord.com/api/webhooks/123/token",
  ];
  for (const url of bad) {
    const cfg = readDiscordConfig(makeEnv({ DISCORD_WEBHOOK_URL: url, DISCORD_ENABLED: "true" }));
    assert.equal(cfg.enabled, false, `${url} should be invalid`);
    assert.equal(cfg.invalid, true);
  }
});

test("unrecognized DISCORD_ENABLED values fail closed", () => {
  const cfg = readDiscordConfig(
    makeEnv({ DISCORD_WEBHOOK_URL: `https://discord.com/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`, DISCORD_ENABLED: "maybe" }),
  );
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.invalid, true);
});

test("valid discord.com, discordapp.com and localhost URLs are accepted", () => {
  const good = [
    `https://discord.com/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`,
    `https://discordapp.com/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`,
    `https://ptb.discord.com/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`,
    `http://127.0.0.1:9999/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`,
  ];
  for (const url of good) {
    const cfg = readDiscordConfig(makeEnv({ DISCORD_WEBHOOK_URL: url }));
    assert.equal(cfg.enabled, true, `${url} should be valid`);
  }
});

// --- text forwarding ----------------------------------------------------------

test("a text post is forwarded to Discord with text, link, id and timestamp", async () => {
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "111111111111111111" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    const res = await post(env, textUpdate(1, 10, 1700000000, "hello discord"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stored: true });

    // Feed persistence is unaffected.
    const feed = await feedBody(env);
    assert.equal(feed.posts.length, 1);
    assert.equal(feed.posts[0].text, "hello discord");

    // Exactly one Discord request with ?wait=true.
    assert.equal(discord.requests.length, 1);
    const [hit] = discord.requests;
    assert.equal(hit.method, "POST");
    assert.match(hit.url, new RegExp(`/api/webhooks/${FAKE_DISCORD_ID}/`));
    assert.match(hit.url, /wait=true/);

    const payload = JSON.parse(hit.body.toString("utf8"));
    assert.equal(payload.username, "chfless");
    assert.equal(payload.embeds.length, 1);
    const embed = payload.embeds[0];
    assert.equal(embed.description, "hello discord");
    assert.equal(embed.url, "https://t.me/chfless/10");
    assert.match(embed.footer.text, /#10/);
    assert.equal(embed.timestamp, "2023-11-14T22:13:20Z");

    // Delivery marker records the Discord message id (and only that).
    const markerRaw = await env.FEED.get(discordMarkerKey(CHANNEL_ID, 10));
    assert.deepEqual(JSON.parse(markerRaw), { id: "111111111111111111" });
    const marker = await getDiscordMarker(env, CHANNEL_ID, 10);
    assert.deepEqual(marker, { discordMessageId: "111111111111111111" });
  } finally {
    await discord.close();
  }
});

test("text forwarding uses a clean embed, never raw JSON dumps", async () => {
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "222222222222222222" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    await post(env, textUpdate(1, 11, 1700000000, "readable body"));
    const payload = JSON.parse(discord.requests[0].body.toString("utf8"));
    const serialized = JSON.stringify(payload);
    // No Telegram internals leak into the Discord payload.
    for (const leak of ["channel_post", "update_id", "file_id", "chat", "message_id"]) {
      assert.ok(!serialized.includes(`"${leak}"`), `discord payload must not contain ${leak}`);
    }
    assert.ok(!serialized.includes(FAKE_TOKEN));
    assert.equal(payload.embeds[0].description, "readable body");
  } finally {
    await discord.close();
  }
});

test("payload builder falls back safely for empty text and odd channel names", () => {
  const empty = buildDiscordPayload(
    { id: 5, type: "text", text: "", published_at: "2023-11-14T22:13:20Z", url: "https://t.me/chfless/5" },
    { id: 1, title: "", username: "", url: "" },
  );
  assert.equal(empty.username, "Telegram Feed");
  assert.equal(empty.embeds[0].description, "(no text)");

  const clyde = buildDiscordPayload(
    { id: 6, type: "text", text: "hi", published_at: "", url: "" },
    { id: 1, title: "clyde fan club", username: "x", url: "" },
  );
  assert.ok(!clyde.username.toLowerCase().includes("clyde"));
});

// --- photo forwarding ---------------------------------------------------------

test("a photo post uploads the image with its caption preserved", async () => {
  const telegram = await mockTelegramFiles({});
  const discord = await mockDiscord(({ url, body, res }) => {
    assert.match(url, /wait=true/);
    // Multipart upload must carry both the JSON payload and the image bytes.
    const text = body.toString("latin1");
    assert.match(text, /payload_json/);
    assert.match(text, /A photo caption/);
    assert.match(text, /attachment:\/\/telegram-12\.jpg/);
    assert.ok(body.includes(telegram.fileBytes), "uploaded body must contain the image bytes");
    jsonOk(res, { id: "333333333333333333" });
  });
  try {
    const env = makeDiscordEnv(discord.baseUrl, {
      TELEGRAM_API_BASE_URL: telegram.baseUrl,
      TELEGRAM_FILE_BASE_URL: telegram.baseUrl,
    });
    const res = await post(env, photoUpdate(1, 12, 1700000100, "A photo caption"));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stored: true });

    const feed = await feedBody(env);
    assert.equal(feed.posts[0].type, "photo");
    assert.equal(feed.posts[0].text, "A photo caption");

    assert.equal(discord.requests.length, 1);
    assert.match(discord.requests[0].headers["content-type"], /multipart\/form-data/);

    // Only the single best rendition is resolved/downloaded (one getFile, one file fetch).
    const getFileCalls = telegram.requests.filter((u) => u.includes("/getFile"));
    const fileCalls = telegram.requests.filter((u) => u.includes("/file/bot"));
    assert.equal(getFileCalls.length, 1);
    assert.equal(fileCalls.length, 1);

    const marker = await getDiscordMarker(env, CHANNEL_ID, 12);
    assert.deepEqual(marker, { discordMessageId: "333333333333333333" });
  } finally {
    await discord.close();
    await telegram.close();
  }
});

test("a photo without a caption still uploads with a readable fallback", async () => {
  const telegram = await mockTelegramFiles({});
  const discord = await mockDiscord(({ body, res }) => {
    // Multipart body: JSON part is UTF-8 (emoji intact), image part is binary.
    const text = body.toString("utf8");
    assert.match(text, /📷 Photo/);
    assert.ok(body.includes(telegram.fileBytes), "uploaded body must contain the image bytes");
    jsonOk(res, { id: "444444444444444444" });
  });
  try {
    const env = makeDiscordEnv(discord.baseUrl, {
      TELEGRAM_API_BASE_URL: telegram.baseUrl,
      TELEGRAM_FILE_BASE_URL: telegram.baseUrl,
    });
    const update = photoUpdate(1, 13, 1700000100, undefined);
    delete update.channel_post.caption;
    await post(env, update);
    assert.equal(discord.requests.length, 1);
  } finally {
    await discord.close();
    await telegram.close();
  }
});

test("photo download failure degrades to a caption-only embed, feed intact", async () => {
  const telegram = await mockTelegramFiles({ getFileError: "Bad Request: wrong file_id" });
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "555555555555555555" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl, {
      TELEGRAM_API_BASE_URL: telegram.baseUrl,
      TELEGRAM_FILE_BASE_URL: telegram.baseUrl,
    });
    const { warnings } = await captureLogs(() => post(env, photoUpdate(1, 14, 1700000100, "caption kept")));
    assert.equal(discord.requests.length, 1);
    // JSON fallback (not multipart) carrying the caption.
    assert.match(discord.requests[0].headers["content-type"], /application\/json/);
    const payload = JSON.parse(discord.requests[0].body.toString("utf8"));
    assert.equal(payload.embeds[0].description, "caption kept");

    const feed = await feedBody(env);
    assert.equal(feed.posts.length, 1);
    assert.equal(feed.posts[0].text, "caption kept");

    for (const line of warnings) {
      assert.ok(!line.includes(FAKE_TOKEN), "telegram token leaked into logs");
      assert.ok(!line.includes(FAKE_DISCORD_TOKEN), "discord token leaked into logs");
    }
  } finally {
    await discord.close();
    await telegram.close();
  }
});

// --- failure isolation ----------------------------------------------------------

test("a Discord outage never breaks Telegram feed persistence", async () => {
  const discord = await mockDiscord(({ res }) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "Internal Server Error", code: 0 }));
  });
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    const { result, warnings } = await captureLogs(() => post(env, textUpdate(1, 20, 1700000000, "keep me")));
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { ok: true, stored: true });

    const feed = await feedBody(env);
    assert.equal(feed.posts.length, 1);
    assert.equal(feed.posts[0].text, "keep me");

    // No marker: nothing was delivered.
    assert.equal(await env.FEED.get(discordMarkerKey(CHANNEL_ID, 20)), null);

    // A redacted diagnostic was logged, with no secrets.
    assert.ok(warnings.some((line) => line.includes("[discord]")));
    for (const line of warnings) {
      assert.ok(!line.includes(FAKE_TOKEN));
      assert.ok(!line.includes(FAKE_DISCORD_TOKEN));
      assert.ok(!line.includes(`${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`));
    }
  } finally {
    await discord.close();
  }
});

test("a failed Discord delivery can recover on a later duplicate delivery", async () => {
  let fail = true;
  const discord = await mockDiscord(({ res }) => {
    if (fail) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Service Unavailable", code: 0 }));
      return;
    }
    jsonOk(res, { id: "666666666666666666" });
  });
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    const update = textUpdate(1, 21, 1700000000, "retry me");
    await captureLogs(() => post(env, update));
    assert.equal(discord.requests.length, 1);

    fail = false;
    await post(env, structuredClone(update)); // Telegram-side replay
    assert.equal(discord.requests.length, 2);

    const feed = await feedBody(env);
    assert.equal(feed.posts.length, 1);
    assert.deepEqual(await getDiscordMarker(env, CHANNEL_ID, 21), {
      discordMessageId: "666666666666666666",
    });
  } finally {
    await discord.close();
  }
});

test("an unreachable Discord host still returns 2xx to Telegram", async () => {
  const env = makeEnv({
    DISCORD_WEBHOOK_URL: `http://127.0.0.1:1/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`,
    DISCORD_ENABLED: "true",
  });
  const { result } = await captureLogs(() => post(env, textUpdate(1, 22, 1700000000, "offline")));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, stored: true });
  const feed = await feedBody(env);
  assert.equal(feed.posts.length, 1);
});

// --- idempotency ------------------------------------------------------------------

test("duplicate Telegram deliveries never duplicate Discord messages", async () => {
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "777777777777777777" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    const update = textUpdate(1, 30, 1700000000, "once only");

    const first = await post(env, structuredClone(update));
    assert.deepEqual(await first.json(), { ok: true, stored: true });
    const second = await post(env, structuredClone(update));
    assert.deepEqual(await second.json(), { ok: true, stored: false });
    const third = await post(env, structuredClone(update));
    assert.deepEqual(await third.json(), { ok: true, stored: false });

    assert.equal(discord.requests.length, 1, "exactly one Discord message for three deliveries");

    const feed = await feedBody(env);
    assert.equal(feed.posts.length, 1);
  } finally {
    await discord.close();
  }
});

test("invalid discord config skips Discord but still persists the feed", async () => {
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "888888888888888888" }));
  try {
    for (const badEnv of [
      makeEnv({ DISCORD_WEBHOOK_URL: "not-a-url", DISCORD_ENABLED: "true" }),
      makeEnv({
        DISCORD_WEBHOOK_URL: `https://evil.example.com/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}`,
        DISCORD_ENABLED: "true",
      }),
      makeDiscordEnv(discord.baseUrl, { DISCORD_ENABLED: "false" }),
      makeEnv(), // no discord configured at all
    ]) {
      const res = await post(badEnv, textUpdate(1, 40, 1700000000, "feed only"));
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, stored: true });
      const feed = await feedBody(badEnv);
      assert.equal(feed.posts.length, 1);
    }
    assert.equal(discord.requests.length, 0, "no Discord traffic for invalid/disabled configs");
  } finally {
    await discord.close();
  }
});

// --- edits --------------------------------------------------------------------------

test("an edited post PATCHes the original Discord message in place", async () => {
  const discord = await mockDiscord(({ req, url, res }) => {
    if (req.method === "POST") return jsonOk(res, { id: "999999999999999999" });
    if (req.method === "PATCH") {
      assert.match(url, /\/messages\/999999999999999999/);
      assert.match(url, /wait=true/);
      return jsonOk(res, { id: "999999999999999999" });
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "method not allowed" }));
  });
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    await post(env, textUpdate(1, 50, 1700000000, "typo"));
    await post(env, editedUpdate(2, 50, 1700000000, 1700000300, "fixed"));

    assert.equal(discord.requests.length, 2);
    assert.equal(discord.requests[0].method, "POST");
    assert.equal(discord.requests[1].method, "PATCH");

    const patched = JSON.parse(discord.requests[1].body.toString("utf8"));
    assert.equal(patched.embeds[0].description, "fixed");
    assert.match(patched.embeds[0].footer.text, /edited/);

    // JSON feed updated in place, never duplicated or corrupted.
    const feed = await feedBody(env);
    assert.equal(feed.posts.length, 1);
    assert.equal(feed.posts[0].text, "fixed");
    assert.equal(feed.posts[0].edited_at, "2023-11-14T22:18:20Z");
  } finally {
    await discord.close();
  }
});

test("a duplicate edit delivery does not PATCH Discord twice", async () => {
  const discord = await mockDiscord(({ req, res }) => {
    if (req.method === "POST") return jsonOk(res, { id: "101010101010101010" });
    return jsonOk(res, { id: "101010101010101010" });
  });
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    await post(env, textUpdate(1, 51, 1700000000, "v1"));
    const edit = editedUpdate(2, 51, 1700000000, 1700000300, "v2");
    await post(env, structuredClone(edit));
    await post(env, structuredClone(edit)); // Telegram retry of the edit
    await post(env, structuredClone(edit));

    const patches = discord.requests.filter((r) => r.method === "PATCH");
    assert.equal(patches.length, 1, "one PATCH for three identical edit deliveries");
  } finally {
    await discord.close();
  }
});

test("an edit with no prior marker posts once and never duplicates", async () => {
  const discord = await mockDiscord(({ req, res }) => jsonOk(res, { id: "121212121212121212" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    // Edit arrives without the original ever being seen (e.g. webhook was
    // registered after the post): bounded fallback is a single fresh post.
    const edit = editedUpdate(1, 52, 1700000000, 1700000300, "edited before seen");
    await post(env, structuredClone(edit));
    await post(env, structuredClone(edit));

    assert.equal(discord.requests.length, 1);
    assert.equal(discord.requests[0].method, "POST");

    const feed = await feedBody(env);
    assert.equal(feed.posts.length, 1);
    assert.equal(feed.posts[0].text, "edited before seen");
    assert.equal(feed.posts[0].edited_at, "2023-11-14T22:18:20Z");
  } finally {
    await discord.close();
  }
});

test("a deleted Discord message falls back to a single repost on edit", async () => {
  const discord = await mockDiscord(({ req, url, res }) => {
    if (req.method === "POST" && !url.includes("/messages/")) {
      // First POST creates; second POST is the 404-repost fallback.
      return jsonOk(res, { id: "131313131313131313" });
    }
    if (req.method === "PATCH") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Unknown Message", code: 50008 }));
      return;
    }
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "method not allowed" }));
  });
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    await post(env, textUpdate(1, 53, 1700000000, "original"));
    const { warnings } = await captureLogs(() =>
      post(env, editedUpdate(2, 53, 1700000000, 1700000300, "edited after delete")),
    );
    const posts = discord.requests.filter((r) => r.method === "POST");
    const patches = discord.requests.filter((r) => r.method === "PATCH");
    assert.equal(posts.length, 2, "original POST + one bounded repost");
    assert.equal(patches.length, 1, "one PATCH attempt that hit 404");
    for (const line of warnings) {
      assert.ok(!line.includes(FAKE_DISCORD_TOKEN));
      assert.ok(!line.includes(FAKE_TOKEN));
    }
    const feed = await feedBody(env);
    assert.equal(feed.posts[0].text, "edited after delete");
  } finally {
    await discord.close();
  }
});

// --- waitUntil --------------------------------------------------------------------------

test("waitUntil defers Discord delivery without delaying acknowledgement", async () => {
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "141414141414141414" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    const pending = [];
    const res = await post(env, textUpdate(1, 60, 1700000000, "background"), {}, {
      waitUntil: (promise) => pending.push(promise),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, stored: true });
    assert.equal(pending.length, 1, "delivery was scheduled via waitUntil");
    await Promise.all(pending);
    assert.equal(discord.requests.length, 1);
    assert.deepEqual(await getDiscordMarker(env, CHANNEL_ID, 60), {
      discordMessageId: "141414141414141414",
    });
  } finally {
    await discord.close();
  }
});

// --- secret hygiene --------------------------------------------------------------------------

test("discord and telegram secrets never appear in responses, feed, or KV", async () => {
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "151515151515151515" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    const webhookRes = await post(env, textUpdate(1, 70, 1700000000, "secret check"));
    const webhookText = await webhookRes.text();
    const feed = await feedBody(env);
    const feedText = JSON.stringify(feed);
    const marker = await env.FEED.get(discordMarkerKey(CHANNEL_ID, 70));

    for (const text of [webhookText, feedText, marker]) {
      assert.ok(!text.includes(FAKE_DISCORD_TOKEN), "discord token leaked");
      assert.ok(!text.includes(FAKE_TOKEN), "telegram token leaked");
    }
    // The Discord request itself must not carry the Telegram token anywhere.
    const discordSide = discord.requests[0].url + discord.requests[0].body.toString("utf8");
    assert.ok(!discordSide.includes(FAKE_TOKEN));

    // Photo path must not leak the token into the Discord request either.
    const telegram = await mockTelegramFiles({});
    const discord2 = await mockDiscord(({ res }) => jsonOk(res, { id: "161616161616161616" }));
    try {
      const env2 = makeDiscordEnv(discord2.baseUrl, {
        TELEGRAM_API_BASE_URL: telegram.baseUrl,
        TELEGRAM_FILE_BASE_URL: telegram.baseUrl,
      });
      await post(env2, photoUpdate(2, 71, 1700000100, "pic"));
      const side2Url = discord2.requests[0].url;
      const side2Body = discord2.requests[0].body.toString("latin1");
      // The Telegram token must appear in neither the Discord URL nor body.
      assert.ok(!side2Url.includes(FAKE_TOKEN), "telegram token leaked into discord URL");
      assert.ok(!side2Body.includes(FAKE_TOKEN), "telegram token leaked into photo upload");
      // The Discord token is necessarily part of the webhook URL path, but it
      // must never be echoed inside the request body.
      assert.ok(!side2Body.includes(FAKE_DISCORD_TOKEN), "discord token echoed in upload body");
    } finally {
      await telegram.close();
      await discord2.close();
    }
  } finally {
    await discord.close();
  }
});

test("redact strips discord webhook tokens from log lines and errors", () => {
  const url = `https://discord.com/api/webhooks/${FAKE_DISCORD_ID}/${FAKE_DISCORD_TOKEN}?wait=true`;
  const safe = redact(`forward failed for ${url}`, FAKE_TOKEN);
  assert.ok(!safe.includes(FAKE_DISCORD_TOKEN));
  assert.ok(safe.includes(FAKE_DISCORD_ID), "webhook id is kept for diagnostics");
  assert.match(safe, /\[REDACTED\]/);
  assert.match(redactDiscordUrl(url), /\[REDACTED\]/);
  assert.ok(!redactDiscordUrl(url).includes(FAKE_DISCORD_TOKEN));
});

test("public endpoints stay secret-free with discord configured", async () => {
  const discord = await mockDiscord(({ res }) => jsonOk(res, { id: "171717171717171717" }));
  try {
    const env = makeDiscordEnv(discord.baseUrl);
    await post(env, textUpdate(1, 80, 1700000000, "public check"));
    const res = await postsGet({ request: getRequest("/posts.json"), env });
    const text = await res.text();
    assert.ok(!text.includes(FAKE_DISCORD_TOKEN));
    assert.ok(!text.includes(FAKE_TOKEN));
  } finally {
    await discord.close();
  }
});
