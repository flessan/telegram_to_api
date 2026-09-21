/**
 * POST /telegram/webhook - receives channel posts pushed by Telegram.
 *
 * Why a webhook instead of getUpdates:
 * `getUpdates` is a destructive queue with a cursor. Cloudflare's runtime is
 * stateless and requests can run concurrently, so polling it from a Worker
 * would require a persisted offset and would risk two invocations draining
 * each other's updates and losing posts permanently. With a webhook, Telegram
 * pushes each update to us, retries on non-2xx, and no cursor exists at all.
 *
 * This endpoint is authenticated with Telegram's own
 * `X-Telegram-Bot-Api-Secret-Token` header (set when registering the webhook),
 * so random internet traffic cannot inject posts into the feed.
 */

import { tryReadConfig } from "../_lib/config.js";
import { forwardToDiscord } from "../_lib/discord.js";
import { errorResponse, preflight, redact } from "../_lib/http.js";
import { processUpdate } from "../_lib/ingest.js";
import { saveposts } from "../_lib/store.js";

export async function onRequestOptions({ request, env }) {
  return preflight(request, env);
}

/** Only POST is meaningful here. */
export async function onRequestGet({ request, env }) {
  return errorResponse(request, env, 405, "method not allowed: use POST");
}

export async function onRequestPost({ request, env, waitUntil }) {
  const { config, error } = tryReadConfig(env);
  if (error) return errorResponse(request, env, 500, error);

  // Constant-ish comparison is unnecessary here (the value is not a password
  // hash), but the check itself is mandatory when a secret is configured.
  if (config.webhookSecret) {
    const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (provided !== config.webhookSecret) {
      return errorResponse(request, env, 401, "invalid webhook secret");
    }
  }

  let update;
  try {
    update = await request.json();
  } catch {
    // 400 tells Telegram not to bother retrying a payload we can never parse.
    return errorResponse(request, env, 400, "request body is not valid JSON");
  }

  const { post, channel, isEdit } = processUpdate(update, config.channelId);

  // Irrelevant or malformed updates are acknowledged with 200 so Telegram
  // stops retrying them, but they never touch the feed (or Discord).
  if (!post) {
    return new Response(JSON.stringify({ ok: true, stored: false }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  try {
    // The JSON feed is the source of truth: validate + persist FIRST. Discord
    // fan-out below is best-effort and can never fail this response.
    const { changed } = await saveposts(env, channel, [post], config.postLimit);

    // Fan-out to Discord without delaying Telegram's acknowledgement. In
    // production `waitUntil` runs delivery in the background; without it
    // (tests, local dev) delivery is awaited so results are observable.
    // forwardToDiscord never throws for network reasons, but guard anyway so a
    // Discord outage can never turn into a 500 that makes Telegram resend an
    // already-persisted post.
    const discordTask = () =>
      forwardToDiscord({
        env,
        post,
        channel,
        isEdit,
        changed,
        telegramToken: config.token,
      }).catch((err) => {
        console.warn(
          `[discord] unexpected fan-out error: ${redact(err?.message ?? "unknown error", config.token)}`,
        );
        return { forwarded: false };
      });

    if (typeof waitUntil === "function") {
      waitUntil(discordTask());
    } else {
      await discordTask();
    }

    return new Response(JSON.stringify({ ok: true, stored: changed }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (err) {
    // 500 makes Telegram retry later; dedup by message id keeps that safe.
    return errorResponse(
      request,
      env,
      500,
      `failed to persist post: ${redact(err?.message ?? "unknown error", config.token)}`,
    );
  }
}
