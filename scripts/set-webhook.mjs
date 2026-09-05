#!/usr/bin/env node
/**
 * One-off helper that registers (or removes) the Telegram webhook so Telegram
 * pushes channel posts to your deployed Cloudflare Pages Function.
 *
 * Run it locally; it reads the token from the environment and never prints it.
 *
 *   TELEGRAM_BOT_TOKEN=...  \
 *   TELEGRAM_WEBHOOK_SECRET=...  \
 *   PUBLIC_BASE_URL=https://telegram-to-json.pages.dev  \
 *   npm run setup-webhook
 *
 *   npm run delete-webhook   # to unregister
 */

const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const secret = (process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
const baseUrl = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/$/, "");
const remove = process.argv.includes("--delete");

/** Strips anything token-shaped from output. */
function redact(text) {
  let out = String(text ?? "");
  if (token) out = out.split(token).join("[REDACTED]");
  return out.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[REDACTED]");
}

function fail(message) {
  console.error(`error: ${redact(message)}`);
  process.exit(1);
}

if (!token) fail("TELEGRAM_BOT_TOKEN is not set");
if (!remove && !baseUrl) fail("PUBLIC_BASE_URL is not set (e.g. https://your-project.pages.dev)");

const method = remove ? "deleteWebhook" : "setWebhook";
const url = new URL(`https://api.telegram.org/bot${token}/${method}`);

if (!remove) {
  url.searchParams.set("url", `${baseUrl}/telegram/webhook`);
  url.searchParams.set("allowed_updates", JSON.stringify(["channel_post", "edited_channel_post"]));
  // Ignore anything queued before setup so the feed starts clean.
  url.searchParams.set("drop_pending_updates", "true");
  if (secret) url.searchParams.set("secret_token", secret);
}

let payload;
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  payload = await response.json();
} catch (err) {
  fail(`could not reach the Telegram API: ${err?.message ?? "network error"}`);
}

if (!payload?.ok) {
  fail(`${method} failed (code ${payload?.error_code ?? "?"}): ${payload?.description ?? "unknown error"}`);
}

if (remove) {
  console.log("Webhook deleted.");
} else {
  console.log(`Webhook registered at ${baseUrl}/telegram/webhook`);
  if (!secret) {
    console.warn("warning: TELEGRAM_WEBHOOK_SECRET was empty — the endpoint will accept unauthenticated posts.");
  }
}
