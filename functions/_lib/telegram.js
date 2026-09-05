/**
 * Minimal client for the official Telegram Bot API.
 *
 * Only `getMe` is needed at runtime (token verification / diagnostics); posts
 * arrive by webhook rather than polling. The bot token is only ever placed in
 * the outbound request URL to api.telegram.org and is stripped from every
 * error message via `redact`.
 */

import { redact } from "./http.js";

const API_BASE = "https://api.telegram.org";

export class TelegramError extends Error {
  constructor(method, code, description) {
    super(`telegram api ${method} failed (code ${code}): ${description}`);
    this.name = "TelegramError";
    this.code = code;
  }
}

/**
 * Calls a Bot API method with a bounded timeout. Never retries indefinitely.
 */
export async function callTelegram(token, method, params = {}, options = {}) {
  const base = options.baseUrl ?? API_BASE;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const url = new URL(`${base}/bot${token}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url.toString(), { signal: controller.signal });
  } catch (err) {
    const reason = err?.name === "AbortError" ? "request timed out" : "network error";
    throw new Error(`telegram api ${method} unreachable: ${redact(reason, token)}`);
  } finally {
    clearTimeout(timer);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`telegram api ${method} returned a non-JSON response`);
  }

  if (!payload?.ok) {
    throw new TelegramError(
      method,
      payload?.error_code ?? response.status,
      redact(payload?.description ?? "unknown error", token),
    );
  }
  return payload.result;
}

/** Verifies the configured token and returns the bot identity. */
export function getMe(token, options = {}) {
  return callTelegram(token, "getMe", {}, options);
}
