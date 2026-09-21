/**
 * Discord fan-out for the Telegram feed.
 *
 * Every validated Telegram channel post is persisted to Workers KV first
 * (the JSON feed is the source of truth). Afterwards - and only afterwards -
 * the same normalized post is forwarded to a Discord channel through a
 * Discord Incoming Webhook. Discord delivery is strictly best-effort: it can
 * never break feed persistence, never changes the webhook's 2xx response to
 * Telegram, and never leaks secrets into logs, responses, or KV.
 *
 * Idempotency: one KV marker per Telegram message id
 * (`discord:<channelId>:<messageId>`) records the Discord message id returned
 * by the webhook (`?wait=true`). Duplicate Telegram deliveries find the marker
 * and skip Discord, so retries never create duplicate Discord messages.
 *
 * Edits: when a Telegram post is edited, the stored Discord message id is used
 * to PATCH the original Discord message in place instead of posting a new one.
 * If no marker exists for an edit (e.g. the original post predates the Discord
 * integration), the edit is posted once as a new Discord message and the
 * marker is created - still bounded to a single Discord message per Telegram
 * id, never uncontrolled duplicates. See README "Discord forwarding & edits".
 *
 * Photos: Telegram `file_id`s are meaningless to Discord, so the largest
 * rendition is resolved via getFile and downloaded server-side, then uploaded
 * to the Discord webhook as a multipart attachment. The Telegram bot token
 * only ever appears in server-side Telegram URLs and is redacted everywhere
 * else. Oversized/failed downloads degrade gracefully to a caption-only embed.
 */

import { redact } from "./http.js";
import { downloadTelegramFile, getFile } from "./telegram.js";

export const DISCORD_TIMEOUT_MS = 10_000;
export const DISCORD_EMBED_COLOR = 0x229ed9; // Telegram blue
export const DISCORD_MAX_DESCRIPTION = 4000;
export const DISCORD_MAX_USERNAME = 80;

/** Values accepted for DISCORD_ENABLED (case-insensitive). Empty = auto. */
const ENABLED_TRUE = new Set(["1", "true", "yes", "on", "enabled"]);
const ENABLED_FALSE = new Set(["0", "false", "no", "off", "disabled"]);

function isLocalhost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isDiscordHost(hostname) {
  const host = (hostname ?? "").toLowerCase();
  return (
    host === "discord.com" ||
    host.endsWith(".discord.com") ||
    host === "discordapp.com" ||
    host.endsWith(".discordapp.com")
  );
}

/** Redacts the secret token segment of a Discord webhook URL, keeping the id. */
export function redactDiscordUrl(webhookUrl) {
  return redact(String(webhookUrl ?? ""), "");
}

/**
 * Reads and validates the Discord configuration.
 *
 * Safe default: when DISCORD_WEBHOOK_URL is empty, forwarding is disabled and
 * everything else works exactly as before (local dev, tests, feed-only
 * deploys). Set DISCORD_ENABLED to an explicit false value to disable even
 * when a webhook URL is configured.
 *
 * Returns `{ enabled, webhookUrl, invalid, reason }`. `webhookUrl` is empty
 * unless forwarding is enabled with a valid URL.
 */
export function readDiscordConfig(env) {
  const webhookUrl = (env?.DISCORD_WEBHOOK_URL ?? "").trim();
  const rawEnabled = (env?.DISCORD_ENABLED ?? "").trim().toLowerCase();

  if (rawEnabled !== "" && ENABLED_FALSE.has(rawEnabled)) {
    return { enabled: false, webhookUrl: "", invalid: false, reason: "disabled via DISCORD_ENABLED" };
  }
  if (rawEnabled !== "" && !ENABLED_TRUE.has(rawEnabled)) {
    return {
      enabled: false,
      webhookUrl: "",
      invalid: true,
      reason: `DISCORD_ENABLED has an unrecognized value ${JSON.stringify(rawEnabled)}`,
    };
  }

  if (!webhookUrl) {
    return {
      enabled: false,
      webhookUrl: "",
      invalid: false,
      reason: "DISCORD_WEBHOOK_URL is not configured",
    };
  }

  let parsed;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return {
      enabled: false,
      webhookUrl: "",
      invalid: true,
      reason: "DISCORD_WEBHOOK_URL is not a valid URL",
    };
  }

  const localhost = isLocalhost(parsed.hostname);
  if (parsed.protocol !== "https:" && !(localhost && parsed.protocol === "http:")) {
    return {
      enabled: false,
      webhookUrl: "",
      invalid: true,
      reason: "DISCORD_WEBHOOK_URL must use https",
    };
  }
  if (!localhost && !isDiscordHost(parsed.hostname)) {
    return {
      enabled: false,
      webhookUrl: "",
      invalid: true,
      reason: "DISCORD_WEBHOOK_URL must be a discord.com (or discordapp.com) webhook URL",
    };
  }
  if (!/^\/api\/webhooks\/\d+\/[A-Za-z0-9_.-]+/.test(parsed.pathname)) {
    return {
      enabled: false,
      webhookUrl: "",
      invalid: true,
      reason: "DISCORD_WEBHOOK_URL must look like https://discord.com/api/webhooks/<id>/<token>",
    };
  }

  return { enabled: true, webhookUrl, invalid: false, reason: null };
}

