import assert from "node:assert/strict";
import test from "node:test";

import { registerTools } from "../dist/tools.js";

/**
 * Register the real tools against a stub API client, recording the arguments
 * each call receives so pagination can be checked at the boundary.
 */
function setup(responses = {}) {
  const apiCalls = [];
  const api = {
    getMessages: async (...args) => {
      apiCalls.push({ method: "getMessages", args });
      return responses.getMessages ?? { data: [], hasMore: false };
    },
    listAgents: async (...args) => {
      apiCalls.push({ method: "listAgents", args });
      return responses.listAgents ?? { data: [], total: 0 };
    },
  };

  const handlers = new Map();
  const registrar = {
    tool(name, _description, _schema, annotationsOrHandler, maybeHandler) {
      handlers.set(
        name,
        typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler
      );
    },
  };

  registerTools(registrar, api);
  return { handlers, apiCalls };
}

const message = (id) => ({
  id,
  from: "+14155551234",
  to: "+14155555678",
  body: `message ${id}`,
  receivedAt: "2026-01-01T00:00:00Z",
});

test("get_messages forwards offset to the API", async () => {
  const { handlers, apiCalls } = setup();

  await handlers.get("get_messages")({ number_id: "num_1", limit: 50, offset: 100 });

  assert.deepEqual(apiCalls, [{ method: "getMessages", args: ["num_1", 50, 100] }]);
});

test("get_messages reports the next offset when more remain", async () => {
  const { handlers } = setup({
    getMessages: { data: [message("m1"), message("m2")], hasMore: true },
  });

  const result = await handlers.get("get_messages")({ number_id: "num_1", limit: 2, offset: 10 });

  assert.notEqual(result.isError, true);
  // 10 already skipped + 2 returned = the caller's next page starts at 12.
  assert.match(result.content[0].text, /More messages available — call again with offset=12\./);
});

test("get_messages stays quiet about paging when the page is the whole list", async () => {
  const { handlers } = setup({
    getMessages: { data: [message("m1")], hasMore: false },
  });

  const result = await handlers.get("get_messages")({ number_id: "num_1", limit: 50, offset: 0 });

  assert.doesNotMatch(result.content[0].text, /More messages available/);
});

test("get_messages distinguishes an empty page from an empty inbox", async () => {
  const { handlers } = setup({ getMessages: { data: [], hasMore: false } });

  const first = await handlers.get("get_messages")({ number_id: "num_1", limit: 50, offset: 0 });
  assert.match(first.content[0].text, /No messages found for this number\./);

  const past = await handlers.get("get_messages")({ number_id: "num_1", limit: 50, offset: 500 });
  assert.match(past.content[0].text, /No further messages .* past offset 500\./);
});

test("list_agents forwards offset to the API", async () => {
  const { handlers, apiCalls } = setup();

  await handlers.get("list_agents")({ limit: 100, offset: 200 });

  assert.deepEqual(apiCalls, [{ method: "listAgents", args: [100, 200] }]);
});
