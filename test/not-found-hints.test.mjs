import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { registerTools } from "../dist/tools.js";
import { AgentPhoneAPI } from "../dist/api.js";

/**
 * A 404 result tells the agent where to find a valid ID. These drive each tool
 * through the real API client against a fetch that answers 404, so the hint is
 * picked from the path the tool actually requests.
 *
 * A path can name two IDs (/v1/agents/A/numbers/N, /v1/agents/A/webhook), and
 * the hint used to come from whichever substring matched first, so every such
 * 404 pointed at list_agents, even for a bad number_id or an agent with no
 * webhook of its own. Message and contact 404s got no hint at all.
 */
async function notFoundText(toolName, args) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ detail: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  try {
    const tools = new Map();
    registerTools(
      {
        tool(name, _description, schema, annotationsOrHandler, maybeHandler) {
          const handler = typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler;
          tools.set(name, { schema, handler });
        },
      },
      new AgentPhoneAPI("https://api.example.test", "sk_test_fixture")
    );
    const { schema, handler } = tools.get(toolName);
    const result = await handler(await z.object(schema).parseAsync(args));
    assert.equal(result.isError, true, `${toolName} should report the 404 as an error`);
    return result.content[0].text;
  } finally {
    globalThis.fetch = realFetch;
  }
}

const CASES = [
  // [tool, args, hint it must give, hint it must not give]
  ["detach_number", { agent_id: "agt_1", number_id: "num_x" }, /get_agent .*list_numbers/, /list_agents/],
  ["get_webhook", { agent_id: "agt_1" }, /get_webhook with this agent_id/, null],
  ["delete_webhook", { agent_id: "agt_1" }, /get_webhook with this agent_id/, null],
  ["test_webhook", { agent_id: "agt_1" }, /get_webhook with this agent_id/, null],
  ["list_webhook_deliveries", { agent_id: "agt_1" }, /get_webhook with this agent_id/, null],
  ["delete_webhook", {}, /get_webhook to check whether a webhook is configured/, /list_agents/],
  ["send_message", { reaction: "love", react_to_message_id: "msg_x", confirm: true }, /get_messages or get_conversation_messages/, null],
  ["manage_contact", { action: "update", contact_id: "ct_x", name: "Sam" }, /list_contacts/, null],
  // attach_number sends number_id in the body, so the hint names both lookups.
  ["attach_number", { agent_id: "agt_1", number_id: "num_x" }, /list_agents .*list_numbers/, null],
  // Fixed routes under an ID collection carry no ID, so no lookup hint applies.
  ["list_voices", {}, /^Not found$/, /list_agents/],
  ["check_capabilities", { phone_number: "+14155551234" }, /^Not found$/, /list_contacts/],
  // Single-ID paths keep the hint they had.
  ["get_agent", { agent_id: "agt_x" }, /list_agents/, null],
  ["list_calls", { agent_id: "agt_x" }, /list_agents/, null],
  ["get_messages", { number_id: "num_x" }, /list_numbers/, null],
  ["get_call", { call_id: "call_x" }, /list_calls/, null],
  ["get_conversation", { conversation_id: "conv_x" }, /list_conversations/, null],
];

for (const [tool, args, want, notWant] of CASES) {
  test(`404 hint for ${tool}(${JSON.stringify(args)})`, async () => {
    const text = await notFoundText(tool, args);
    assert.match(text, want);
    if (notWant) assert.doesNotMatch(text, notWant);
  });
}
