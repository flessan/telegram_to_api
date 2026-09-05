/**
 * GET /posts.json — the public feed consumed by the website.
 *
 * Read-only, cache-friendly, CORS-enabled. Contains only public channel
 * content: no tokens, no raw Telegram payloads, no Bot API internals.
 */

import { tryReadConfig } from "./_lib/config.js";
import { errorResponse, jsonResponse, preflight } from "./_lib/http.js";
import { loadFeed } from "./_lib/store.js";

export async function onRequestOptions({ request, env }) {
  return preflight(request, env);
}

export async function onRequestGet({ request, env }) {
  const { config, error } = tryReadConfig(env);
  if (error) return errorResponse(request, env, 500, error);

  try {
    const feed = await loadFeed(env, config.channelId, config.channelUsername);
    return jsonResponse(request, env, feed, 200);
  } catch {
    return errorResponse(request, env, 503, "feed storage is temporarily unavailable");
  }
}
