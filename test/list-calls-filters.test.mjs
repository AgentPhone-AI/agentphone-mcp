import assert from "node:assert/strict";
import test from "node:test";

import { registerTools } from "../dist/tools.js";

const EMPTY_PAGE = { data: [], hasMore: false, total: 0 };

/**
 * Register the real tools against a stub API client, and hand back the handlers
 * plus the list of API calls that actually reached the client. A filter that is
 * rejected must leave that list empty.
 */
function setup() {
  const apiCalls = [];
  const record =
    (method) =>
    async (...args) => {
      apiCalls.push({ method, args });
      return EMPTY_PAGE;
    };

  const api = {
    listCalls: record("listCalls"),
    listAgentCalls: record("listAgentCalls"),
    listCallsForNumber: record("listCallsForNumber"),
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
  return { listCalls: handlers.get("list_calls"), apiCalls };
}

test("scoping by agent rejects filters instead of dropping them", async () => {
  const { listCalls, apiCalls } = setup();

  const result = await listCalls({ agent_id: "ag_1", status: "failed", limit: 20, offset: 0 });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /status cannot be combined with agent_id/);
  // The decisive part: no unfiltered request was issued and presented as filtered.
  assert.deepEqual(apiCalls, []);
});

test("every ignored filter is named, not just the first", async () => {
  const { listCalls, apiCalls } = setup();

  const result = await listCalls({
    number_id: "num_1",
    status: "completed",
    direction: "outbound",
    search: "+14155551234",
    limit: 20,
    offset: 0,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /status, direction, search cannot be combined with number_id/);
  assert.deepEqual(apiCalls, []);
});

test("two scopes at once are rejected rather than one winning silently", async () => {
  const { listCalls, apiCalls } = setup();

  const result = await listCalls({ agent_id: "ag_1", number_id: "num_1", limit: 20, offset: 0 });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /either agent_id or number_id, not both/i);
  assert.deepEqual(apiCalls, []);
});

test("a scope on its own still reaches the scoped endpoint", async () => {
  const { listCalls, apiCalls } = setup();

  const byAgent = await listCalls({ agent_id: "ag_1", limit: 20, offset: 0 });
  assert.notEqual(byAgent.isError, true);
  assert.deepEqual(apiCalls, [{ method: "listAgentCalls", args: ["ag_1", 20, 0] }]);

  const byNumber = await listCalls({ number_id: "num_1", limit: 5, offset: 10 });
  assert.notEqual(byNumber.isError, true);
  assert.deepEqual(apiCalls[1], { method: "listCallsForNumber", args: ["num_1", 5, 10] });
});

test("filters without a scope still reach the global endpoint", async () => {
  const { listCalls, apiCalls } = setup();

  const result = await listCalls({
    status: "failed",
    direction: "outbound",
    search: "555",
    limit: 20,
    offset: 0,
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(apiCalls, [
    {
      method: "listCalls",
      args: [20, 0, { status: "failed", direction: "outbound", search: "555" }],
    },
  ]);
});
