import assert from "node:assert/strict";
import test from "node:test";
import { AgentPhoneAPI, ApiError } from "../dist/api.js";
import { classifyRecovery } from "../dist/recovery.js";
import { registerTools } from "../dist/tools.js";

const KEY = "opaque-test-credential-123456";
const sendArgs = { agent_id: "agent_1", to_number: "+14155550123", body: "hello" };

function toolsFor(api) {
  const handlers = new Map();
  registerTools({
    tool(name, _description, _schema, annotationsOrHandler, handler) {
      handlers.set(name, handler ?? annotationsOrHandler);
    },
  }, api);
  return (name, args) => handlers.get(name)(args);
}

async function withFetch(fetcher, action) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return fetcher(...args);
  };
  try {
    return await action(new AgentPhoneAPI("https://example.test", KEY), calls);
  } finally {
    globalThis.fetch = original;
  }
}

function response(status, body, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

test("documented error envelope retains message, field errors, code and request ID", async () => {
  await withFetch(() => response(422, {
    error: {
      code: "VALIDATION_ERROR", message: "Check the destination",
      details: [{ field: "to_number", message: "must be a phone number" }],
    },
    request_id: "request-body-123",
  }), async (api) => {
    await assert.rejects(api.sendMessage({ body: "hello" }), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, "http");
      assert.equal(error.code, "VALIDATION_ERROR");
      assert.equal(error.requestId, "request-body-123");
      assert.equal(error.detail, "Check the destination (VALIDATION_ERROR); to_number: must be a phone number");
      return true;
    });
    const result = await toolsFor(api)("send_message", sendArgs);
    assert.match(result.content[0].text, /Check the destination.*to_number: must be a phone number/);
    assert.match(result.content[0].text, /Request ID: request-body-123/);
  });
});

test("non-JSON errors retain their text and a bounded header request ID", async () => {
  await withFetch(() => response(502, "upstream unavailable", { "x-request-id": "req-header-1" }), async (api) => {
    const result = await toolsFor(api)("make_call", sendArgs);
    assert.match(result.content[0].text, /upstream unavailable/);
    assert.match(result.content[0].text, /Request ID: req-header-1/);
  });
  for (const id of ["x".repeat(129), { unexpected: "object" }, "Bearer credential-value"]) {
    await withFetch(() => response(400, { detail: "invalid", request_id: id }), async (api) => {
      await assert.rejects(api.getCall("call_1"), (error) => {
        assert.equal(error.requestId, null);
        return true;
      });
    });
  }
});

test("error text and newly retained metadata do not expose credentials", async () => {
  await withFetch(() => response(429, {
    error: {
      code: KEY,
      message: `credential ${KEY}, Bearer abc+def/ghi=123~x`,
      details: [{ field: "token", message: "sk_live_abcdef123456 rejected" }],
    },
    request_id: KEY,
  }, { "x-request-id": "sk_live_header123456", "retry-after": KEY }), async (api) => {
    await assert.rejects(api.sendMessage({ body: "hello" }), (error) => {
      assert.equal(error.code, null);
      assert.equal(error.requestId, null);
      assert.doesNotMatch(JSON.stringify(error), /opaque-test|abcdef123456|header123456|abc\+def/);
      return true;
    });
    const result = await toolsFor(api)("send_message", sendArgs);
    assert.doesNotMatch(JSON.stringify(result), /opaque-test|abcdef123456|header123456|abc\+def/);
    assert.match(result.content[0].text, /not recognized/);
  });
});

const failures = [
  ["timeout", () => { throw new DOMException("aborted", "AbortError"); }],
  ["connection loss", () => { throw new TypeError(`fetch failed with ${KEY}`); }],
  ["body connection loss", () => ({ text: async () => { throw new TypeError(`terminated ${KEY}`); } })],
  ["malformed success response", () => response(200, `${KEY} is not JSON`)],
  ...[500, 502, 503, 504].map((status) => [String(status), () => response(status, { detail: "upstream error" })]),
];

for (const [label, fetcher] of failures) {
  for (const [tool, args] of [
    ["send_message", sendArgs],
    ["make_call", sendArgs],
    ["make_conversation_call", { ...sendArgs, topic: "Schedule a visit" }],
  ]) {
    test(`${tool}: ${label} has unknown outcome and performs exactly one request`, async () => {
      await withFetch(fetcher, async (api, calls) => {
        const result = await toolsFor(api)(tool, args);
        assert.equal(result.isError, true);
        assert.equal(result.structuredContent, undefined);
        assert.match(result.content[0].text, /outcome is UNKNOWN/);
        assert.match(result.content[0].text, /Do NOT blindly retry/);
        assert.match(result.content[0].text, /empty history or missing record is not proof/);
        assert.doesNotMatch(result.content[0].text, /opaque-/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0][1].method, "POST");
      });
    });
  }
  for (const tool of ["get_call", "end_call"]) {
    test(`${tool}: ${label} allows a bounded retry`, async () => {
      await withFetch(fetcher, async (api, calls) => {
        const result = await toolsFor(api)(tool, { call_id: "call_1" });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /bounded backoff/);
        assert.doesNotMatch(result.content[0].text, /UNKNOWN|Do NOT blindly retry/);
        assert.doesNotMatch(JSON.stringify(result), /opaque-/);
        if (tool === "end_call") assert.match(result.content[0].text, /same call ID/);
        assert.equal(calls.length, 1);
      });
    });
  }
}

