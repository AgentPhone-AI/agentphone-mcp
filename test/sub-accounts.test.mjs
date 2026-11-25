import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { registerTools } from "../dist/tools.js";
import { AgentPhoneAPI } from "../dist/api.js";

// Drive the real handlers against the real API client with fetch stubbed, so
// the test sees the exact headers each tool call sends.
async function withFetch(respond, fn) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method, headers: init?.headers ?? {} });
    return new Response(JSON.stringify(respond(String(url))), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await fn(requests);
  } finally {
    globalThis.fetch = original;
  }
}

function harness() {
  const tools = new Map();
  registerTools(
    {
      tool(name, description, schema, annotationsOrHandler, maybeHandler) {
        const handler = typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler;
        tools.set(name, { schema, handler });
      },
    },
    new AgentPhoneAPI("https://api.example.test", "key")
  );
  return {
    names: () => [...tools.keys()],
    schema: (name) => tools.get(name).schema,
    call: async (name, args) => tools.get(name).handler(await z.object(tools.get(name).schema).parseAsync(args ?? {})),
  };
}

const agentsPage = { data: [], total: 0 };

test("every tool except list_sub_accounts accepts an optional sub_account_id", () => {
  const h = harness();
  for (const name of h.names()) {
    const has = "sub_account_id" in h.schema(name);
    assert.equal(has, name !== "list_sub_accounts", name);
    if (has) assert.equal(h.schema(name).sub_account_id.isOptional(), true, `${name} sub_account_id is optional`);
  }
});

test("sub_account_id is sent as X-Sub-Account-Id on every request the tool makes", async () => {
  const usage = { numbers: { used: 1, limit: 5, remaining: 4 }, stats: {} };
  const respond = (url) => (url.includes("/v1/usage") ? usage : url.includes("/webhooks") ? null : agentsPage);
  await withFetch(respond, async (requests) => {
    const r = await harness().call("account_overview", { sub_account_id: "sub_1" });
    assert.notEqual(r.isError, true);
    assert.ok(requests.length >= 4, "overview makes several requests");
    for (const req of requests) assert.equal(req.headers["X-Sub-Account-Id"], "sub_1", req.url);
  });
});

test("without sub_account_id no X-Sub-Account-Id header is sent", async () => {
  await withFetch(() => agentsPage, async (requests) => {
    await harness().call("list_agents", {});
    assert.equal(requests.length, 1);
    assert.equal("X-Sub-Account-Id" in requests[0].headers, false);
  });
});

test("sub_account_id is not forwarded to the handler as a tool argument", async () => {
  await withFetch(() => agentsPage, async (requests) => {
    await harness().call("list_agents", { limit: 5, sub_account_id: "sub_1" });
    assert.equal(requests[0].url, "https://api.example.test/v1/agents?limit=5&offset=0");
  });
});

test("concurrent calls keep their own sub-account scope", async () => {
  await withFetch(() => agentsPage, async (requests) => {
    const h = harness();
    await Promise.all([
      h.call("list_agents", { sub_account_id: "sub_a" }),
      h.call("list_agents", {}),
      h.call("list_agents", { sub_account_id: "sub_b" }),
    ]);
    const scopes = requests.map((r) => r.headers["X-Sub-Account-Id"] ?? null).sort();
    assert.deepEqual(scopes, [null, "sub_a", "sub_b"]);
  });
});

test("list_sub_accounts lists sub-accounts with paging info", async () => {
  const page = { data: [{ id: "sub_1", name: "Saul", parentAccountId: "acc_1", createdAt: "t" }], total: 3 };
  await withFetch(() => page, async (requests) => {
    const r = await harness().call("list_sub_accounts", { limit: 1 });
    assert.equal(requests[0].url, "https://api.example.test/v1/sub-accounts?limit=1&offset=0");
    assert.equal("X-Sub-Account-Id" in requests[0].headers, false);
    assert.equal(r.structuredContent.hasMore, true);
    assert.equal(r.structuredContent.data[0].name, "Saul");
    assert.match(r.content[0].text, /offset=1/);
  });
});

test("list_sub_accounts says so when there are none", async () => {
  await withFetch(() => ({ data: [], total: 0 }), async () => {
    const r = await harness().call("list_sub_accounts", {});
    assert.match(r.content[0].text, /no sub-accounts/);
  });
});
