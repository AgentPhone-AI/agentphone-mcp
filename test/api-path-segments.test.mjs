import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { AgentPhoneAPI } from "../dist/api.js";
import { registerTools } from "../dist/tools.js";

/**
 * An ID is placed in the URL path with encodeURIComponent, which leaves "." as
 * is, and URL parsing then resolves "." and ".." segments. So an ID of ".."
 * used to send a request to a different endpoint, e.g. attach_number's
 * POST /v1/agents/../numbers arrived as POST /v1/numbers (the purchase
 * endpoint, without buy_number's confirm step). These IDs must be refused
 * before any request is made.
 */

async function withFetch(run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(`${init.method} ${new URL(url).pathname}`);
    return new Response(JSON.stringify({ data: [], hasMore: false, total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return { seen, result: await run() };
  } finally {
    globalThis.fetch = original;
  }
}

const api = () => new AgentPhoneAPI("https://api.example.test", "key");

// Every client method that puts a caller-supplied ID in the path.
const ID_METHODS = {
  getNumber: (a, id) => a.getNumber(id),
  releaseNumber: (a, id) => a.releaseNumber(id),
  getMessages: (a, id) => a.getMessages(id),
  sendReaction: (a, id) => a.sendReaction(id, "love"),
  updateAgent: (a, id) => a.updateAgent(id, { name: "x" }),
  deleteAgent: (a, id) => a.deleteAgent(id),
  getAgent: (a, id) => a.getAgent(id),
  attachNumber: (a, id) => a.attachNumber(id, "num_1"),
  "detachNumber (agent)": (a, id) => a.detachNumber(id, "num_1"),
  "detachNumber (number)": (a, id) => a.detachNumber("agt_1", id),
  listAgentConversations: (a, id) => a.listAgentConversations(id),
  listAgentCalls: (a, id) => a.listAgentCalls(id),
  getAgentWebhook: (a, id) => a.getAgentWebhook(id),
  setAgentWebhook: (a, id) => a.setAgentWebhook(id, "https://example.com/hook"),
  deleteAgentWebhook: (a, id) => a.deleteAgentWebhook(id),
  testAgentWebhook: (a, id) => a.testAgentWebhook(id),
  listAgentWebhookDeliveries: (a, id) => a.listAgentWebhookDeliveries(id),
  getCall: (a, id) => a.getCall(id),
  endCall: (a, id) => a.endCall(id),
  listCallsForNumber: (a, id) => a.listCallsForNumber(id),
  getConversation: (a, id) => a.getConversation(id),
  getConversationMessages: (a, id) => a.getConversationMessages(id),
  updateConversation: (a, id) => a.updateConversation(id, null),
  updateContact: (a, id) => a.updateContact(id, { name: "x" }),
  deleteContact: (a, id) => a.deleteContact(id),
};

test("every ID-taking API method refuses '', '.' and '..' without sending a request", async (t) => {
  for (const [name, call] of Object.entries(ID_METHODS)) {
    for (const id of ["", ".", ".."]) {
      await t.test(`${name}(${JSON.stringify(id)})`, async () => {
        const { seen } = await withFetch(async () => {
          await assert.rejects(call(api(), id), /Invalid ID/);
        });
        assert.deepEqual(seen, [], "no request may be sent");
      });
    }
  }
});

test("ordinary IDs still reach their own endpoint, with reserved characters encoded", async () => {
  const { seen } = await withFetch(async () => {
    await api().detachNumber("agt_1", "num_1");
    await api().getAgent("a/b?c");
    await api().getCall("...");
  });
  assert.deepEqual(seen, [
    "DELETE /v1/agents/agt_1/numbers/num_1",
    "GET /v1/agents/a%2Fb%3Fc",
    "GET /v1/calls/...",
  ]);
});

function tools() {
  const registered = new Map();
  registerTools(
    {
      tool(name, _description, schema, annotationsOrHandler, maybeHandler) {
        const handler = typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler;
        registered.set(name, { schema, handler });
      },
    },
    api()
  );
  return async (name, args) => {
    const { schema, handler } = registered.get(name);
    return handler(await z.object(schema).parseAsync(args));
  };
}

test("attach_number with agent_id '..' can't reach the number-purchase endpoint", async () => {
  const call = tools();
  const { seen, result } = await withFetch(() => call("attach_number", { agent_id: "..", number_id: "num_1" }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid ID/);
  assert.deepEqual(seen, [], "POST /v1/numbers must never be sent");
});

test("detach_number with number_id '..' can't reach the delete-agent endpoint", async () => {
  const call = tools();
  const { seen, result } = await withFetch(() => call("detach_number", { agent_id: "agt_1", number_id: ".." }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid ID/);
  assert.deepEqual(seen, [], "DELETE /v1/agents/agt_1/ must never be sent");
});