test("DELIVERY_UNCONFIRMED is ambiguous even though it is a 409", async () => {
  await withFetch(() => response(409, {
    error: { code: "DELIVERY_UNCONFIRMED", message: "The message may already have been sent" },
    request_id: "req-unconfirmed",
  }), async (api, calls) => {
    const result = await toolsFor(api)("send_message", sendArgs);
    assert.match(result.content[0].text, /may already have been sent \(DELIVERY_UNCONFIRMED\)/);
    assert.match(result.content[0].text, /outcome is UNKNOWN/);
    assert.match(result.content[0].text, /empty history or missing record is not proof/);
    assert.match(result.content[0].text, /Request ID: req-unconfirmed/);
    assert.equal(calls.length, 1);
  });
});

const limits = [
  ["OUTBOUND_LIMIT_REACHED", "daily window to reset"],
  ["NEW_CONVERSATION_LIMIT_REACHED", "daily window to reset"],
  ["CONVERSATION_STREAK_LIMIT", "recipient to reply"],
  ["CONVERSATION_AWAITING_REPLY", "recipient to reply"],
  ["CONVERSATION_INACTIVE", "recipient to reply"],
  ["RATE_LIMITED", "bounded backoff"],
  ["UNKNOWN_LIMIT", "not recognized"],
];
for (const [code, expected] of limits) {
  test(`429 ${code} gives the appropriate recovery without retrying`, async () => {
    await withFetch(() => response(429, { error: { code, message: "Request rejected" } }), async (api, calls) => {
      const result = await toolsFor(api)("send_message", sendArgs);
      assert.match(result.content[0].text, new RegExp(expected));
      assert.doesNotMatch(result.content[0].text, /wait a moment|outcome is UNKNOWN/);
      assert.equal(calls.length, 1);
    });
  });
}

for (const retryAfter of ["30", "Fri, 30 Oct 2026 12:00:00 GMT"]) {
  test(`endpoint throttle honors Retry-After ${retryAfter}`, async () => {
    await withFetch(() => response(429, { detail: "Too many requests" }, { "retry-after": retryAfter }), async (api, calls) => {
      const result = await toolsFor(api)("send_message", sendArgs);
      assert.ok(result.content[0].text.includes(`wait ${retryAfter} (per Retry-After)`));
      assert.match(result.content[0].text, /bounded retries/);
      assert.equal(calls.length, 1);
    });
  });
}

test("known caps override Retry-After and unknown 429s never promise a retry will work", async () => {
  for (const [code, after, expected] of [
    ["OUTBOUND_LIMIT_REACHED", "30", "wait_for_reset"],
    ["CONVERSATION_AWAITING_REPLY", "30", "wait_for_reply"],
    ["UNKNOWN_LIMIT", "30", "investigate"],
    [null, null, "investigate"],
    [null, "soon", "investigate"],
  ]) {
    const error = new ApiError(429, "POST", "/v1/messages", "limited", after, { code });
    assert.equal(classifyRecovery(error).action, expected);
  }
});

test("only the documented call concurrency rejection gets wait-for-call guidance", async () => {
  const detail = "Concurrent outbound call limit reached (3). Please wait for an active call to end.";
  await withFetch(() => response(429, { detail }), async (api, calls) => {
    const result = await toolsFor(api)("make_call", sendArgs);
    assert.match(result.content[0].text, /Wait for an active call to finish/);
    assert.equal(calls.length, 1);
  });
  assert.equal(classifyRecovery(new ApiError(429, "POST", "/v1/messages", detail)).action, "investigate");
  assert.equal(classifyRecovery(new ApiError(429, "POST", "/v1/calls", "Unknown call limit")).action, "investigate");
});

test("transport errors retain method and path without raw exception content", async () => {
  await withFetch(() => { throw new TypeError(`socket failed ${KEY}`); }, async (api) => {
    await assert.rejects(api.makeCall("agent_1", "+14155550123"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, "transport");
      assert.equal(error.method, "POST");
      assert.equal(error.path, "/v1/calls");
      assert.doesNotMatch(error.message, /opaque-test/);
      return true;
    });
  });
});

test("malformed success responses retain status and operation without response content", async () => {
  for (const status of [200, 201, 202]) {
    await withFetch(() => response(status, `${KEY} is not JSON`, { "x-request-id": "req-malformed" }), async (api, calls) => {
      await assert.rejects(api.makeCall("agent_1", "+14155550123"), (error) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.kind, "invalid-response");
        assert.equal(error.status, status);
        assert.equal(error.method, "POST");
        assert.equal(error.path, "/v1/calls");
        assert.equal(error.detail, "The server returned an invalid JSON response");
        assert.equal(error.requestId, "req-malformed");
        assert.doesNotMatch(error.message + JSON.stringify(error), /opaque-|is not JSON/);
        return true;
      });
      assert.equal(calls.length, 1);
    });
  }
});

test("serialization and ordinary programming errors are not response or transport failures", async () => {
  const circular = {};
  circular.self = circular;
  await withFetch(() => response(200, {}), async (api, calls) => {
    await assert.rejects(api.sendMessage({ body: circular }), (error) => error instanceof TypeError && !(error instanceof ApiError));
    assert.equal(calls.length, 0);
  });
  const bug = new Error("unexpected local bug");
  await withFetch(() => { throw bug; }, async (api) => {
    await assert.rejects(api.getCall("call_1"), (error) => error === bug);
  });
});

test("HEAD reads may retry but other writes do not inherit end_call idempotence", () => {
  assert.equal(classifyRecovery(new ApiError(503, "HEAD", "/v1/calls", "unavailable")).action, "retry_read");
  for (const [method, path] of [
    ["DELETE", "/v1/contacts/contact_1"],
    ["PATCH", "/v1/agents/agent_1"],
    ["POST", "/v1/calls/call_1/other"],
  ]) {
    assert.equal(classifyRecovery(new ApiError(503, method, path, "unavailable")).action, "reconcile");
  }
});
