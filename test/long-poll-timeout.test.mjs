import assert from "node:assert/strict";
import test from "node:test";

import { AgentPhoneAPI } from "../dist/api.js";

// Runs `action` with fetch stubbed to answer immediately, and returns the delay
// of the timer the client arms to abort the request.
async function abortDelayFor(action) {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ id: "call_1", transcripts: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.setTimeout = (fn, delay, ...rest) => {
    delays.push(delay);
    return realSetTimeout(fn, delay, ...rest);
  };
  try {
    await action(new AgentPhoneAPI("http://localhost:1", "test-key"));
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(delays.length, 1);
  return delays[0];
}

test("get_call long-poll abort timer outlasts a full-length server wait", async () => {
  const delay = await abortDelayFor((api) => api.getCall("call_1", { wait: true, timeout: 300 }));
  assert.ok(delay > 300_000, `abort timer ${delay}ms must exceed the 300s server wait`);
});

test("get_call long-poll abort timer follows the requested wait, not the maximum", async () => {
  const delay = await abortDelayFor((api) => api.getCall("call_1", { wait: true, timeout: 10 }));
  assert.ok(delay > 10_000, `abort timer ${delay}ms must exceed the 10s server wait`);
  assert.ok(delay < 60_000, `abort timer ${delay}ms should not hold the socket for the 300s maximum`);
});

test("get_call without wait keeps the default request timeout", async () => {
  const delay = await abortDelayFor((api) => api.getCall("call_1"));
  assert.equal(delay, 30_000);
});

test("make_conversation_call abort timer outlasts a full-length server wait", async () => {
  const delay = await abortDelayFor((api) =>
    api.makeConversationCall("agent_1", "+14155550123", "Prompt", undefined, true, 600),
  );
  assert.ok(delay > 600_000, `abort timer ${delay}ms must exceed the 600s server wait`);
});

test("make_conversation_call abort timer follows max_wait_seconds", async () => {
  const delay = await abortDelayFor((api) =>
    api.makeConversationCall("agent_1", "+14155550123", "Prompt", undefined, true, 20),
  );
  assert.ok(delay > 20_000 && delay < 120_000, `abort timer ${delay}ms should track the 20s wait`);
});
