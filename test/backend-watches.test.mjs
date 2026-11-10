import assert from "node:assert/strict";
import test from "node:test";
import { makeWatchRegistrar, WATCH_REGISTER_PATH } from "../dist/backend-watches.js";
import { signingKey, verify } from "../dist/backend-events.js";

// A valid Standard Webhooks secret: whsec_ + base64 of >=24 bytes.
const SECRET = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const KEY = signingKey(SECRET);
const BASE = "https://api.example.test";

// Swap in a fake fetch for one call, capturing the request it was given.
async function withFetch(impl, run) {
  const real = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return impl(url, init);
  };
  try {
    return { result: await run(), captured };
  } finally {
    globalThis.fetch = real;
  }
}

const reply = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => {
    if (body === undefined) throw new Error("no body");
    return body;
  },
});

test("registers a watch with a valid Standard Webhooks signature", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result, captured } = await withFetch(
    () => reply(200, { number_id: "num_1", watched: true, expires_at: "2026-01-01T00:00:00Z" }),
    () => reg("num_1", 900)
  );
  assert.equal(result, "watched");
  assert.equal(captured.length, 1);
  const { url, init } = captured[0];
  assert.equal(url, `${BASE}${WATCH_REGISTER_PATH}`);
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { number_id: "num_1", ttl_seconds: 900 });
  // The signature the registrar produced must verify against the same key.
  const h = {
    id: init.headers["webhook-id"],
    timestamp: init.headers["webhook-timestamp"],
    signature: init.headers["webhook-signature"],
  };
  assert.ok(h.id && /^\d+$/.test(h.timestamp) && h.signature.startsWith("v1,"));
  assert.equal(verify(KEY, h, init.body), true, "signature must verify");
  // A different key must NOT verify it.
  const otherKey = signingKey("whsec_" + Buffer.from("ffffffffffffffffffffffffffffffff").toString("base64"));
  assert.equal(verify(otherKey, h, init.body), false);
});

test("each request uses a fresh webhook-id", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { captured } = await withFetch(
    () => reply(200, { watched: true }),
    async () => {
      await reg("num_1", 900);
      await reg("num_1", 900);
    }
  );
  assert.notEqual(captured[0].init.headers["webhook-id"], captured[1].init.headers["webhook-id"]);
});

test("200 with watched:false is reported as not_watched (e.g. a ttl=0 drop)", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result } = await withFetch(() => reply(200, { watched: false }), () => reg("num_1", 0));
  assert.equal(result, "not_watched");
});

test("a 2xx without a JSON body still counts as watched", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result } = await withFetch(() => reply(204, undefined), () => reg("num_1", 900));
  assert.equal(result, "watched");
});

test("404 means the filter isn't enabled — reported as disabled, not an error", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result } = await withFetch(() => reply(404, { error: "no_secret" }), () => reg("num_1", 900));
  assert.equal(result, "disabled");
});

test("401 and 422 are reported as rejected", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result: r401 } = await withFetch(() => reply(401, {}), () => reg("num_1", 900));
  const { result: r422 } = await withFetch(() => reply(422, {}), () => reg("num_1", 900));
  assert.equal(r401, "rejected");
  assert.equal(r422, "rejected");
});

test("a 5xx is reported as error", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result } = await withFetch(() => reply(503, {}), () => reg("num_1", 900));
  assert.equal(result, "error");
});

test("a network failure never throws — reported as error", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result } = await withFetch(
    () => {
      throw new Error("ECONNREFUSED");
    },
    () => reg("num_1", 900)
  );
  assert.equal(result, "error");
});

test("a trailing slash on the base URL is not doubled", async () => {
  const reg = makeWatchRegistrar({ baseUrl: BASE + "/", key: KEY });
  const { captured } = await withFetch(() => reply(200, { watched: true }), () => reg("num_1", 900));
  assert.equal(captured[0].url, `${BASE}${WATCH_REGISTER_PATH}`);
});

// ---------------------------------------------------------------------------
// makeWatchRefresher: slides a watch on delivery, mirroring Wakeshift's idle
// timeout, throttled per number so a busy number doesn't POST on every message.
// ---------------------------------------------------------------------------
import { makeWatchRefresher } from "../dist/backend-watches.js";

