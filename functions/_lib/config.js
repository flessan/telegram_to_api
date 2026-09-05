/**
 * Environment configuration and validation.
 *
 * Every value comes from Cloudflare environment variables / secrets. Nothing
 * is hard-coded and no value is ever logged or returned to a client.
 */

import { DEFAULT_POST_LIMIT } from "./normalize.js";

/**
 * Validates and parses configuration.
 * @throws {Error} with a non-secret message when configuration is invalid.
 */
export function readConfig(env) {
  const token = (env?.TELEGRAM_BOT_TOKEN ?? "").trim();
  const rawChannel = (env?.TELEGRAM_CHANNEL_ID ?? "").trim();

  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  if (!rawChannel) throw new Error("TELEGRAM_CHANNEL_ID is not configured");

  if (!/^-?\d+$/.test(rawChannel)) {
    throw new Error(
      "TELEGRAM_CHANNEL_ID must be a numeric chat id such as -1001234567890",
    );
  }
  const channelId = Number(rawChannel);
  if (!Number.isSafeInteger(channelId)) {
    throw new Error("TELEGRAM_CHANNEL_ID is out of range");
  }

  const parsedLimit = Number.parseInt(env?.POST_LIMIT ?? "", 10);
  const postLimit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : DEFAULT_POST_LIMIT;

  return {
    token,
    channelId,
    postLimit,
    channelUsername: (env?.TELEGRAM_CHANNEL_USERNAME ?? "").trim(),
    webhookSecret: (env?.TELEGRAM_WEBHOOK_SECRET ?? "").trim(),
  };
}

/** Reads config without throwing; returns { config, error }. */
export function tryReadConfig(env) {
  try {
    return { config: readConfig(env), error: null };
  } catch (err) {
    return { config: null, error: err.message };
  }
}
