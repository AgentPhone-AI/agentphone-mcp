import assert from "node:assert/strict";
import test from "node:test";
import {
  makeCredentialResolver,
  makeIdentify,
  IDENTITY_TTL_MS,
  IDENTITY_FAIL_TTL_MS,
} from "../dist/identity.js";

// A Hono-style request context: auth lives behind get("auth"), never as a
// property. This is what mcp-use's getRequestContext() actually returns.
const honoCtx = (vars = {}) => ({ get: (k) => vars[k], req: {} });

test("credential resolver, OAuth: a handler ctx is validated auth only, fail closed", () => {
  const resolve = makeCredentialResolver({
    oauth: true,
    requestContext: () => honoCtx({ auth: { accessToken: "ctx-store-token" } }),
    authorizationHeader: () => "Bearer raw-token",
  });
  assert.equal(resolve({ auth: { accessToken: "validated" } }), "validated");
  // ctx passed but carries no validated auth: no fallback to header or store.
  assert.equal(resolve({}), "");
});

test("credential resolver, OAuth identify path: reads Hono's auth var (get), not a property", () => {
  const resolve = makeCredentialResolver({
    oauth: true,
    requestContext: () => honoCtx({ auth: { accessToken: "oauth-token" } }),
    authorizationHeader: () => "Bearer oauth-token",
  });
  assert.equal(resolve(), "oauth-token");
});

test("credential resolver, OAuth identify path: falls back to the Bearer header", () => {
  // Context reachable but without the auth var (shape drift), then no context at all.
  const withBareCtx = makeCredentialResolver({
    oauth: true,
    requestContext: () => honoCtx(),
    authorizationHeader: () => "Bearer header-token",
  });
  assert.equal(withBareCtx(), "header-token");
  const throwingCtx = makeCredentialResolver({
    oauth: true,
    requestContext: () => {
      throw new Error("no request");
    },
    authorizationHeader: () => null,
  });
  assert.equal(throwingCtx(), ""); // null header = no reachable request: fail closed
});

test("credential resolver, non-OAuth: bearer, malformed, anonymous fallback", () => {
  const make = (header, allowAnonymous) =>
    makeCredentialResolver({
      oauth: false,
      requestContext: () => honoCtx(),
      authorizationHeader: () => header,
      allowAnonymous,
      serverApiKey: "sk_live_server",
    });
  assert.equal(make("Bearer sk_live_caller", false)(), "sk_live_caller");
  assert.equal(make("Basic nope", true)(), ""); // malformed is never the fallback key
  assert.equal(make(undefined, true)(), "sk_live_server"); // headerless + opted in
  assert.equal(make(undefined, false)(), "");
  assert.equal(make(null, true)(), ""); // no request context: fail closed
});

// A controllable clock and a lookup that records its calls.
function rig({ credential, lookup }) {
  const state = { now: 1_000_000, calls: [] };
  const identify = makeIdentify({
    credential,
    lookup: async (c) => {
      state.calls.push(c);
      return lookup(c);
    },
    now: () => state.now,
  });
  return { identify, state };
}

test("no credential is anonymous and never looked up", async () => {
  const { identify, state } = rig({ credential: () => "", lookup: async () => "acct" });
  assert.equal(await identify(), undefined);
  assert.equal(state.calls.length, 0);
});

test("a throwing credential getter is anonymous, not an error", async () => {
  const { identify, state } = rig({
    credential: () => {
      throw new Error("no request context");
    },
    lookup: async () => "acct",
  });
  assert.equal(await identify(), undefined);
  assert.equal(state.calls.length, 0);
});

test("resolves the account and caches it per credential", async () => {
  const { identify, state } = rig({ credential: () => "sk_live_a", lookup: async () => "acct-1" });
  assert.deepEqual(await identify(), { user: "acct-1" });
  assert.deepEqual(await identify(), { user: "acct-1" });
  assert.equal(state.calls.length, 1);
  // The raw credential reaches the lookup (it must authenticate the request)…
  assert.equal(state.calls[0], "sk_live_a");
});

test("concurrent calls for one credential share a single lookup", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { identify, state } = rig({
    credential: () => "sk_live_a",
    lookup: () => gate.then(() => "acct-1"),
  });
  const [a, b] = [identify(), identify()];
  release();
  assert.deepEqual(await a, { user: "acct-1" });
  assert.deepEqual(await b, { user: "acct-1" });
  assert.equal(state.calls.length, 1);
});

test("expires after the TTL and resolves again", async () => {
  let user = "acct-1";
  const { identify, state } = rig({ credential: () => "sk_live_a", lookup: async () => user });
  assert.deepEqual(await identify(), { user: "acct-1" });
  user = "acct-2"; // same credential re-resolved (say, after a key moved accounts)
  state.now += IDENTITY_TTL_MS - 1;
  assert.deepEqual(await identify(), { user: "acct-1" });
  state.now += 2;
  assert.deepEqual(await identify(), { user: "acct-2" });
  assert.equal(state.calls.length, 2);
});