/** Telegram API bases, overridable for tests via env (production: defaults). */
export function telegramBases(env) {
  const apiBase = (env?.TELEGRAM_API_BASE_URL ?? "").trim() || "https://api.telegram.org";
  const fileBase =
    (env?.TELEGRAM_FILE_BASE_URL ?? "").trim() ||
    (env?.TELEGRAM_API_BASE_URL ?? "").trim() ||
    "https://api.telegram.org";
  return { apiBase, fileBase };
}

function truncate(text, max) {
  const value = String(text ?? "");
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return value.slice(0, max - 1) + "…";
}

/**
 * Discord rejects the usernames "discord" and anything containing "clyde".
 * The channel title is used as the webhook username (it labels the message,
 * it does not impersonate a Discord user); fall back safely.
 */
function sanitizeUsername(channel) {
  const raw = (channel?.title || (channel?.username ? `@${channel.username}` : "") || "Telegram Feed").trim();
  let name = truncate(raw || "Telegram Feed", DISCORD_MAX_USERNAME);
  const lowered = name.toLowerCase();
  if (lowered === "discord" || lowered.includes("clyde")) {
    name = truncate(`${name} Feed`, DISCORD_MAX_USERNAME);
    if (name.toLowerCase().includes("clyde")) name = "Telegram Feed";
  }
  return name;
}

function fallbackDescription(post) {
  switch (post?.type) {
    case "photo":
      return "📷 Photo";
    case "video":
      return "🎬 Video";
    case "document":
      return "📄 Document";
    default:
      return post?.type === "text" ? "(no text)" : "New post";
  }
}

/**
 * Builds the Discord webhook JSON payload for a normalized post.
 * Pure function - no network, no secrets.
 */
export function buildDiscordPayload(post, channel, options = {}) {
  const username = sanitizeUsername(channel);
  const authorName = truncate(channel?.title || (channel?.username ? `@${channel.username}` : "Telegram"), 256);
  const title = truncate(`Telegram post #${post?.id ?? "?"}`, 256);
  const description = post?.text
    ? truncate(post.text, DISCORD_MAX_DESCRIPTION)
    : fallbackDescription(post);

  const footerBits = [`Telegram message #${post?.id ?? "?"}`];
  if (channel?.username) footerBits.push(`@${channel.username}`);
  if (post?.edited_at) footerBits.push("edited");
  const footer = { text: truncate(footerBits.join(" • "), 2048) };

  const embed = {
    color: DISCORD_EMBED_COLOR,
    author: { name: authorName },
    title,
    description,
    timestamp: post?.published_at || undefined,
    footer,
  };
  if (channel?.url && channel.url.startsWith("https://")) {
    embed.author.url = channel.url;
  }
  if (post?.url && post.url.startsWith("https://")) {
    embed.url = post.url;
  }
  if (!embed.timestamp) delete embed.timestamp;

  const attachmentFilename = options.attachmentFilename;
  if (attachmentFilename && post?.type === "photo") {
    embed.image = { url: `attachment://${attachmentFilename}` };
  }

  return { username, embeds: [embed] };
}

/** KV key for the per-message Discord delivery marker. */
export function discordMarkerKey(channelId, messageId) {
  return `discord:${channelId}:${messageId}`;
}

/**
 * Reads the delivery marker. Returns `{ discordMessageId }`, `{ sent: true }`
 * for legacy markers without an id, or `null` when never forwarded / no KV.
 */
export async function getDiscordMarker(env, channelId, messageId) {
  try {
    const kv = env?.FEED;
    if (!kv) return null;
    const raw = await kv.get(discordMarkerKey(channelId, messageId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (typeof parsed.id === "string" && parsed.id) return { discordMessageId: parsed.id };
        if (parsed.sent) return { sent: true };
        return null;
      }
      if (typeof parsed === "string" && parsed) return { discordMessageId: parsed };
      return null;
    } catch {
      // Tolerate a plain-string legacy value.
      return typeof raw === "string" && raw ? { discordMessageId: raw } : null;
    }
  } catch {
    return null;
  }
}

