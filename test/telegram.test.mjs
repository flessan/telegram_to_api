/**
 * Tests the Telegram client against a locally mocked Bot API server, so no
 * real token or network access to Telegram is ever needed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { TelegramError, callTelegram, getMe } from "../functions/_lib/telegram.js";
import { FAKE_TOKEN } from "./helpers.mjs";

/** Spins up a mock Telegram API and returns its base URL. */
async function mockTelegram(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function respond(res, status, body) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

test("getMe succeeds against the mock API", async () => {
  const mock = await mockTelegram((req, res) => {
    respond(res, 200, { ok: true, result: { id: 1, is_bot: true, username: "chfless_bot" } });
  });

  try {
    const me = await getMe(FAKE_TOKEN, { baseUrl: mock.baseUrl });
    assert.equal(me.is_bot, true);
    assert.equal(me.username, "chfless_bot");
    // Sanity: the token really is sent in the path to the mock (and only there).
    assert.ok(mock.requests[0].includes("/getMe"));
  } finally {
    await mock.close();
  }
});

test("an invalid token produces a clean, token-free error", async () => {
  const mock = await mockTelegram((req, res) => {
    respond(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
  });

  try {
    await assert.rejects(
      () => getMe(FAKE_TOKEN, { baseUrl: mock.baseUrl }),
      (err) => {
        assert.ok(err instanceof TelegramError);
        assert.equal(err.code, 401);
        assert.match(err.message, /Unauthorized/);
        assert.ok(!err.message.includes(FAKE_TOKEN), "token leaked into the error");
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

test("a Telegram error echoing the token back is redacted", async () => {
  const mock = await mockTelegram((req, res) => {
    // Hostile/buggy upstream that reflects the token in its description.
    respond(res, 400, {
      ok: false,
      error_code: 400,
      description: `bad request for bot${FAKE_TOKEN}`,
    });
  });

  try {
    await assert.rejects(
      () => getMe(FAKE_TOKEN, { baseUrl: mock.baseUrl }),
      (err) => {
        assert.ok(!err.message.includes(FAKE_TOKEN));
        assert.match(err.message, /\[REDACTED\]/);
        return true;
      },
    );
  } finally {
    await mock.close();
  }
});

test("a non-JSON response is reported without crashing", async () => {
  const mock = await mockTelegram((req, res) => {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<html>bad gateway</html>");
  });

  try {
    await assert.rejects(
      () => getMe(FAKE_TOKEN, { baseUrl: mock.baseUrl }),
      /non-JSON response/,
    );
  } finally {
    await mock.close();
  }
});

test("an unreachable API fails cleanly instead of hanging", async () => {
  // Port 1 is reserved and refuses connections immediately.
  await assert.rejects(
    () => getMe(FAKE_TOKEN, { baseUrl: "http://127.0.0.1:1", timeoutMs: 2000 }),
    (err) => {
      assert.match(err.message, /unreachable/);
      assert.ok(!err.message.includes(FAKE_TOKEN));
      return true;
    },
  );
});

test("a slow API is aborted by the timeout", async () => {
  const mock = await mockTelegram(() => {
    /* never responds */
  });

  try {
    await assert.rejects(
      () => callTelegram(FAKE_TOKEN, "getMe", {}, { baseUrl: mock.baseUrl, timeoutMs: 150 }),
      /timed out|unreachable/,
    );
  } finally {
    await mock.close();
  }
});
