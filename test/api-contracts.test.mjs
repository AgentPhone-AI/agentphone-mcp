import test from "node:test";
import assert from "node:assert/strict";
import { AgentPhoneAPI } from "../dist/api.js";

function withFetch(body, fn) {
  return async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    try {
      await fn(new AgentPhoneAPI("https://example.test", "key"));
    } finally {
      globalThis.fetch = original;
    }
  };
}

// #190 finding 11: the deployed MessageResponse exposes the sender as `from_`;
// the client must normalize it to `from` so the formatter/schema see it.
test(
  "getMessages normalizes the sender field from_ -> from",
  withFetch(
    { data: [{ id: "m1", from_: "+14155550001", to: "+14155550002", body: "hi", receivedAt: "t" }], hasMore: false },
    async (api) => {
      const res = await api.getMessages("num_1");
      assert.equal(res.data[0].from, "+14155550001");
    }
  )
);

test(
  "getMessages keeps `from` when the API already uses it",
  withFetch(
    { data: [{ id: "m1", from: "+14155550003", to: "+14155550002", body: "hi", receivedAt: "t" }], hasMore: false },
    async (api) => {
      const res = await api.getMessages("num_1");
      assert.equal(res.data[0].from, "+14155550003");
    }
  )
);