/** Records a successful Discord delivery. Never stores secrets. */
export async function putDiscordMarker(env, channelId, messageId, discordMessageId) {
  try {
    const kv = env?.FEED;
    if (!kv) return;
    const value = discordMessageId
      ? JSON.stringify({ id: String(discordMessageId) })
      : JSON.stringify({ sent: true });
    await kv.put(discordMarkerKey(channelId, messageId), value);
  } catch {
    // Marker writes are best-effort; the feed is already persisted.
  }
}

function withWaitParam(webhookUrl) {
  return webhookUrl.includes("?") ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;
}

function discordError(reason, webhookUrl, telegramToken) {
  // Status codes and Discord's `message`/`code` are safe; URLs/tokens are not.
  return redact(String(reason ?? "unknown error"), telegramToken);
}

async function readDiscordError(response) {
  try {
    const payload = await response.json();
    const detail = payload?.message ? ` - ${payload.message}` : "";
    const code = payload?.code !== undefined ? ` (code ${payload.code})` : "";
    return `status ${response.status}${code}${detail}`;
  } catch {
    return `status ${response.status}`;
  }
}

/**
 * POSTs a JSON payload to the Discord webhook with ?wait=true.
 * Returns the created Discord message (with `.id`).
 */
export async function postToDiscord(webhookUrl, jsonPayload, options = {}) {
  const timeoutMs = options.timeoutMs ?? DISCORD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(withWaitParam(webhookUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jsonPayload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`discord webhook failed: ${await readDiscordError(response)}`);
    }
    try {
      return await response.json();
    } catch {
      return {};
    }
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("discord webhook timed out");
    if (err?.message?.startsWith("discord webhook failed")) throw err;
    throw new Error(`discord webhook unreachable: ${err?.message ?? "network error"}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PATCHes an existing Discord webhook message in place (?wait=true).
 * `discordMessageId` is validated as digits-only to prevent path injection.
 */
export async function patchDiscordMessage(webhookUrl, discordMessageId, jsonPayload, options = {}) {
  if (!/^\d+$/.test(String(discordMessageId ?? ""))) {
    throw new Error("discord message id is invalid");
  }
  const base = webhookUrl.replace(/\/$/, "");
  const url = `${base}/messages/${discordMessageId}`;
  const timeoutMs = options.timeoutMs ?? DISCORD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(withWaitParam(url), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jsonPayload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`discord edit failed: ${await readDiscordError(response)}`);
      error.status = response.status;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      return {};
    }
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("discord edit timed out");
    if (err?.message?.startsWith("discord edit failed")) throw err;
    throw new Error(`discord edit unreachable: ${err?.message ?? "network error"}`);
  } finally {
    clearTimeout(timer);
  }
}

function filenameFromPath(filePath, messageId, contentType) {
  const base = String(filePath ?? "").split("/").pop() || "";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")).toLowerCase() : "";
  const safeExt = /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : contentType?.includes("png") ? ".png" : ".jpg";
  const id = Number.isFinite(Number(messageId)) ? Number(messageId) : "photo";
  return `telegram-${id}${safeExt}`;
}

/**
 * Uploads a photo to Discord as a multipart attachment with ?wait=true.
 * `imageBytes` is an ArrayBuffer. Returns the created Discord message.
 */
export async function uploadPhotoToDiscord(
  webhookUrl,
  jsonPayload,
  imageBytes,
  filename,
  contentType,
  options = {},
) {
  const timeoutMs = options.timeoutMs ?? DISCORD_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append(
      "payload_json",
      new Blob([JSON.stringify(jsonPayload)], { type: "application/json" }),
    );
    form.append(
      "files[0]",
      new Blob([imageBytes], { type: contentType || "image/jpeg" }),
      filename,
    );
    const response = await fetch(withWaitParam(webhookUrl), {
      method: "POST",
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`discord photo upload failed: ${await readDiscordError(response)}`);
    }
    try {
      return await response.json();
    } catch {
      return {};
    }
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("discord photo upload timed out");
    if (err?.message?.startsWith("discord photo upload failed")) throw err;
    throw new Error(`discord photo upload unreachable: ${err?.message ?? "network error"}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Best-effort fan-out of one normalized post to Discord.
 *
 * Preconditions (handled by the caller): the Telegram update was validated
 * against the numeric channel id and the post was already persisted to KV.
 * This function never throws for Discord/Telegram-network reasons; it logs a
 * redacted diagnostic and returns `{ forwarded: false }` so the caller can
 * still acknowledge Telegram with 2xx.
 */
export async function forwardToDiscord({
  env,
  post,
  channel,
  isEdit = false,
  changed = true,
  telegramToken = "",
  timeoutMs = DISCORD_TIMEOUT_MS,
}) {
  const discord = readDiscordConfig(env);
  if (!discord.enabled) {
    return { forwarded: false, skipped: true, reason: discord.reason };
  }

  const channelId = channel?.id;
  const messageId = post?.id;
  if (!Number.isFinite(messageId)) {
    return { forwarded: false, skipped: true, reason: "post has no message id" };
  }

  const marker = await getDiscordMarker(env, channelId, messageId);

  // Duplicate new-post delivery: the marker proves Discord already got it.
  if (!isEdit && marker) {
    return { forwarded: false, skipped: true, reason: "already forwarded (duplicate delivery)" };
  }

  // Edit of an already-forwarded post: update the Discord message in place.
  if (isEdit && marker?.discordMessageId) {
    if (!changed) {
      return { forwarded: false, skipped: true, reason: "unchanged edit (duplicate delivery)" };
    }
    const payload = buildDiscordPayload(post, channel);
    try {
      await patchDiscordMessage(discord.webhookUrl, marker.discordMessageId, payload, { timeoutMs });
      return { forwarded: true, updated: true };
    } catch (err) {
      // The Discord message may have been deleted manually; fall through to a
      // single fresh post so the edit is still visible (bounded to one message
      // because the marker is overwritten below).
      const status = err?.status;
      if (status !== 404) {
        console.warn(`[discord] edit update failed for telegram #${messageId}: ${discordError(err?.message, discord.webhookUrl, telegramToken)}`);
        return { forwarded: false, error: "discord edit failed" };
      }
      console.warn(`[discord] original message for telegram #${messageId} is gone; reposting`);
    }
  }

  // Edit without a marker id (never forwarded, or legacy marker): post once as
  // a new message. Bounded to one Discord message by the marker written below.
  if (isEdit && marker && !marker.discordMessageId) {
    if (!changed) {
      return { forwarded: false, skipped: true, reason: "already forwarded (duplicate delivery)" };
    }
  }

  // Fresh post (or edit fallback / 404-repost): create a Discord message.
  try {
    if (post?.type === "photo" && post?.media?.file_id) {
      const photo = await tryForwardPhoto({
        env,
        post,
        channel,
        webhookUrl: discord.webhookUrl,
        telegramToken,
        timeoutMs,
      });
      if (photo.forwarded) {
        await putDiscordMarker(env, channelId, messageId, photo.discordMessageId);
        return { forwarded: true, withPhoto: true };
      }
      if (photo.fatal) {
        return { forwarded: false, error: photo.error };
      }
      // Non-fatal photo failure (download too large, getFile error): fall
      // through to a caption-only embed so the post is still visible.
    }

    const payload = buildDiscordPayload(post, channel);
    const created = await postToDiscord(discord.webhookUrl, payload, { timeoutMs });
    await putDiscordMarker(env, channelId, messageId, created?.id);
    return { forwarded: true };
  } catch (err) {
    console.warn(`[discord] forward failed for telegram #${messageId}: ${discordError(err?.message, discord.webhookUrl, telegramToken)}`);
    return { forwarded: false, error: "discord forward failed" };
  }
}

/**
 * Attempts the photo path: getFile -> download -> multipart upload.
 * Returns `{ forwarded, discordMessageId }` on success, `{ forwarded: false,
 * fatal: false }` when the caller should degrade to a caption-only embed, or
 * `{ forwarded: false, fatal: true }` when even the fallback was attempted and
 * failed (currently unused; kept for clarity).
 */
async function tryForwardPhoto({ env, post, channel, webhookUrl, telegramToken, timeoutMs }) {
  const fileId = post?.media?.file_id;
  if (!fileId) return { forwarded: false, fatal: false };
  const { apiBase, fileBase } = telegramBases(env);
  try {
    const file = await getFile(telegramToken, fileId, { baseUrl: apiBase, timeoutMs });
    const filePath = file?.file_path;
    if (!filePath) {
      console.warn(`[discord] telegram getFile returned no file_path for #${post.id}; sending caption only`);
      return { forwarded: false, fatal: false };
    }
    const { bytes, contentType } = await downloadTelegramFile(telegramToken, filePath, {
      fileBaseUrl: fileBase,
      timeoutMs: Math.max(timeoutMs, 15_000),
    });
    const filename = filenameFromPath(filePath, post.id, contentType);
    const payload = buildDiscordPayload(post, channel, { attachmentFilename: filename });
    const created = await uploadPhotoToDiscord(webhookUrl, payload, bytes, filename, contentType, {
      timeoutMs,
    });
    return { forwarded: true, discordMessageId: created?.id };
  } catch (err) {
    // Download/upload problems degrade to a caption-only embed; only the final
    // JSON post failing counts as a forward failure.
    console.warn(`[discord] photo path failed for telegram #${post.id} (${redact(err?.message ?? "unknown error", telegramToken)}); sending caption only`);
    return { forwarded: false, fatal: false };
  }
}
