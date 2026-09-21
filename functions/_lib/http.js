/**
 * Shared HTTP concerns for the public JSON endpoints: CORS, caching,
 * security headers and safe (secret-free) error responses.
 */

/**
 * Removes anything that looks like a bot token from a string before it can
 * reach a log line or an HTTP response body.
 *
 * Three layers of defence:
 *   1. exact match on the configured token (if provided),
 *   2. a generic pattern matching Telegram's `<digits>:<35+ chars>` format,
 *      which also catches tokens embedded in URLs like `/bot123:ABC/getMe`,
 *   3. Discord Incoming Webhook tokens embedded in webhook URLs
 *      (`/api/webhooks/<id>/<token>`), where only the `<id>` is kept.
 */
export function redact(value, token) {
  let text = typeof value === "string" ? value : String(value ?? "");
  if (token) text = text.split(token).join("[REDACTED]");
  // No \b anchors: a token embedded directly after "bot" (as in
  // ".../bot123456:ABC.../getMe") has no word boundary before the digits.
  text = text.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[REDACTED]");
  // Discord webhook tokens: keep the numeric webhook id for diagnostics,
  // redact the secret token segment (stops before ? & whitespace quotes).
  return text.replace(/(\/api\/webhooks\/\d+\/)[A-Za-z0-9_.-]+/g, "$1[REDACTED]");
}

/**
 * Resolves the CORS `Access-Control-Allow-Origin` value.
 *
 * ALLOWED_ORIGINS is a comma-separated allowlist, e.g.
 * "https://thio.qzz.io,https://www.thio.qzz.io". When it is unset or "*" the
 * feed is treated as fully public (it is public channel content anyway), but
 * configuring an explicit allowlist is recommended and documented.
 */
export function resolveOrigin(request, allowedOrigins) {
  const configured = (allowedOrigins ?? "").trim();
  const requestOrigin = request.headers.get("Origin");

  if (configured === "" || configured === "*") return "*";

  const allowlist = configured
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (requestOrigin && allowlist.includes(requestOrigin)) return requestOrigin;
  // Not allowed: fall back to the first configured origin so the browser
  // blocks the read rather than receiving a permissive wildcard.
  return allowlist[0] ?? "null";
}

export function corsHeaders(request, env) {
  const origin = resolveOrigin(request, env?.ALLOWED_ORIGINS);
  const headers = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  // Responses differ per Origin whenever an allowlist is in play, so caches
  // must key on it.
  if (origin !== "*") headers.Vary = "Origin";
  return headers;
}

/** Conservative headers appropriate for a read-only JSON endpoint. */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

/**
 * Cache policy: short TTL plus stale-while-revalidate so the endpoint is
 * cheap and fast but never permanently stale. CACHE_TTL_SECONDS overrides it.
 */
export function cacheHeaders(env) {
  const raw = Number.parseInt(env?.CACHE_TTL_SECONDS ?? "", 10);
  const ttl = Number.isFinite(raw) && raw >= 0 ? raw : 60;
  return {
    "Cache-Control": `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=300`,
  };
}

/** Deterministic, human-readable JSON with a trailing newline (like the Go writer). */
export function serialize(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

export function jsonResponse(request, env, body, status = 200, extraHeaders = {}) {
  return new Response(serialize(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
      ...SECURITY_HEADERS,
      ...cacheHeaders(env),
      ...extraHeaders,
    },
  });
}

/**
 * Error responses are never cached and never contain secrets.
 */
export function errorResponse(request, env, status, message) {
  return new Response(
    serialize({ error: redact(message, env?.TELEGRAM_BOT_TOKEN) }),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...corsHeaders(request, env),
        ...SECURITY_HEADERS,
        "Cache-Control": "no-store",
      },
    },
  );
}

/** Preflight handler. */
export function preflight(request, env) {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(request, env), ...SECURITY_HEADERS },
  });
}
