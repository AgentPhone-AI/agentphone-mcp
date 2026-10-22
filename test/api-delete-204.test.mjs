import test from "node:test";
import assert from "node:assert/strict";
import { AgentPhoneAPI } from "../dist/api.js";

// Regression for #93: DELETE endpoints that answer 204 (no body) used to flow
// back as {} and fail the tools' required `success` output schema. The API
// client must normalize a non-throwing DELETE to { success: true }.
test("DELETE methods return {success:true} on a 204 no-content response", async () => {
  const original = globalThis.fetch;
  let seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return new Response(null, { status: 204 });
  };
  try {
    const api = new AgentPhoneAPI("https://example.test", "key");
    assert.deepEqual(await api.detachNumber("agt_1", "num_1"), { success: true });
    assert.deepEqual(await api.deleteContact("ct_1"), { success: true });
    assert.deepEqual(await api.deleteWebhook(), { success: true });
    assert.deepEqual(await api.deleteAgentWebhook("agt_1"), { success: true });
    assert.ok(seen.every((s) => s.startsWith("DELETE ")), "all calls were DELETEs");
  } finally {
    globalThis.fetch = original;
  }
});

// Some endpoints answer 200 with an empty body; res.json() would throw there,
// so request() must treat an empty body as {} regardless of status.
test("DELETE methods return {success:true} on a 200 with an empty body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 200 });
  try {
    const api = new AgentPhoneAPI("https://example.test", "key");
    assert.deepEqual(await api.detachNumber("agt_1", "num_1"), { success: true });
    assert.deepEqual(await api.deleteContact("ct_1"), { success: true });
  } finally {
    globalThis.fetch = original;
  }
});

// And a non-empty body still passes through untouched (e.g. deleteAgent).
test("a DELETE that returns a JSON body is passed through", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: true, id: "agt_1", name: "Support" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    const api = new AgentPhoneAPI("https://example.test", "key");
    assert.deepEqual(await api.deleteAgent("agt_1"), { success: true, id: "agt_1", name: "Support" });
  } finally {
    globalThis.fetch = original;
  }
});