test("refresher re-registers on first delivery for a number", async () => {
  const calls = [];
  const refresh = makeWatchRefresher(async (id, ttl) => { calls.push([id, ttl]); return "watched"; }, 86400, 60_000);
  refresh("num_1");
  await Promise.resolve();
  assert.deepEqual(calls, [["num_1", 86400]]);
});

test("refresher throttles repeat deliveries within the interval, then slides again after it", async () => {
  const calls = [];
  const refresh = makeWatchRefresher(async (id) => { calls.push(id); return "watched"; }, 86400, 60_000);
  let now = 1_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    refresh("num_1");            // slides
    refresh("num_1");            // throttled
    now += 30_000;
    refresh("num_1");            // still within 60s window -> throttled
    now += 31_000;               // now 61s since first slide
    refresh("num_1");            // slides again
    await Promise.resolve();
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(calls, ["num_1", "num_1"]);
});

test("refresher throttles per number independently", async () => {
  const calls = [];
  const refresh = makeWatchRefresher(async (id) => { calls.push(id); return "watched"; }, 86400, 60_000);
  refresh("num_1");
  refresh("num_2");
  refresh("num_1"); // throttled
  await Promise.resolve();
  assert.deepEqual(calls.sort(), ["num_1", "num_2"]);
});

test("refresher never throws even if the registrar rejects", () => {
  const refresh = makeWatchRefresher(async () => { throw new Error("boom"); }, 86400, 60_000);
  assert.doesNotThrow(() => refresh("num_1"));
});

test("drains the response body on a non-2xx path so the socket is freed", async () => {
  let cancelled = false;
  const replyWithBody = (status) => ({
    status,
    ok: status >= 200 && status < 300,
    bodyUsed: false,
    body: { cancel: async () => { cancelled = true; } },
    json: async () => ({}),
  });
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const { result } = await withFetch(() => replyWithBody(404), () => reg("num_1", 900));
  assert.equal(result, "disabled");
  assert.equal(cancelled, true, "the unread 404 body must be cancelled");
});

test("does not cancel a body it already read on a 2xx", async () => {
  let cancelled = false;
  const reg = makeWatchRegistrar({ baseUrl: BASE, key: KEY });
  const okWithBody = {
    status: 200,
    ok: true,
    bodyUsed: false,
    body: { cancel: async () => { cancelled = true; } },
    json: async function () { this.bodyUsed = true; return { watched: true }; },
  };
  const { result } = await withFetch(() => okWithBody, () => reg("num_1", 900));
  assert.equal(result, "watched");
  assert.equal(cancelled, false, "a body consumed by json() is not cancelled again");
});

// ---------------------------------------------------------------------------
// makeEmitAndRefresh: slide the watch only when the delivery reached a live
// Wakeshift subscription, so unwatched numbers are never registered.
// ---------------------------------------------------------------------------
import { makeEmitAndRefresh } from "../dist/backend-watches.js";

test("refreshes the watch when a delivery reached a subscription (matched > 0)", async () => {
  const refreshed = [];
  const wrapped = makeEmitAndRefresh(
    async (b) => ({ matched: 2, number_id: b.number_id }),
    (id) => refreshed.push(id)
  );
  const out = await wrapped({ number_id: "num_1" });
  assert.equal(out.matched, 2);
  assert.deepEqual(refreshed, ["num_1"]);
});

test("does NOT refresh when the delivery reached no subscription (matched === 0)", async () => {
  const refreshed = [];
  const wrapped = makeEmitAndRefresh(
    async (b) => ({ matched: 0, number_id: b.number_id }),
    (id) => refreshed.push(id)
  );
  const out = await wrapped({ number_id: "num_unwatched" });
  assert.equal(out.matched, 0);
  assert.deepEqual(refreshed, [], "an unwatched number must not be registered");
});

test("returns the emit result unchanged (still a valid emit callback)", async () => {
  const emitted = { matched: 1, duplicate: false, number_id: "num_1" };
  const wrapped = makeEmitAndRefresh(async () => emitted, () => {});
  assert.equal(await wrapped({ number_id: "num_1" }), emitted);
});
