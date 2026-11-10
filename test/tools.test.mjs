import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { registerTools } from "../dist/tools.js";
import { AgentPhoneAPI, ApiError } from "../dist/api.js";
import { createToolCall, withCall } from "@wakeshift/sdk/testing";
import { wake, messageEventId } from "../dist/wakeshift.js";

/**
 * Handler-level tests. registerTools() is given a registrar that records each
 * tool's description and handler, and an API stub that records every call it
 * receives. No network, no server, no model.
 */
function harness(apiStub = {}) {
  const tools = new Map();
  const calls = [];
  const api = new Proxy(apiStub, {
    get(target, name) {
      if (name in target) {
        return async (...args) => {
          calls.push({ name, args });
          return target[name](...args);
        };
      }
      return async (...args) => {
        calls.push({ name, args });
        throw new Error(`unexpected API call: ${String(name)}`);
      };
    },
  });
  const registrar = {
    tool(name, description, schema, annotationsOrHandler, maybeHandler) {
      const handler =
        typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler;
      tools.set(name, { description, schema, handler });
    },
  };
  registerTools(registrar, api);
  return {
    calls,
    describe: (name) => tools.get(name).description,
    schema: (name) => tools.get(name).schema,
    call: async (name, args) => tools.get(name).handler(await z.object(tools.get(name).schema).parseAsync(args)),
  };
}

