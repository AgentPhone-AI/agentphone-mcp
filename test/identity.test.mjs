import assert from "node:assert/strict";
import test from "node:test";
import { makeIdentify, IDENTITY_TTL_MS, IDENTITY_FAIL_TTL_MS } from "../dist/identity.js";

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

test("a rejected credential (401) is anonymous for the full TTL", async () => {
  const { identify, state } = rig({
    credential: () => "sk_live_bad",
    lookup: async () => {
      const err = new Error("unauthorized");
      err.status = 401;
      throw err;
    },
  });
  assert.equal(await identify(), undefined);
  state.now += IDENTITY_FAIL_TTL_MS + 1; // past the short window…
  assert.equal(await identify(), undefined);
  assert.equal(state.calls.length, 1); // …but still cached: 401 holds for the full TTL
  state.now += IDENTITY_TTL_MS;
  assert.equal(await identify(), undefined);
  assert.equal(state.calls.length, 2);
});

test("a transient failure is anonymous only for the short TTL", async () => {
  let fail = true;
  const { identify, state } = rig({
    credential: () => "sk_live_a",
    lookup: async () => {
      if (fail) throw new Error("backend unreachable");
      return "acct-1";
    },
  });
  assert.equal(await identify(), undefined);
  assert.equal(await identify(), undefined); // cached failure: no hammering
  assert.equal(state.calls.length, 1);
  fail = false;
  state.now += IDENTITY_FAIL_TTL_MS + 1;
  assert.deepEqual(await identify(), { user: "acct-1" });
  assert.equal(state.calls.length, 2);
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
