/**
 * GET /latest.json - just the newest retained post.
 *
 * Convenience endpoint for sites that only render a single "latest update"
 * widget and do not want to download the whole feed.
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
    return jsonResponse(
      request,
      env,
      {
        version: feed.version,
        channel: feed.channel,
        updated_at: feed.updated_at,
        latest: feed.latest ?? null,
      },
      200,
    );
  } catch {
    return errorResponse(request, env, 503, "feed storage is temporarily unavailable");
  }
}
