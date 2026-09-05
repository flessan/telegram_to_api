/**
 * GET / - API metadata / discovery document.
 *
 * Deliberately exposes no configuration values: no token (obviously), and no
 * numeric channel id beyond what is already public in the feed itself.
 */

import { tryReadConfig } from "./_lib/config.js";
import { SCHEMA_VERSION, channelURL } from "./_lib/normalize.js";
import { errorResponse, jsonResponse, preflight } from "./_lib/http.js";
import { loadFeed } from "./_lib/store.js";

export async function onRequestOptions({ request, env }) {
  return preflight(request, env);
}

export async function onRequestGet({ request, env }) {
  const { config, error } = tryReadConfig(env);
  if (error) return errorResponse(request, env, 500, error);

  let postCount = 0;
  let updatedAt = null;
  try {
    const feed = await loadFeed(env, config.channelId, config.channelUsername);
    postCount = feed.posts?.length ?? 0;
    updatedAt = feed.updated_at ?? null;
  } catch {
    // Metadata should still render if storage hiccups.
  }

  return jsonResponse(request, env, {
    name: "Telegram Channel to JSON",
    description: "Read-only public JSON feed of a Telegram channel.",
    schema_version: SCHEMA_VERSION,
    channel: config.channelUsername ? channelURL(config.channelUsername) : null,
    post_limit: config.postLimit,
    post_count: postCount,
    updated_at: updatedAt,
    endpoints: {
      posts: "/posts.json",
      latest: "/latest.json",
    },
  });
}
