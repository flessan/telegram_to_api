/**
 * Minimal client for the official Telegram Bot API.
 *
 * Only `getMe` is needed at runtime for diagnostics and `getFile` + file
 * download for Discord photo forwarding; posts arrive by webhook rather than
 * polling. The bot token is only ever placed in outbound request URLs to
 * api.telegram.org and is stripped from every error message via `redact`.
 */

import { redact } from "./http.js";

const API_BASE = "https://api.telegram.org";
const FILE_BASE = "https://api.telegram.org";

/** Upper bound for a Telegram file downloaded for Discord forwarding (10 MiB). */
export const MAX_TELEGRAM_FILE_BYTES = 10 * 1024 * 1024;

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

/**
 * Resolves a Telegram `file_id` to a downloadable `file_path` via getFile.
 * Only the single best (largest) rendition's file_id is ever resolved; other
 * sizes are never downloaded.
 */
export function getFile(token, fileId, options = {}) {
  if (!fileId || typeof fileId !== "string") {
    throw new Error("telegram api getFile requires a file_id");
  }
  return callTelegram(token, "getFile", { file_id: fileId }, options);
}

/**
 * Downloads a Telegram file by its `file_path` (as returned by getFile).
 *
 * Returns `{ bytes, contentType, size }` where `bytes` is an ArrayBuffer.
 * The bot token is part of the server-side download URL only and is redacted
 * from every error. Files larger than `maxBytes` are rejected without being
 * buffered, so a huge video can never OOM the isolate.
 */
export async function downloadTelegramFile(token, filePath, options = {}) {
  if (!filePath || typeof filePath !== "string" || filePath.includes("..")) {
    throw new Error("telegram file_path is missing or invalid");
  }
  const clean = filePath.replace(/^\/+/, "");
  if (!clean) throw new Error("telegram file_path is missing or invalid");

  const fileBase = (options.fileBaseUrl ?? options.baseUrl ?? FILE_BASE).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxBytes = options.maxBytes ?? MAX_TELEGRAM_FILE_BYTES;

  const url = `${fileBase}/file/bot${token}/${clean}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`telegram file download failed with status ${response.status}`);
    }
    const announced = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
    if (Number.isFinite(announced) && announced > maxBytes) {
      throw new Error(`telegram file is too large (${announced} bytes)`);
    }
    const contentType = response.headers.get("Content-Type") ?? "application/octet-stream";
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) {
      throw new Error(`telegram file is too large (${bytes.byteLength} bytes)`);
    }
    if (bytes.byteLength === 0) throw new Error("telegram file download returned empty body");
    return { bytes, contentType, size: bytes.byteLength };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error("telegram file download timed out");
    // Never leak the tokenised download URL; messages above contain no secrets,
    // but redact defensively in case fetch throws with the URL attached.
    throw new Error(redact(err?.message ?? "telegram file download failed", token));
  } finally {
    clearTimeout(timer);
  }
}
