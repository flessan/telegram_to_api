/**
 * Shared test helpers: an in-memory Workers KV stub and Telegram fixtures.
 *
 * All tokens used anywhere in the test suite are obviously fake placeholders.
 */

export const CHANNEL_ID = -1001234567890;
export const FAKE_TOKEN = "111111:TEST-FAKE-TOKEN-NOT-A-REAL-CREDENTIAL-0000";

/** Minimal stand-in for a Workers KV namespace binding. */
export class MemoryKV {
  constructor() {
    this.map = new Map();
    this.writes = 0;
  }

  async get(key, options) {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    if (options?.type === "json") {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw;
  }

  async put(key, value) {
    this.writes += 1;
    this.map.set(key, value);
  }
}

export function makeEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: FAKE_TOKEN,
    TELEGRAM_CHANNEL_ID: String(CHANNEL_ID),
    TELEGRAM_CHANNEL_USERNAME: "chfless",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    POST_LIMIT: "20",
    FEED: new MemoryKV(),
    ...overrides,
  };
}

export function textUpdate(updateId, messageId, date, text) {
  return {
    update_id: updateId,
    channel_post: {
      message_id: messageId,
      date,
      chat: { id: CHANNEL_ID, type: "channel", title: "chfless", username: "chfless" },
      text,
    },
  };
}

export function photoUpdate(updateId, messageId, date, caption) {
  return {
    update_id: updateId,
    channel_post: {
      message_id: messageId,
      date,
      chat: { id: CHANNEL_ID, type: "channel", title: "chfless", username: "chfless" },
      caption,
      photo: [
        { file_id: "small", file_unique_id: "us", width: 90, height: 60 },
        { file_id: "large", file_unique_id: "ul", width: 1280, height: 853 },
      ],
    },
  };
}

export function editedUpdate(updateId, messageId, date, editDate, text) {
  return {
    update_id: updateId,
    edited_channel_post: {
      message_id: messageId,
      date,
      edit_date: editDate,
      chat: { id: CHANNEL_ID, type: "channel", title: "chfless", username: "chfless" },
      text,
    },
  };
}

/** Builds a Request suitable for the webhook handler. */
export function webhookRequest(body, { secret = "test-webhook-secret", origin } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (secret !== null) headers["X-Telegram-Bot-Api-Secret-Token"] = secret;
  if (origin) headers.Origin = origin;
  return new Request("https://example.pages.dev/telegram/webhook", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function getRequest(path = "/posts.json", { origin } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  return new Request(`https://example.pages.dev${path}`, { method: "GET", headers });
}
