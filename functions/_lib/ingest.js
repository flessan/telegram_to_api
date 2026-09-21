/**
 * Turns a raw Telegram webhook update into normalized posts.
 *
 * Pure and side-effect free so it can be tested without any network, KV or
 * credentials.
 */

import {
  channelFromMessage,
  isConfiguredChannelPost,
  normalizeMessage,
} from "./normalize.js";

/**
 * Extracts the channel post from an update.
 * Both new posts and edits are accepted; edits replace the original during
 * the merge step because they share the same message id.
 */
export function extractChannelPost(update) {
  if (!update || typeof update !== "object") return null;
  return update.channel_post ?? update.edited_channel_post ?? null;
}

/**
 * True when the update carries an `edited_channel_post` (and no new
 * `channel_post`). New posts take precedence if both are ever present.
 */
export function isEditUpdate(update) {
  if (!update || typeof update !== "object") return false;
  if (update.channel_post) return false;
  return !!update.edited_channel_post;
}

/**
 * Processes one update against the configured channel.
 *
 * Returns { post, channel, isEdit } when the update is a relevant channel
 * post, or { post: null } for anything else: unsupported update types,
 * malformed payloads, group/supergroup messages, and - critically - posts
 * from any other chat, even one advertising the same @username.
 */
export function processUpdate(update, channelId) {
  const message = extractChannelPost(update);
  if (!isConfiguredChannelPost(message, channelId)) {
    return { post: null, channel: null, isEdit: false };
  }

  return {
    post: normalizeMessage(message),
    channel: channelFromMessage(message),
    isEdit: isEditUpdate(update),
  };
}

/**
 * Processes a batch of updates, preserving order and skipping irrelevant ones.
 */
export function processUpdates(updates, channelId) {
  const posts = [];
  let channel = null;
  for (const update of Array.isArray(updates) ? updates : []) {
    const result = processUpdate(update, channelId);
    if (result.post) {
      posts.push(result.post);
      channel = result.channel;
    }
  }
  return { posts, channel };
}
