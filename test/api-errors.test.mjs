import test from "node:test";
import assert from "node:assert/strict";
import { AgentPhoneAPI, ApiError } from "../dist/api.js";

function withErrorResponse(status, body, headers, fn) {
  return async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...(headers || {}) },
      });
    try {
      await fn(new AgentPhoneAPI("https://example.test", "key"));
    } finally {
      globalThis.fetch = original;
    }
  };
}

// #197 finding 13: parse the structured error envelope into actionable text.
test(
  "formats a structured validation error envelope (not [object Object])",
  withErrorResponse(
    422,
    { detail: "Validation error", error: { code: "VALIDATION_ERROR", details: [{ field: "limit", message: "must be <= 100" }] } },
    null,
    async (api) => {
      await assert.rejects(api.listNumbers(999), (e) => {
        assert.ok(e instanceof ApiError);
        assert.match(e.detail, /Validation error \(VALIDATION_ERROR\)/);
        assert.match(e.detail, /limit: must be <= 100/);
        return true;
      });
    }
  )
);

test(
  "formats a FastAPI validation detail array",
  withErrorResponse(
    422,
    { detail: [{ loc: ["body", "to_number"], msg: "field required", type: "value_error.missing" }] },
    null,
    async (api) => {
      await assert.rejects(api.listNumbers(1), (e) => {
        assert.match(e.detail, /to_number: field required/);
        return true;
      });
    }
  )
);

test(
  "surfaces Retry-After on 429",
  withErrorResponse(429, { detail: "Too many requests" }, { "retry-after": "30" }, async (api) => {
    await assert.rejects(api.listNumbers(1), (e) => {
      assert.equal(e.status, 429);
      assert.equal(e.retryAfter, "30");
      return true;
    });
  })
);

test(
  "redacts credentials in error text",
  withErrorResponse(400, { detail: "bad key sk_live_abcdef123456 used" }, null, async (api) => {
    await assert.rejects(api.listNumbers(1), (e) => {
      assert.doesNotMatch(e.detail, /abcdef123456/);
      assert.match(e.detail, /sk_\*\*\*/);
      return true;
    });
  })
);

// #197 finding 13: redaction and non-JSON fallback paths.
test(
  "redacts a Bearer token with the full RFC 6750 charset",
  withErrorResponse(400, { detail: "got Bearer abc+def/ghi=123~x used" }, null, async (api) => {
    await assert.rejects(api.listNumbers(1), (e) => {
      assert.doesNotMatch(e.detail, /abc\+def/);
      assert.match(e.detail, /Bearer \*\*\*/);
      return true;
    });
  })
);

test(
  "keeps a non-JSON error body as text",
  withErrorResponse(502, "upstream exploded", null, async (api) => {
    await assert.rejects(api.listNumbers(1), (e) => {
      assert.match(e.detail, /upstream exploded/);
      return true;
    });
  })
);