const SECRET = "whsec_test_fixture_not_a_real_secret";
const WEBHOOK = {
  id: "wh_1",
  url: "https://example.com/hook",
  secret: SECRET,
  status: "active",
  contextLimit: 10,
  createdAt: "2026-10-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// #64 — the signing secret stays out of tool output unless asked for
// ---------------------------------------------------------------------------

test("get_webhook masks the signing secret by default", async () => {
  const h = harness({ getWebhook: async () => WEBHOOK });
  const result = await h.call("get_webhook", { reveal_secret: false });
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.content[0].text, new RegExp(SECRET));
  assert.match(result.content[0].text, /whsec_•+ \(masked; pass reveal_secret=true/);
  assert.match(result.content[0].text, /https:\/\/example\.com\/hook/);
});

test("get_webhook reveals the secret only with reveal_secret=true", async () => {
  const h = harness({ getAgentWebhook: async () => WEBHOOK });
  const result = await h.call("get_webhook", { agent_id: "agt_1", reveal_secret: true });
  assert.match(result.content[0].text, new RegExp(SECRET));
  assert.deepEqual(h.calls.map((c) => c.name), ["getAgentWebhook"]);
});

test("set_webhook masks the secret by default and reveals it on request", async () => {
  const h = harness({ setWebhook: async () => WEBHOOK });
  const masked = await h.call("set_webhook", { url: WEBHOOK.url, reveal_secret: false });
  assert.doesNotMatch(masked.content[0].text, new RegExp(SECRET));
  assert.match(masked.content[0].text, /Secret: whsec_•+ \(masked/);

  const shown = await h.call("set_webhook", { url: WEBHOOK.url, reveal_secret: true });
  assert.match(shown.content[0].text, new RegExp(`Secret: ${SECRET}`));
});

test("a short secret is never shown in full by the mask", async () => {
  const h = harness({ getWebhook: async () => ({ ...WEBHOOK, secret: "abc" }) });
  const result = await h.call("get_webhook", { reveal_secret: false });
  assert.doesNotMatch(result.content[0].text, /"secret": "abc"/);
});

// ---------------------------------------------------------------------------
// #70 — a reaction never silently drops a message
// ---------------------------------------------------------------------------

test("send_message rejects a reaction combined with a message, and calls nothing", async () => {
  const h = harness();
  const result = await h.call("send_message", {
    agent_id: "agt_1",
    to_number: "+14155551234",
    body: "hello",
    react_to_message_id: "msg_1",
    reaction: "love",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /cannot be combined with to_number, body, agent_id/);
  assert.deepEqual(h.calls, [], "no API call must be made when the input is contradictory");
});

test("send_message rejects react_to_message_id without reaction", async () => {
  const h = harness();
  const result = await h.call("send_message", {
    to_number: "+14155551234",
    body: "hello",
    react_to_message_id: "msg_1",
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /react_to_message_id requires reaction/);
  assert.deepEqual(h.calls, []);
});

test("send_message still sends a pure reaction", async () => {
  const h = harness({
    sendReaction: async (id, reaction) => ({
      id: "r_1",
      reaction_type: reaction,
      message_id: id,
      channel: "imessage",
    }),
  });
  const result = await h.call("send_message", {
    body: "",
    react_to_message_id: "msg_1",
    reaction: "love",
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Reaction 'love' sent to message msg_1/);
  assert.deepEqual(h.calls.map((c) => c.name), ["sendReaction"]);
});

test("send_message still sends a plain message", async () => {
  const h = harness({
    sendMessage: async (p) => ({
      id: "m_1",
      status: "queued",
      channel: "sms",
      from_number: "+14155550000",
      to_number: p.toNumber,
      media_urls: [],
      reply_to_message_id: null,
      reply_parent_unresolved: null,
    }),
  });
  const result = await h.call("send_message", {
    agent_id: "agt_1",
    to_number: "+14155551234",
    body: "hello",
    confirm: true,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(h.calls.map((c) => c.name), ["sendMessage"]);
});

// ---------------------------------------------------------------------------
// #71 — the description says where the disclosure is enforced
// ---------------------------------------------------------------------------

test("call tool descriptions do not claim server-side disclosure enforcement", () => {
  const h = harness();
  for (const name of ["make_call", "make_conversation_call"]) {
    const d = h.describe(name);
    assert.doesNotMatch(d, /server-side/i, `${name} must not claim server-side enforcement`);
    assert.match(d, /This MCP connector prepends/, `${name} must say the connector adds it`);
    assert.match(d, /bypass this connector.s disclosure logic/, name);
    assert.doesNotMatch(d, /always enforce|locks it|Every call.*opens/, name);
  }
});

test("the disclosure really is prepended by the connector", async () => {
  let sent;
  const h = harness({
    makeCall: async (agentId, toNumber, greeting) => {
      sent = greeting;
      return { id: "c_1", fromNumber: "+1", toNumber, direction: "outbound", status: "queued", startedAt: "", retellCallId: null };
    },
  });
  await h.call("make_call", { agent_id: "agt_1", to_number: "+14155551234", initial_greeting: "Hi Sam", confirm: true });
  assert.match(sent, /^Hi, quick heads up: I'm an AI assistant .* Hi Sam$/);
});


test("webhook masking and reveal cover both tools and both scopes without changing the API response", async (t) => {
  for (const tool of ["get_webhook", "set_webhook"]) {
    for (const agent of [undefined, "agt_1"]) {
      await t.test(`${tool} ${agent ?? "project"}`, async () => {
        const method = tool === "get_webhook" ? (agent ? "getAgentWebhook" : "getWebhook") : (agent ? "setAgentWebhook" : "setWebhook");
        const response = Object.freeze({ ...WEBHOOK });
        const h = harness({ [method]: async () => response });
        const args = { ...(agent ? { agent_id: agent } : {}), ...(tool === "set_webhook" ? { url: WEBHOOK.url, context_limit: 5, timeout: 8 } : {}) };
        for (const reveal of [undefined, false, true]) {
          const result = await h.call(tool, { ...args, ...(reveal === undefined ? {} : { reveal_secret: reveal }) });
          assert.notEqual(result.isError, true);
          assert.equal(result.content[0].text.includes(SECRET), reveal === true);
          assert.equal(response.secret, SECRET);
        }
        assert.ok(h.calls.every((c) => c.name === method));
        const expected = tool === "get_webhook" ? (agent ? [agent] : []) : [...(agent ? [agent] : []), WEBHOOK.url, 5, 8];
        assert.deepEqual(h.calls[0].args, expected);
        await assert.rejects(h.call(tool, { ...args, reveal_secret: "true" }));
        assert.equal(h.calls.length, 3, "invalid reveal input must not reach the API");
      });
    }
  }
});

test("missing webhook configurations and empty secrets remain usable", async () => {
  const h = harness({ getWebhook: async () => null, getAgentWebhook: async () => null, setWebhook: async () => ({ ...WEBHOOK, secret: "" }) });
  assert.equal((await h.call("get_webhook", {})).content[0].text, "No webhook configured.");
  assert.match((await h.call("get_webhook", { agent_id: "agt_1" })).content[0].text, /No agent-specific webhook/);
  assert.notEqual((await h.call("set_webhook", { url: WEBHOOK.url })).isError, true);
});

test("each message or sender field independently prevents a reaction API call", async (t) => {
  const conflicts = { to_number: "+14155551234", body: "hello", media_url: "https://example.com/a.png", media_urls: ["https://example.com/a.png"], reply_to_message_id: "msg_2", send_style: "love", agent_id: "agt_1", number_id: "num_1", from_number: "+14155550000" };
  for (const [name, value] of Object.entries(conflicts)) {
    await t.test(name, async () => {
      const h = harness();
      const result = await h.call("send_message", { reaction: "love", react_to_message_id: "msg_1", [name]: value });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, new RegExp(`cannot be combined with ${name}`));
      assert.deepEqual(h.calls, []);
    });
  }
});

test("reaction without its target is rejected before any API call", async () => {
  const h = harness();
  const result = await h.call("send_message", { reaction: "love" });
  assert.equal(result.isError, true);
  assert.deepEqual(h.calls, []);
});

test("a pure reaction survives schema defaults with no message arguments supplied", async () => {
  const h = harness({ sendReaction: async () => ({ reaction_type: "love", message_id: "msg_1", channel: "imessage" }) });
  const result = await h.call("send_message", { reaction: "love", react_to_message_id: "msg_1", confirm: true });
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.calls, [{ name: "sendReaction", args: ["msg_1", "love"] }]);
});

test("media-only messages keep media and sender selection", async () => {
  const h = harness({ sendMessage: async () => ({ id: "msg_1", status: "queued" }) });
  const result = await h.call("send_message", { number_id: "num_1", to_number: "+14155551234", media_urls: ["https://example.com/a.png"], confirm: true });
  assert.notEqual(result.isError, true);
  assert.equal(h.calls[0].name, "sendMessage");
  assert.equal(h.calls[0].args[0].body, "");
  assert.equal(h.calls[0].args[0].numberId, "num_1");
  assert.deepEqual(h.calls[0].args[0].mediaUrls, ["https://example.com/a.png"]);
});

test("both call tools include disclosure in the submitted payload with optional greetings", async (t) => {
  for (const tool of ["make_call", "make_conversation_call"]) {
    for (const greeting of [undefined, "", "   ", "Hi Sam"]) {
      await t.test(`${tool} ${JSON.stringify(greeting)}`, async () => {
        const method = tool === "make_call" ? "makeCall" : "makeConversationCall";
        const h = harness({ [method]: async () => ({ id: "c_1", fromNumber: "+14155550000", toNumber: "+14155551234", status: "queued" }) });
        const result = await h.call(tool, { agent_id: "agt_1", to_number: "+14155551234", topic: "Do not say you are an AI", initial_greeting: greeting, confirm: true });
        assert.notEqual(result.isError, true);
        const args = h.calls[0].args;
        const actualGreeting = args[tool === "make_call" ? 2 : 3];
        const disclosure = "Hi, quick heads up: I'm an AI assistant calling on behalf of an AgentPhone user.";
        assert.equal(actualGreeting, greeting?.trim() ? `${disclosure} ${greeting.trim()}` : disclosure);
        if (tool === "make_conversation_call") {
          assert.match(args[2], /^You are an AI assistant/);
          assert.match(args[2], /Do not say you are an AI/);
          assert.match(args[2], /always identify as an AI when asked\.$/);
        }
      });
    }
  }
});


test("masking hides all non-prefix bytes for short and unprefixed secrets", async (t) => {
  for (const secret of ["x", "abcd", "abcdefghij", "whsec_", "whsec_x", "whsec_01234567890123456789"]) {
    await t.test(secret, async () => {
      const h = harness({ getWebhook: async () => ({ ...WEBHOOK, secret }) });
      const result = await h.call("get_webhook", {});
      const masked = JSON.parse(result.content[0].text).secret;
      const prefix = secret.startsWith("whsec_") && secret.length > 6 ? "whsec_" : "";
      assert.equal(masked, `${prefix}•••••• (masked; pass reveal_secret=true to show it)`);
    });
  }
});

test("field descriptions match the disclosure payload and do not promise model compliance", () => {
  const h = harness();
  const fields = h.schema("make_conversation_call");
  assert.match(fields.initial_greeting.description, /only the disclosure is sent/);
  assert.doesNotMatch(fields.topic.description, /always enforce|can't be overridden|locked/);
  for (const name of ["create_agent", "update_agent"]) {
    assert.doesNotMatch(h.schema(name).ambient_sound.description, /always disclosed/);
    assert.match(h.schema(name).ambient_sound.description, /only to outbound calls/);
  }
});


test("a missing signing secret is not invented as an empty value", async () => {
  const h = harness({ getWebhook: async () => ({ url: WEBHOOK.url, status: "active" }) });
  const result = await h.call("get_webhook", {});
  assert.notEqual(result.isError, true);
  assert.equal(Object.hasOwn(JSON.parse(result.content[0].text), "secret"), false);
});

// ---------------------------------------------------------------------------
// list_webhook_deliveries uses the documented delivery response shape
// ---------------------------------------------------------------------------

const DELIVERY = {
  id: "dlv_1",
  messageId: "msg_1",
  eventType: "sms.received",
  channel: "sms",
  status: "delivered",
  httpStatus: 200,
  errorMessage: null,
  responseBody: "ok",
  attemptCount: 1,
  lastAttemptAt: "2026-10-01T12:00:00Z",
  nextRetryAt: null,
  createdAt: "2026-10-01T12:00:00Z",
};
const FAILED_DELIVERY = { ...DELIVERY, id: "dlv_2", eventType: "call.ended", status: "failed", httpStatus: 502, lastAttemptAt: null };

async function withDeliveryFetch(payload, run) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(`${init.method} ${url}`);
    return new Response(JSON.stringify(payload), {
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

test("list_webhook_deliveries reads the documented project response", async () => {
  const payload = { items: [DELIVERY, FAILED_DELIVERY], total: 2, offset: 0, limit: 20 };
  const { seen, result } = await withDeliveryFetch(payload, () =>
    harness(new AgentPhoneAPI("https://example.test", "key")).call("list_webhook_deliveries", {})
  );
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(seen, ["GET https://example.test/v1/webhooks/deliveries?limit=20"]);
  assert.match(result.content[0].text, /\[2026-10-01T12:00:00Z\] sms\.received → delivered \(200\) id=dlv_1/);
  assert.match(result.content[0].text, /\[2026-10-01T12:00:00Z\] call\.ended → failed \(502\) id=dlv_2/);
  assert.match(result.content[0].text, /Total: 2/);
  assert.equal(result.structuredContent.data[0].messageId, "msg_1");
  assert.equal(result.structuredContent.data[0].channel, "sms");
  assert.equal(result.structuredContent.data[0].attemptCount, 1);
});

test("list_webhook_deliveries reads the documented agent response", async () => {
  const { seen, result } = await withDeliveryFetch([DELIVERY], () =>
    harness(new AgentPhoneAPI("https://example.test", "key")).call("list_webhook_deliveries", { agent_id: "agt_1" })
  );
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(seen, ["GET https://example.test/v1/agents/agt_1/webhook/deliveries?limit=20"]);
  assert.match(result.content[0].text, /sms\.received → delivered \(200\) id=dlv_1/);
  assert.doesNotMatch(result.content[0].text, /Total:/);
  assert.equal(Object.hasOwn(result.structuredContent, "total"), false);
});

test("list_webhook_deliveries rejects an unsupported agent time filter before fetching", async () => {
  const { seen, result } = await withDeliveryFetch([DELIVERY], () =>
    harness(new AgentPhoneAPI("https://example.test", "key")).call("list_webhook_deliveries", {
      agent_id: "agt_1", hours: 24,
    })
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /hours.*project-level.*agent_id/i);
  assert.deepEqual(seen, []);
});

test("list_webhook_deliveries preserves the supported project time filter", async () => {
  const payload = { items: [], total: 0, offset: 0, limit: 7 };
  const { seen, result } = await withDeliveryFetch(payload, () =>
    harness(new AgentPhoneAPI("https://example.test", "key")).call("list_webhook_deliveries", {
      hours: 24, limit: 7,
    })
  );
  assert.equal(result.isError, undefined, result.content[0].text);
  assert.deepEqual(seen, ["GET https://example.test/v1/webhooks/deliveries?limit=7&hours=24"]);
  assert.deepEqual(result.structuredContent, { data: [], total: 0 });
});

// ---------------------------------------------------------------------------
// watch_messages (Wakeshift): registration gate, access check, de-duplication,
// output, and what it subscribes to. withCall records the subscriptions the
// handler makes, without a key or a network.
// ---------------------------------------------------------------------------

function watchHarness(apiStub, opts = { watchMessages: true }) {
  const tools = new Map();
  const calls = [];
  const api = new Proxy(apiStub, {
    get(target, name) {
      return async (...args) => {
        calls.push({ name, args });
        if (!(name in target)) throw new Error(`unexpected API call: ${String(name)}`);
        return target[name](...args);
      };
    },
  });
  registerTools(
    {
      tool(name, description, schema, annotationsOrHandler, maybeHandler) {
        const handler = typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler;
        const annotations = typeof annotationsOrHandler === "function" ? {} : annotationsOrHandler;
        tools.set(name, { schema, handler, annotations });
      },
    },
    api,
    opts
  );
  return {
    calls,
    has: (name) => tools.has(name),
    annotations: (name) => tools.get(name).annotations,
    // Runs the handler inside a stand-in Wakeshift call; returns its result and subscriptions.
    call: async (name, args) => {
      const t = tools.get(name);
      const parsed = await z.object(t.schema).parseAsync(args);
      const call = createToolCall({ tool: name });
      const result = await withCall(wake, call, () => t.handler(parsed));
      return { result, subscriptions: call.subscriptions.map((s) => s.args.number) };
    },
  };
}

const NUMBERS = {
  num_a: { id: "num_a", phoneNumber: "+14155550001" },
  num_b: { id: "num_b", phoneNumber: "+14155550002" },
};
const getNumber = async (id) => {
  if (NUMBERS[id]) return NUMBERS[id];
  throw new ApiError(404, "GET", `/v1/numbers/${id}`, "Number not found");
};

test("watch_messages is offered only with { watchMessages: true }", () => {
  assert.equal(watchHarness({}, {}).has("watch_messages"), false);
  assert.equal(watchHarness({}).has("watch_messages"), true);
});

test("watch_messages is not read-only (it creates subscriptions) but is idempotent", () => {
  const a = watchHarness({}).annotations("watch_messages");
  assert.equal(a.readOnlyHint, false);
  assert.equal(a.idempotentHint, true);
});

test("watch_messages subscribes every number in one call, de-duplicated", async () => {
  const h = watchHarness({ getNumber });
  const { result, subscriptions } = await h.call("watch_messages", { number_ids: ["num_a", "num_b", "num_a"] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(subscriptions, ["num_a", "num_b"]);
  assert.deepEqual(result.structuredContent, {
    watching: [
      { number_id: "num_a", phone_number: "+14155550001" },
      { number_id: "num_b", phone_number: "+14155550002" },
    ],
  });
  assert.equal(h.calls.filter((c) => c.name === "getNumber").length, 2, "each number is checked once");
});

test("watch_messages subscribes nothing when the caller can't read one of the numbers", async () => {
  const h = watchHarness({ getNumber });
  const { result, subscriptions } = await h.call("watch_messages", { number_ids: ["num_a", "num_missing"] });
  assert.equal(result.isError, true);
  assert.deepEqual(subscriptions, [], "the access check runs before any subscribe");
});

test("watch_messages needs at least one number", async () => {
  const h = watchHarness({ getNumber });
  await assert.rejects(() => h.call("watch_messages", { number_ids: [] }));
});

test("message.received emit ids are fixed-length and distinct for long IDs", () => {
  const long = "x".repeat(200);
  const a = messageEventId(long, long + "a");
  const b = messageEventId(long, long + "b");
  assert.notEqual(a, b);
  assert.ok(a.length <= 200 && b.length === a.length);
  assert.equal(messageEventId("num_1", "msg_1"), messageEventId("num_1", "msg_1"), "same message, same id");
});

// ---------------------------------------------------------------------------
// watch_messages backend registration (/internal/watches): best-effort, called
// once per watched number, and a failure never fails the tool.
// ---------------------------------------------------------------------------

const WATCH_TTL_SECONDS = 24 * 60 * 60;

test("watch_messages registers each watched number with the backend", async () => {
  const seen = [];
  const h = watchHarness({ getNumber }, {
    watchMessages: true,
    registerWatch: async (numberId, ttl) => {
      seen.push([numberId, ttl]);
      return "watched";
    },
  });
  const { result } = await h.call("watch_messages", { number_ids: ["num_a", "num_b", "num_a"] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(seen, [["num_a", WATCH_TTL_SECONDS], ["num_b", WATCH_TTL_SECONDS]]);
});

test("a failing backend registration does not fail watch_messages", async () => {
  const h = watchHarness({ getNumber }, {
    watchMessages: true,
    registerWatch: async () => "error",
  });
  const { result, subscriptions } = await h.call("watch_messages", { number_ids: ["num_a"] });
  assert.equal(result.isError, undefined, "tool still succeeds");
  assert.deepEqual(subscriptions, ["num_a"], "the Wakeshift subscription still happened");
});

test("watch_messages works when no registrar is wired (registration optional)", async () => {
  const h = watchHarness({ getNumber }, { watchMessages: true });
  const { result } = await h.call("watch_messages", { number_ids: ["num_a"] });
  assert.equal(result.isError, undefined);
});
