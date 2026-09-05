/**
 * Persistence for the public feed.
 *
 * Cloudflare's runtime is stateless: module-level variables live only as long
 * as an isolate and are NOT shared between requests, colocations or deploys.
 * Treating an in-memory array as storage would silently lose posts, so the
 * feed is kept in Workers KV - the simplest Cloudflare-native persistence
 * available. It is a single key holding a small JSON document, not a database.
 *
 * Note there is deliberately NO Telegram update cursor here. The webhook
 * architecture makes one unnecessary: Telegram pushes each update exactly to
 * us and retries on failure, so there is no `getUpdates` offset to track.
 * Deduplication by message id makes retries harmless and idempotent.
 */

import { buildFeed, emptyFeed, mergePosts } from "./normalize.js";

export const FEED_KEY = "feed";

/** Reads the stored feed, falling back to an empty one. */
export async function loadFeed(env, channelId, username, now = Date.now()) {
  const kv = env?.FEED;
  if (!kv) return emptyFeed(channelId, username, now);

  const stored = await kv.get(FEED_KEY, { type: "json" });
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.posts)) {
    // Missing or corrupt value: start clean rather than serving broken JSON.
    return emptyFeed(channelId, username, now);
  }
  return stored;
}

/**
 * Merges new posts into the stored feed and persists the result.
 * Returns the resulting feed and whether anything actually changed.
 */
export async function saveposts(env, channel, incoming, limit, now = Date.now()) {
  const previous = await loadFeed(env, channel.id, channel.username, now);
  const posts = mergePosts(previous.posts, incoming, limit);

  // Prefer freshly observed channel metadata, but never regress to blanks.
  const merged = {
    id: channel.id || previous.channel?.id || 0,
    title: channel.title || previous.channel?.title || "",
    username: channel.username || previous.channel?.username || "",
    url: channel.url || previous.channel?.url || "",
  };

  const feed = buildFeed(merged, posts, now);

  // Ignore updated_at when deciding whether anything changed, so idle webhook
  // traffic does not cause pointless KV writes.
  const changed =
    JSON.stringify({ ...previous, updated_at: "" }) !==
    JSON.stringify({ ...feed, updated_at: "" });

  if (changed && env?.FEED) {
    await env.FEED.put(FEED_KEY, JSON.stringify(feed));
  }
  return { feed, changed };
}
