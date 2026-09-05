/**
 * Cross-implementation parity check.
 *
 * The Go collector (internal/normalize) and the Cloudflare function
 * (functions/_lib/normalize.js) must emit exactly the same public schema, so
 * the two deployment paths are interchangeable. This test pins the expected
 * shape; `go test ./internal/normalize` pins the same values on the Go side.
 *
 * If this fails, one implementation has drifted - fix both, don't relax it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildFeed, mergePosts, normalizeMessage } from "../functions/_lib/normalize.js";
import { CHANNEL_ID, photoUpdate, textUpdate } from "./helpers.mjs";

test("feed document matches the Go collector's schema exactly", () => {
  const posts = mergePosts(
    [],
    [
      normalizeMessage(textUpdate(1, 1, 1700000000, "Hello from the channel").channel_post),
      normalizeMessage(photoUpdate(2, 2, 1700000600, "A photo caption").channel_post),
    ],
    20,
  );

  const feed = buildFeed(
    { id: CHANNEL_ID, title: "chfless", username: "chfless", url: "https://t.me/chfless" },
    posts,
    1700000700000,
  );

  // Byte-for-byte identical to what internal/storage writes to data/posts.json.
  assert.deepEqual(feed, {
    version: 1,
    channel: {
      id: -1001234567890,
      title: "chfless",
      username: "chfless",
      url: "https://t.me/chfless",
    },
    updated_at: "2023-11-14T22:25:00Z",
    latest: {
      id: 2,
      type: "photo",
      text: "A photo caption",
      published_at: "2023-11-14T22:23:20Z",
      url: "https://t.me/chfless/2",
      media: {
        type: "photo",
        file_id: "large",
        unique_id: "ul",
        width: 1280,
        height: 853,
      },
    },
    posts: [
      {
        id: 1,
        type: "text",
        text: "Hello from the channel",
        published_at: "2023-11-14T22:13:20Z",
        url: "https://t.me/chfless/1",
      },
      {
        id: 2,
        type: "photo",
        text: "A photo caption",
        published_at: "2023-11-14T22:23:20Z",
        url: "https://t.me/chfless/2",
        media: {
          type: "photo",
          file_id: "large",
          unique_id: "ul",
          width: 1280,
          height: 853,
        },
      },
    ],
  });
});

test("JSON key order is stable and deterministic across serializations", () => {
  const post = normalizeMessage(textUpdate(1, 1, 1700000000, "x").channel_post);
  assert.deepEqual(Object.keys(post), ["id", "type", "text", "published_at", "url"]);

  const feed = buildFeed({ id: 1, title: "", username: "", url: "" }, [post], 0);
  assert.deepEqual(Object.keys(feed), ["version", "channel", "updated_at", "latest", "posts"]);

  assert.equal(JSON.stringify(feed), JSON.stringify(structuredClone(feed)));
});
