import assert from "node:assert/strict";
import test from "node:test";

import { AgentPhoneAPI } from "../dist/api.js";

// Long-polling (get_call wait/timeout, make_conversation_call
// waitForCompletion/maxWaitSeconds) was removed in tasks#192: the backend has no
// completion wait, so the client no longer arms an extended abort timer. What
// must remain is the ordinary, bounded request timeout on every call.

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

test("get_call arms only the ordinary request timeout (#192)", async () => {
  const delay = await abortDelayFor((api) => api.getCall("call_1"));
  assert.equal(delay, 30_000);
});

test("make_conversation_call arms only the ordinary request timeout (#192)", async () => {
  const delay = await abortDelayFor((api) =>
    api.makeConversationCall("agent_1", "+14155550123", "Prompt"),
  );
  assert.equal(delay, 30_000);
});