for (const status of [401, 403]) {
  test(`a rejected credential (${status}) is anonymous, and only for the short TTL`, async () => {
    let valid = false;
    const { identify, state } = rig({
      credential: () => "sk_live_rotated",
      lookup: async () => {
        if (!valid) {
          const err = new Error("rejected");
          err.status = status;
          throw err;
        }
        return "acct-1";
      },
    });
    assert.equal(await identify(), undefined); // rejected resolves, never throws
    assert.equal(await identify(), undefined); // cached: no hammering
    assert.equal(state.calls.length, 1);
    // One stray rejection against a just-rotated token must not strand it:
    // once the backend accepts the same bytes, the short TTL lets them resolve.
    valid = true;
    state.now += IDENTITY_FAIL_TTL_MS + 1;
    assert.deepEqual(await identify(), { user: "acct-1" });
    assert.equal(state.calls.length, 2);
  });
}

test("the cache is bounded: past the cap, the oldest credential is evicted", async () => {
  let current = "";
  const { identify, state } = rig({
    credential: () => current,
    lookup: async (c) => "acct-of-" + c,
  });
  // Fill past the 10,000-entry cap with distinct live credentials.
  for (let i = 0; i <= 10_000; i++) {
    current = "cred-" + i;
    await identify();
  }
  assert.equal(state.calls.length, 10_001);
  // cred-0 was evicted to stay within the cap, so it is looked up again even
  // though its TTL has not passed.
  current = "cred-0";
  assert.deepEqual(await identify(), { user: "acct-of-cred-0" });
  assert.equal(state.calls.length, 10_002);
  // A later entry is still cached.
  current = "cred-9000";
  await identify();
  assert.equal(state.calls.length, 10_002);
});

test("a 404 (backend without /v1/me yet) is anonymous, so this server can deploy first", async () => {
  const { identify, state } = rig({
    credential: () => "sk_live_a",
    lookup: async () => {
      const err = new Error("Not Found");
      err.status = 404;
      throw err;
    },
  });
  assert.equal(await identify(), undefined);
  assert.equal(state.calls.length, 1);
});

test("a transient failure rethrows (cached too), then recovers after the short TTL", async () => {
  let fail = true;
  const { identify, state } = rig({
    credential: () => "sk_live_a",
    lookup: async () => {
      if (fail) throw new Error("backend unreachable");
      return "acct-1";
    },
  });
  // Throwing (not anonymous) keeps Wakeshift on its retryable path: a stream
  // isn't revoked and no session-bound voucher is silently handed out.
  await assert.rejects(identify, /backend unreachable/);
  await assert.rejects(identify, /backend unreachable/); // cached failure rethrows
  assert.equal(state.calls.length, 1);
  fail = false;
  state.now += IDENTITY_FAIL_TTL_MS + 1;
  assert.deepEqual(await identify(), { user: "acct-1" });
  assert.equal(state.calls.length, 2);
});

test("concurrent calls share a failing lookup's rejection", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { identify, state } = rig({
    credential: () => "sk_live_a",
    lookup: () => gate.then(() => Promise.reject(new Error("boom"))),
  });
  const [a, b] = [identify(), identify()];
  release();
  await assert.rejects(() => a, /boom/);
  await assert.rejects(() => b, /boom/);
  assert.equal(state.calls.length, 1);
});

test("a synchronously throwing lookup cannot poison the in-flight map", async () => {
  let fail = true;
  const state = { now: 1_000_000, calls: 0 };
  const identify = makeIdentify({
    credential: () => "sk_live_a",
    // Throws synchronously (no async wrapper): cleanup must still run after
    // the in-flight registration, or every later call returns this failure.
    lookup: (c) => {
      state.calls++;
      if (fail) throw new Error("sync boom");
      return Promise.resolve("acct-1");
    },
    now: () => state.now,
  });
  await assert.rejects(identify, /sync boom/);
  fail = false;
  state.now += IDENTITY_FAIL_TTL_MS + 1;
  assert.deepEqual(await identify(), { user: "acct-1" });
  assert.equal(state.calls, 2);
});

test("different credentials resolve independently", async () => {
  let current = "sk_live_a";
  const { identify, state } = rig({
    credential: () => current,
    lookup: async (c) => (c === "sk_live_a" ? "acct-a" : "acct-b"),
  });
  assert.deepEqual(await identify(), { user: "acct-a" });
  current = "sk_live_b";
  assert.deepEqual(await identify(), { user: "acct-b" });
  assert.equal(state.calls.length, 2);
});
