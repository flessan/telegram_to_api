/**
 * Normalization of raw Telegram Bot API messages into the public JSON schema.
 *
 * This is a direct port of `internal/normalize/normalize.go` and MUST stay
 * behaviourally identical to it: both produce the exact same public schema so
 * the Go collector (local/self-hosted) and the Cloudflare runtime are
 * interchangeable. If you change one, change the other and update both test
 * suites.
 *
 * Nothing sensitive (bot token, request URLs, raw Telegram payloads, sender
 * objects) may ever reach these structures.
 */

/** Bumped only on incompatible changes to the public JSON shape. */
export const SCHEMA_VERSION = 1;

export const TYPE_TEXT = "text";
export const TYPE_PHOTO = "photo";
export const TYPE_VIDEO = "video";
export const TYPE_FILE = "document";
export const TYPE_OTHER = "other";

/** Default number of retained posts, overridable via POST_LIMIT. */
export const DEFAULT_POST_LIMIT = 20;

/** Public channel URL; empty for private channels without a username. */
export function channelURL(username) {
  return username ? `https://t.me/${username}` : "";
}

/**
 * Direct public message link. Private channels have no stable public link,
 * so an empty string is returned rather than a broken URL.
 */
export function messageURL(username, messageId) {
  return username ? `https://t.me/${username}/${messageId}` : "";
}

/** Public channel metadata derived from a channel post. */
export function channelFromMessage(message) {
  const username = message?.chat?.username ?? "";
  return {
    id: message?.chat?.id ?? 0,
    title: message?.chat?.title ?? "",
    username,
    url: channelURL(username),
  };
}

/**
 * Human readable body of a post: message text for text posts, the caption for
 * media posts, and "" when neither exists.
 */
export function extractText(message) {
  if (message?.text) return message.text;
  return message?.caption ?? "";
}

/** Determines the post type and its associated non-sensitive media, if any. */
export function classify(message) {
  const photo = message?.photo;
  if (Array.isArray(photo) && photo.length > 0) {
    // Telegram returns ascending renditions; pick the largest defensively
    // rather than trusting the array order.
    let best = photo[0];
    for (const size of photo) {
      const area = (size?.width ?? 0) * (size?.height ?? 0);
      const bestArea = (best?.width ?? 0) * (best?.height ?? 0);
      if (area > bestArea) best = size;
    }
    return {
      type: TYPE_PHOTO,
      media: {
        type: TYPE_PHOTO,
        file_id: best?.file_id ?? "",
        unique_id: best?.file_unique_id ?? "",
        ...(best?.width ? { width: best.width } : {}),
        ...(best?.height ? { height: best.height } : {}),
      },
    };
  }

  if (message?.video) {
    const v = message.video;
    return {
      type: TYPE_VIDEO,
      media: {
        type: TYPE_VIDEO,
        file_id: v.file_id ?? "",
        unique_id: v.file_unique_id ?? "",
        ...(v.width ? { width: v.width } : {}),
        ...(v.height ? { height: v.height } : {}),
      },
    };
  }

  if (message?.document) {
    const d = message.document;
    return {
      type: TYPE_FILE,
      media: {
        type: TYPE_FILE,
        file_id: d.file_id ?? "",
        unique_id: d.file_unique_id ?? "",
      },
    };
  }

  if (message?.text) return { type: TYPE_TEXT, media: null };
  return { type: TYPE_OTHER, media: null };
}

function rfc3339(unix) {
  if (!unix || unix <= 0) return "";
  // Match Go's time.RFC3339 output in UTC: no milliseconds.
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Converts a single Telegram channel post into a public Post.
 * Key order is fixed so serialization stays deterministic.
 */
export function normalizeMessage(message) {
  const { type, media } = classify(message);
  const post = {
    id: message.message_id,
    type,
    text: extractText(message),
    published_at: rfc3339(message.date),
  };
  if (message.edit_date > 0) post.edited_at = rfc3339(message.edit_date);
  post.url = messageURL(message?.chat?.username ?? "", message.message_id);
  if (media) post.media = media;
  return post;
}

/**
 * Returns true when a Telegram message is a channel post belonging to exactly
 * the configured numeric channel ID.
 *
 * Identity is decided by the numeric chat ID ONLY. A username is never
 * trusted: it can be changed, released and re-registered by someone else, so a
 * foreign channel claiming "@chfless" must be rejected.
 */
export function isConfiguredChannelPost(message, channelId) {
  if (!message || typeof message !== "object") return false;
  if (message?.chat?.type !== "channel") return false;
  if (message?.chat?.id !== channelId) return false;
  const id = message.message_id;
  return typeof id === "number" && Number.isFinite(id) && id > 0;
}

/**
 * Merges existing posts with incoming ones:
 *  - deduplicates by message id (a feed only ever holds one channel),
 *  - later entries win, so an edited post replaces the original,
 *  - sorts chronologically (published_at, then id as a stable tiebreaker),
 *  - retains at most `limit` of the newest posts.
 */
export function mergePosts(existing = [], incoming = [], limit = DEFAULT_POST_LIMIT) {
  const byId = new Map();
  for (const post of [...existing, ...incoming]) {
    if (!post || typeof post.id !== "number") continue;
    byId.set(post.id, post);
  }

  const merged = [...byId.values()].sort((a, b) => {
    if (a.published_at === b.published_at) return a.id - b.id;
    return a.published_at < b.published_at ? -1 : 1;
  });

  if (limit > 0 && merged.length > limit) {
    return merged.slice(merged.length - limit);
  }
  return merged;
}

/**
 * Assembles the public root document. `updatedAt` is injected so output is
 * deterministic under test.
 */
export function buildFeed(channel, posts, updatedAt) {
  const list = posts ?? [];
  return {
    version: SCHEMA_VERSION,
    channel,
    updated_at: rfc3339(Math.floor(updatedAt / 1000)),
    latest: list.length > 0 ? list[list.length - 1] : null,
    posts: list,
  };
}

/** Empty feed used before the first post has been received. */
export function emptyFeed(channelId, username, updatedAt) {
  return buildFeed(
    { id: channelId, title: "", username, url: channelURL(username) },
    [],
    updatedAt,
  );
}
