import test from "node:test";
import assert from "node:assert/strict";
import { AgentPhoneAPI } from "../dist/api.js";
import { registerTools } from "../dist/tools.js";
import { z } from "zod";

// --- API client: X-Sub-Account-Id header is attached only when a sub-account
//     is selected, and never otherwise. This is the whole point of the feature:
//     the backend already honors the header; the connector now sends it. ---

function captureRequest(fn, { subAccountId } = {}) {
  return async () => {
    const original = globalThis.fetch;
    let captured;
    globalThis.fetch = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: [], total: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const api = new AgentPhoneAPI("https://example.test", "key", subAccountId);
      await fn(api);
      return captured;
    } finally {
      globalThis.fetch = original;
    }
  };
}

test("no sub-account selected: X-Sub-Account-Id is not sent", async () => {
  const captured = await captureRequest(async (api) => {
    await api.listNumbers();
  })();
  assert.equal(captured.init.headers["X-Sub-Account-Id"], undefined);
  assert.equal(captured.init.headers.Authorization, "Bearer key");
});

test("sub-account selected: X-Sub-Account-Id carries the id on every call", async () => {
  let selected = "sub_42";
  const captured = await captureRequest(
    async (api) => {
      await api.listNumbers();
    },
    { subAccountId: () => selected }
  )();
  assert.equal(captured.init.headers["X-Sub-Account-Id"], "sub_42");
});

test("empty/undefined selection resolves to no header (back to parent)", async () => {
  for (const val of [undefined, null, ""]) {
    const captured = await captureRequest(
      async (api) => {
        await api.listAgents();
      },
      { subAccountId: () => val }
    )();
    assert.equal(captured.init.headers["X-Sub-Account-Id"], undefined, `value ${JSON.stringify(val)}`);
  }
});

test("listSubAccounts hits GET /v1/sub-accounts", async () => {
  const captured = await captureRequest(async (api) => {
    await api.listSubAccounts();
  })();
  assert.match(captured.url, /\/v1\/sub-accounts$/);
  assert.equal(captured.init.method, "GET");
});

// --- Tool handlers: list_sub_accounts, use_sub_account, selection lifecycle. ---

function harness(apiStub, selector) {
  const tools = new Map();
  const registrar = {
    tool(name, _description, schema, annotationsOrHandler, maybeHandler) {
      const handler = typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler;
      tools.set(name, { schema, handler });
    },
  };
  registerTools(registrar, apiStub, selector ? { subAccounts: selector } : {});
  return {
    call: async (name, args) => {
      const t = tools.get(name);
      return t.handler(await z.object(t.schema).parseAsync(args ?? {}));
    },
  };
}

const family = {
  data: [
    { id: "sub_1", name: "Saul", parentAccountId: "acct_1", createdAt: "t" },
    { id: "sub_2", name: "Remy", parentAccountId: "acct_1", createdAt: "t" },
  ],
  total: 2,
};

function stub() {
  return { listSubAccounts: async () => family };
}

test("use_sub_account selects a valid sub-account and persists it via the selector", async () => {
  let current;
  const selector = { get: () => current, set: (id) => { current = id || undefined; } };
  const h = harness(stub(), selector);

  const r = await h.call("use_sub_account", { sub_account_id: "sub_1" });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.subAccountId, "sub_1");
  assert.equal(r.structuredContent.name, "Saul");
  assert.equal(r.structuredContent.scope, "sub-account");
  assert.equal(current, "sub_1");
  assert.match(r.content[0].text, /Saul/);
});

test("use_sub_account with no id clears the selection (back to parent)", async () => {
  let current = "sub_1";
  const selector = { get: () => current, set: (id) => { current = id || undefined; } };
  const h = harness(stub(), selector);

  const r = await h.call("use_sub_account", {});
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.subAccountId, null);
  assert.equal(r.structuredContent.scope, "parent");
  assert.equal(current, undefined);
});

test("use_sub_account rejects an unknown id without changing the selection, and lists known ones", async () => {
  let current = "sub_2";
  const selector = { get: () => current, set: (id) => { current = id || undefined; } };
  const h = harness(stub(), selector);

  const r = await h.call("use_sub_account", { sub_account_id: "nope" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No sub-account with id "nope"/);
  assert.match(r.content[0].text, /Saul \(sub_1\)/);
  assert.equal(current, "sub_2", "selection unchanged on failure");
});

test("list_sub_accounts marks the current selection and reports scope", async () => {
  let current = "sub_2";
  const selector = { get: () => current, set: (id) => { current = id || undefined; } };
  const h = harness(stub(), selector);

  const r = await h.call("list_sub_accounts", {});
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.currentSubAccountId, "sub_2");
  assert.match(r.content[0].text, /→ Remy/);
  assert.match(r.content[0].text, /Active scope: sub-account sub_2/);
});

test("list_sub_accounts on the main account reports the parent scope", async () => {
  const h = harness(stub(), { get: () => undefined, set: () => {} });
  const r = await h.call("list_sub_accounts", {});
  assert.equal(r.structuredContent.currentSubAccountId, null);
  assert.match(r.content[0].text, /Active scope: main account/);
});

test("the tools still work with no selector wired (process-local fallback)", async () => {
  const h = harness(stub()); // no selector passed
  const sel = await h.call("use_sub_account", { sub_account_id: "sub_1" });
  assert.equal(sel.isError, undefined);
  assert.equal(sel.structuredContent.subAccountId, "sub_1");
  // The fallback persists within this registration.
  const list = await h.call("list_sub_accounts", {});
  assert.equal(list.structuredContent.currentSubAccountId, "sub_1");
});
