import test from "node:test";
import assert from "node:assert/strict";

import {
  SCHEMA_VERSION,
  buildFeed,
  channelURL,
  classify,
  extractText,
  isConfiguredChannelPost,
  mergePosts,
  messageURL,
  normalizeMessage,
} from "../functions/_lib/normalize.js";

import { CHANNEL_ID, photoUpdate, textUpdate, editedUpdate } from "./helpers.mjs";

test("text post normalizes with url and RFC3339 timestamp", () => {
  const post = normalizeMessage(textUpdate(1, 12, 1700000000, "hello world").channel_post);
  assert.equal(post.id, 12);
  assert.equal(post.type, "text");
  assert.equal(post.text, "hello world");
  assert.equal(post.url, "https://t.me/chfless/12");
  assert.equal(post.published_at, "2023-11-14T22:13:20Z");
  assert.equal(post.media, undefined);
});

test("photo post normalizes caption into text and picks the largest rendition", () => {
  const post = normalizeMessage(photoUpdate(2, 13, 1700000100, "a caption").channel_post);
  assert.equal(post.type, "photo");
  assert.equal(post.text, "a caption");
  assert.deepEqual(post.media, {
    type: "photo",
    file_id: "large",
    unique_id: "ul",
    width: 1280,
    height: 853,
  });
});

test("post without text or caption yields an empty string consistently", () => {
  const update = photoUpdate(3, 14, 1700000200, undefined);
  delete update.channel_post.caption;
  const post = normalizeMessage(update.channel_post);
  assert.equal(post.text, "");
});

test("edited post carries edited_at", () => {
  const post = normalizeMessage(
    editedUpdate(4, 12, 1700000000, 1700000300, "fixed").edited_channel_post,
  );
  assert.equal(post.text, "fixed");
  assert.equal(post.edited_at, "2023-11-14T22:18:20Z");
});

test("media classification covers video, document and unknown types", () => {
  assert.equal(classify({ text: "x" }).type, "text");
  assert.equal(classify({}).type, "other");
  assert.equal(classify({ video: { file_id: "v", file_unique_id: "uv" } }).type, "video");
  assert.equal(classify({ document: { file_id: "d", file_unique_id: "ud" } }).type, "document");
});

test("private channels without a username get no fabricated url", () => {
  assert.equal(messageURL("", 5), "");
  assert.equal(channelURL(""), "");
  assert.equal(channelURL("chfless"), "https://t.me/chfless");
});

test("extractText prefers text then caption", () => {
  assert.equal(extractText({ text: "t", caption: "c" }), "t");
  assert.equal(extractText({ caption: "c" }), "c");
  assert.equal(extractText({}), "");
});

// --- exact channel-id filtering -------------------------------------------

test("rejects a foreign channel that spoofs the @chfless username", () => {
  const spoof = {
    message_id: 99,
    date: 1700000000,
    // Same username, different numeric id - must be rejected.
    chat: { id: -1009999999999, type: "channel", title: "chfless", username: "chfless" },
    text: "impersonation attempt",
  };
  assert.equal(isConfiguredChannelPost(spoof, CHANNEL_ID), false);
});

test("accepts only the configured numeric channel id", () => {
  const good = textUpdate(1, 10, 1700000000, "mine").channel_post;
  assert.equal(isConfiguredChannelPost(good, CHANNEL_ID), true);
  assert.equal(isConfiguredChannelPost(good, -1), false);
});

test("rejects non-channel chats and malformed messages", () => {
  const group = textUpdate(1, 10, 1700000000, "g").channel_post;
  group.chat.type = "supergroup";
  assert.equal(isConfiguredChannelPost(group, CHANNEL_ID), false);

  assert.equal(isConfiguredChannelPost(null, CHANNEL_ID), false);
  assert.equal(isConfiguredChannelPost(undefined, CHANNEL_ID), false);
  assert.equal(isConfiguredChannelPost("nope", CHANNEL_ID), false);
  assert.equal(isConfiguredChannelPost({ chat: { id: CHANNEL_ID, type: "channel" } }, CHANNEL_ID), false);
});

// --- merge / dedup / ordering / retention ---------------------------------

test("deduplicates by message id and orders chronologically", () => {
  const a = normalizeMessage(textUpdate(1, 12, 1700000000, "first").channel_post);
  const b = normalizeMessage(photoUpdate(2, 13, 1700000100, "second").channel_post);

  const merged = mergePosts([b], [a, b, a], 20);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((p) => p.id), [12, 13]);
});

test("merge is idempotent", () => {
  const posts = [
    normalizeMessage(textUpdate(1, 12, 1700000000, "a").channel_post),
    normalizeMessage(photoUpdate(2, 13, 1700000100, "b").channel_post),
  ];
  const once = mergePosts([], posts, 20);
  const twice = mergePosts(once, posts, 20);
  assert.deepEqual(once, twice);
});

test("an edit replaces the original post rather than duplicating it", () => {
  const original = normalizeMessage(textUpdate(1, 12, 1700000000, "typo").channel_post);
  const edited = normalizeMessage(editedUpdate(2, 12, 1700000000, 1700000300, "fixed").edited_channel_post);

  const merged = mergePosts([original], [edited], 20);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].text, "fixed");
  assert.equal(merged[0].edited_at, "2023-11-14T22:18:20Z");
});

test("retention keeps only the newest N posts", () => {
  const posts = [];
  for (let i = 1; i <= 25; i += 1) {
    posts.push(normalizeMessage(textUpdate(i, i, 1700000000 + i, `p${i}`).channel_post));
  }
  const merged = mergePosts([], posts, 20);
  assert.equal(merged.length, 20);
  assert.equal(merged[0].id, 6);
  assert.equal(merged[19].id, 25);
});

test("ordering is deterministic regardless of input order", () => {
  const posts = [
    normalizeMessage(textUpdate(3, 3, 1700000300, "c").channel_post),
    normalizeMessage(textUpdate(1, 1, 1700000100, "a").channel_post),
    normalizeMessage(textUpdate(2, 2, 1700000200, "b").channel_post),
  ];
  const forward = mergePosts([], posts, 20);
  const reversed = mergePosts([], [...posts].reverse(), 20);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward.map((p) => p.id), [1, 2, 3]);
});

// --- feed document ---------------------------------------------------------

test("buildFeed points latest at the newest post", () => {
  const posts = mergePosts(
    [],
    [
      normalizeMessage(textUpdate(1, 12, 1700000000, "a").channel_post),
      normalizeMessage(photoUpdate(2, 13, 1700000100, "b").channel_post),
    ],
    20,
  );
  const feed = buildFeed({ id: CHANNEL_ID, title: "chfless", username: "chfless", url: "https://t.me/chfless" }, posts, 1700000500000);
  assert.equal(feed.version, SCHEMA_VERSION);
  assert.equal(feed.latest.id, 13);
  assert.equal(feed.updated_at, "2023-11-14T22:21:40Z");
  assert.equal(feed.posts.length, 2);
});

test("empty feed exposes latest:null and an array of posts", () => {
  const feed = buildFeed({ id: 0, title: "", username: "", url: "" }, [], 0);
  assert.equal(feed.latest, null);
  assert.deepEqual(feed.posts, []);
});
