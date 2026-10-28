import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerTools } from "../dist/tools.js";
import { OUTPUT_SCHEMAS } from "../dist/output-schemas.js";

// Every tool declares an outputSchema, so the SDK validates each successful
// result's structuredContent against it on every call. This drives the REAL
// handlers (registered by registerTools) against a stub API and asserts their
// structuredContent parses — the same check the SDK performs at runtime — so a
// handler and its schema cannot drift out of sense without a test failure.

// --- Stub API: realistic responses mirroring api.ts, no network ---
const num = { id: "num_1", phoneNumber: "+14155550123", country: "US", status: "active", agentId: null, createdAt: "t" };
const agentNum = { id: "num_1", phoneNumber: "+14155550123", status: "active" };
const agent = {
  id: "agt_1", name: "Support", description: null, voiceMode: "hosted", systemPrompt: null,
  beginMessage: null, voice: "Skylar", modelTier: "balanced", transferNumber: null, voicemailMessage: null,
  sttMode: "fast", ambientSound: "none", denoisingMode: "noise-cancellation", maxSilenceMs: 600000,
  enableMessaging: true, enableBackchannel: true, interruptionSensitivity: 0.8, voiceSpeed: 1,
  language: "en-US", createdAt: "t", numbers: [agentNum],
};
const call = { id: "call_1", fromNumber: "+1415", toNumber: "+1310", direction: "outbound", status: "completed", startedAt: "t", endedAt: null, agentId: null, phoneNumberId: "num_1", retellCallId: null, transcripts: [{ id: "t1", transcript: "hi", response: null, createdAt: "t" }] };
const conv = { id: "conv_1", agentId: null, phoneNumberId: "num_1", phoneNumber: "+1415", participant: "+1310", lastMessageAt: null, lastMessagePreview: "hi", messageCount: 2, metadata: null, createdAt: "t" };
const convFull = { ...conv, messages: [{ id: "m1", body: "hi", fromNumber: "+1310", toNumber: "+1415", direction: "inbound", receivedAt: "t" }] };
const contact = { id: "ct_1", phoneNumber: "+1310", name: "Jo", email: null, notes: null, createdAt: "t", updatedAt: "t" };
const webhook = { id: "wh_1", url: "https://x", secret: "whsec_realish", status: "active", contextLimit: 10, createdAt: "t" };
const delivery = { id: "d1", messageId: null, eventType: "sms.received", channel: "sms", status: "delivered", httpStatus: null, errorMessage: null, responseBody: null, attemptCount: 1, lastAttemptAt: null, nextRetryAt: null, createdAt: "t" };
const voice = { voice_id: "v1", voice_name: "Skylar", provider: "p", gender: "f", accent: "us", preview_audio_url: null };
const msg = { id: "m1", from: "+1415", to: "+1310", body: "hi", receivedAt: "t" };
const usage = { numbers: { used: 1, limit: 5, remaining: 4 }, stats: { totalMessages: 1, messagesLast24h: 0, messagesLast7d: 0, messagesLast30d: 0, smsSegmentsLast30d: 0, totalCalls: 0, callsLast24h: 0, callsLast7d: 0, callsLast30d: 0, totalWebhookDeliveries: 0, successfulWebhookDeliveries: 0, failedWebhookDeliveries: 0 }, periodStart: "t", periodEnd: "t" };

function makeStub(overrides = {}) {
  return {
    listNumbers: async () => ({ data: [num], hasMore: false, total: 1 }),
    buyNumber: async () => num,
    getMessages: async () => ({ data: [msg], hasMore: false }),
    sendMessage: async () => ({ id: "m1", status: "sent", channel: "sms", from_number: "+1415", to_number: "+1310", media_urls: [], reply_to_message_id: null, reply_parent_unresolved: null }),
    sendReaction: async () => ({ id: "r1", reaction_type: "love", message_id: "m1", channel: "imessage" }),
    listVoices: async () => ({ data: [voice] }),
    listAgents: async () => ({ data: [agent], total: 1 }),
    createAgent: async () => agent,
    updateAgent: async () => agent,
    deleteAgent: async () => ({ success: true, id: "agt_1", name: "Support" }),
    getAgent: async () => agent,
    attachNumber: async () => ({ agentId: "agt_1", number: agentNum }),
    detachNumber: async () => ({ success: true }),
    listConversations: async () => ({ data: [conv], hasMore: false, total: 1 }),
    getConversation: async () => convFull,
    updateConversation: async () => conv,
    listCalls: async () => ({ data: [call], hasMore: false, total: 1 }),
    getCall: async () => call,
    makeCall: async () => ({ id: "call_1", fromNumber: "+1415", toNumber: "+1310", direction: "outbound", status: "ringing", startedAt: "t", retellCallId: null }),
    makeConversationCall: async () => call,
    listContacts: async () => ({ data: [contact], hasMore: false, total: 1 }),
    createContact: async () => contact,
    updateContact: async () => contact,
    deleteContact: async () => ({ success: true }),
    getWebhook: async () => webhook,
    setWebhook: async () => webhook,
    deleteWebhook: async () => ({ success: true }),
    testWebhook: async () => ({ success: true, statusCode: 200, responseMs: 42, error: null }),
    listWebhookDeliveries: async () => ({ data: [delivery], hasMore: false, total: 1 }),
    getUsage: async () => usage,
    getDailyUsage: async () => ({ data: [{ date: "2026-01-01", messages: 1, calls: 2, webhooks: 3 }], days: 30 }),
    getMonthlyUsage: async () => ({ data: [{ month: "2026-01", messages: 1, calls: 2, webhooks: 3 }], months: 12 }),
    ...overrides,
  };
}

// Recording registrar — names + handlers come from registerTools(), not a list.
function harness(apiStub) {
  const tools = new Map();
  const registrar = {
    tool(name, description, schema, annotationsOrHandler, maybeHandler) {
      const handler = typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler;
      tools.set(name, { schema, handler });
    },
  };
  registerTools(registrar, apiStub);
  return {
    names: () => [...tools.keys()],
    call: async (name, args) => {
      const t = tools.get(name);
      return t.handler(await z.object(t.schema).parseAsync(args ?? {}));
    },
  };
}

// Valid arguments that take each tool down its API-calling success path.
const ARGS = {
  account_overview: {},
  list_numbers: {},
  buy_number: { confirm: true },
  send_message: { agent_id: "agt_1", to_number: "+14155550123", body: "hi" },
  get_messages: { number_id: "num_1" },
  list_calls: {},
  get_call: { call_id: "call_1" },
  make_call: { agent_id: "agt_1", to_number: "+14155550123" },
  make_conversation_call: { agent_id: "agt_1", to_number: "+14155550123", topic: "x", wait: false },
  list_agents: {},
  create_agent: { name: "X" },
  update_agent: { agent_id: "agt_1" },
  delete_agent: { agent_id: "agt_1" },
  get_agent: { agent_id: "agt_1" },
  attach_number: { agent_id: "agt_1", number_id: "num_1" },
  detach_number: { agent_id: "agt_1", number_id: "num_1" },
  list_voices: {},
  list_conversations: {},
  get_conversation: { conversation_id: "conv_1" },
  update_conversation: { conversation_id: "conv_1", metadata: { a: 1 } },
  list_contacts: {},
  manage_contact: { action: "create", phone_number: "+14155550123", name: "Jo" },
  get_usage: {},
  get_webhook: {},
  set_webhook: { url: "https://example.com/hook" },
  delete_webhook: {},
  test_webhook: {},
  list_webhook_deliveries: {},
};

test("input schemas enforce canonical bounds and enums (#197)", () => {
  const schemas = {};
  registerTools({ tool: (name, _d, schema) => { schemas[name] = z.object(schema); } }, makeStub());
  // out of range / wrong type -> rejected
  assert.equal(schemas.list_numbers.safeParse({ limit: 201 }).success, false, "limit 201");
  assert.equal(schemas.list_numbers.safeParse({ limit: 1.5 }).success, false, "non-integer limit");
  assert.equal(schemas.list_numbers.safeParse({ offset: -1 }).success, false, "negative offset");
  assert.equal(schemas.get_messages.safeParse({ number_id: "n", limit: 201 }).success, false, "messages limit 201");
  assert.equal(schemas.create_agent.safeParse({ name: "x", voice_speed: 9 }).success, false, "voice_speed 9");
  assert.equal(schemas.create_agent.safeParse({ name: "x", max_silence_ms: 1 }).success, false, "max_silence_ms 1");
  assert.equal(schemas.list_calls.safeParse({ direction: "sideways" }).success, false, "bad direction enum");
  // valid values accepted
  assert.equal(schemas.list_numbers.safeParse({ limit: 50 }).success, true);
  assert.equal(schemas.create_agent.safeParse({ name: "x", voice_speed: 1.5 }).success, true);
  assert.equal(schemas.list_calls.safeParse({ direction: "inbound" }).success, true);
  // exact edges (catch off-by-one bound changes)
  assert.equal(schemas.list_numbers.safeParse({ limit: 100 }).success, true, "limit 100 at max");
  assert.equal(schemas.list_numbers.safeParse({ limit: 101 }).success, false, "limit 101 over max");
  assert.equal(schemas.list_numbers.safeParse({ limit: 1 }).success, true, "limit 1 at min");
  assert.equal(schemas.list_numbers.safeParse({ limit: 0 }).success, false, "limit 0 under min");
  assert.equal(schemas.create_agent.safeParse({ name: "x", voice_speed: 2 }).success, true, "voice_speed 2 at max");
  assert.equal(schemas.create_agent.safeParse({ name: "x", voice_speed: 2.01 }).success, false, "voice_speed over max");
  assert.equal(schemas.create_agent.safeParse({ name: "x", voice_speed: 0.5 }).success, true, "voice_speed 0.5 at min");
  assert.equal(schemas.create_agent.safeParse({ name: "x", max_silence_ms: 10000 }).success, true, "max_silence_ms at min");
  assert.equal(schemas.create_agent.safeParse({ name: "x", max_silence_ms: 9999 }).success, false, "max_silence_ms under min");
});

test("registered tools and OUTPUT_SCHEMAS are the same set (no drift)", () => {
  const registered = new Set(harness(makeStub()).names());
  assert.equal(registered.size, 28);
  for (const name of registered) assert.ok(OUTPUT_SCHEMAS[name], `tool ${name} has no output schema`);
  for (const name of Object.keys(OUTPUT_SCHEMAS)) assert.ok(registered.has(name), `output schema ${name} has no tool`);
});

test("each handler's structuredContent validates against its output schema", async () => {
  const h = harness(makeStub());
  for (const [name, args] of Object.entries(ARGS)) {
    const r = await h.call(name, args);
    assert.equal(r.isError, undefined, `${name}: unexpected error: ${r.isError ? r.content[0].text : ""}`);
    assert.ok(r.structuredContent, `${name}: missing structuredContent`);
    const parsed = OUTPUT_SCHEMAS[name].safeParse(r.structuredContent);
    assert.ok(parsed.success, `${name}: structuredContent failed schema: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
  }
});

test("list_webhook_deliveries advertises the documented delivery fields", () => {
  const entry = OUTPUT_SCHEMAS.list_webhook_deliveries.shape.data.element.shape;
  for (const field of ["eventType", "status", "httpStatus", "lastAttemptAt", "createdAt"]) {
    assert.ok(entry[field], `missing ${field}`);
  }
  assert.equal(entry.eventType.safeParse(null).success, true);
  assert.equal(entry.httpStatus.safeParse(null).success, true);
  assert.equal(entry.lastAttemptAt.safeParse(null).success, true);
  assert.equal(entry.status.safeParse(null).success, false);
  assert.equal(entry.createdAt.safeParse(null).success, false);
});

test("make_conversation_call wait=true text matches ended/transcript state", async () => {
  const base = { id: "c", fromNumber: "+1", toNumber: "+2", direction: "outbound", status: "x", startedAt: "t", retellCallId: null };
  const T = [{ id: "t1", transcript: "hi", response: "hello", createdAt: "t" }];
  const cases = [
    { endedAt: "t", transcripts: T, expect: [/Call completed!/, /Transcript:/], notExpect: [/in progress/] },
    { endedAt: "t", transcripts: [], expect: [/Call completed!/, /no transcript was recorded/], notExpect: [/in progress/] },
    { endedAt: null, transcripts: T, expect: [/still in progress/, /Partial transcript so far/, /get_call/], notExpect: [/completed!/] },
    { endedAt: null, transcripts: [], expect: [/still in progress/, /No transcript yet/, /get_call/], notExpect: [/completed!/] },
  ];
  for (const c of cases) {
    const h = harness(makeStub({ makeConversationCall: async () => ({ ...base, endedAt: c.endedAt, transcripts: c.transcripts }) }));
    const r = await h.call("make_conversation_call", { agent_id: "a", to_number: "+14155550123", topic: "x", wait: true });
    const text = r.content[0].text;
    for (const re of c.expect) assert.match(text, re, `ended=${c.endedAt}, turns=${c.transcripts.length}: expected ${re}`);
    for (const re of c.notExpect) assert.doesNotMatch(text, re, `ended=${c.endedAt}, turns=${c.transcripts.length}: should not match ${re}`);
  }
});

test("send_message reaction mode also validates", async () => {
  const h = harness(makeStub());
  const r = await h.call("send_message", { react_to_message_id: "m1", reaction: "love" });
  assert.equal(r.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.send_message.safeParse(r.structuredContent).success);
});

test("buy_number confirmation prompt validates", async () => {
  const h = harness(makeStub());
  const r = await h.call("buy_number", { confirm: false });
  assert.ok(OUTPUT_SCHEMAS.buy_number.safeParse(r.structuredContent).success);
  assert.equal(r.structuredContent.confirmationRequired, true);
});

test("get_usage daily and monthly branches validate", async () => {
  const h = harness(makeStub());
  for (const breakdown of ["daily", "monthly"]) {
    const r = await h.call("get_usage", { breakdown });
    assert.ok(OUTPUT_SCHEMAS.get_usage.safeParse(r.structuredContent).success, `get_usage ${breakdown}`);
  }
});

test("empty paged lists keep the real total, not a fabricated zero", async () => {
  // Out-of-range offset: no rows on this page, but total is still positive.
  const empty = {
    listCalls: async () => ({ data: [], hasMore: false, total: 7 }),
    listConversations: async () => ({ data: [], hasMore: false, total: 7 }),
    listContacts: async () => ({ data: [], hasMore: false, total: 7 }),
  };
  const h = harness(makeStub(empty));
  for (const name of ["list_calls", "list_conversations", "list_contacts"]) {
    const r = await h.call(name, { offset: 999 });
    assert.ok(OUTPUT_SCHEMAS[name].safeParse(r.structuredContent).success, name);
    assert.equal(r.structuredContent.total, 7, `${name}: should report real total, not 0`);
  }
});

test("account_overview reports failed webhook lookup as omitted, not null", async () => {
  const h = harness(makeStub({ getWebhook: async () => { throw new Error("boom"); } }));
  const r = await h.call("account_overview", {});
  assert.ok(OUTPUT_SCHEMAS.account_overview.safeParse(r.structuredContent).success);
  // A rejected lookup must not look like "no webhook configured" (null).
  assert.equal("webhook" in r.structuredContent && r.structuredContent.webhook === null, false);
});

test("webhook tools mask the signing secret in structuredContent by default", async () => {
  const h = harness(makeStub());
  for (const [name, args] of [["get_webhook", {}], ["set_webhook", { url: "https://example.com/hook" }]]) {
    const r = await h.call(name, args);
    assert.ok(OUTPUT_SCHEMAS[name].safeParse(r.structuredContent).success, name);
    assert.doesNotMatch(r.structuredContent.secret, /realish/, `${name} leaked the secret in structuredContent`);
    assert.match(r.structuredContent.secret, /masked/, `${name} should mask the secret`);
  }
});

test("webhook structuredContent includes the real secret only with reveal_secret=true", async () => {
  const h = harness(makeStub());
  const r = await h.call("get_webhook", { reveal_secret: true });
  assert.equal(r.structuredContent.secret, "whsec_realish");
});

test("manage_contact update and delete validate (delete passes the real success value)", async () => {
  const h = harness(makeStub());
  const upd = await h.call("manage_contact", { action: "update", contact_id: "ct_1", name: "Jo2" });
  assert.equal(upd.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.manage_contact.safeParse(upd.structuredContent).success);
  const del = await h.call("manage_contact", { action: "delete", contact_id: "ct_1" });
  assert.equal(del.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.manage_contact.safeParse(del.structuredContent).success);
  assert.equal(del.structuredContent.success, true);
});

// Regression for #93 at the handler layer: a DELETE that comes back as {} (a
// 204) must still yield a schema-valid result, not a validation error.
test("delete-style tools tolerate an empty ({}) API result (#93)", async () => {
  const h = harness(makeStub({ detachNumber: async () => ({}), deleteContact: async () => ({}) }));
  const d = await h.call("detach_number", { agent_id: "a", number_id: "n" });
  assert.equal(d.isError, undefined, "detach_number should not error on {}");
  assert.ok(OUTPUT_SCHEMAS.detach_number.safeParse(d.structuredContent).success, "detach_number tolerates {}");
  assert.equal(d.structuredContent.success, true);

  const c = await h.call("manage_contact", { action: "delete", contact_id: "ct_1" });
  assert.equal(c.isError, undefined, "manage_contact delete should not error on {}");
  assert.ok(OUTPUT_SCHEMAS.manage_contact.safeParse(c.structuredContent).success, "manage_contact delete tolerates {}");
});

// There is no structured-content fallback: every success path must return its
// own structuredContent, and it must satisfy the (now stricter) output schema.
// Cover the branches the main pass doesn't, so a missing field can't slip
// through to a runtime throw.
test("alternate success branches still return schema-valid structured content", async () => {
  // get_webhook when none is configured
  let h = harness(makeStub({ getWebhook: async () => null }));
  let r = await h.call("get_webhook", {});
  assert.equal(r.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.get_webhook.safeParse(r.structuredContent).success, "get_webhook/none");

  // make_conversation_call that completed with a transcript (wait=true)
  h = harness(makeStub());
  r = await h.call("make_conversation_call", { agent_id: "agt_1", to_number: "+14155550123", topic: "x", wait: true });
  assert.equal(r.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.make_conversation_call.safeParse(r.structuredContent).success, "mcc/transcript");

  // empty list variants that don't carry a `total`
  const emptyStub = {
    getMessages: async () => ({ data: [], hasMore: false }),
    listVoices: async () => ({ data: [] }),
    listWebhookDeliveries: async () => ({ data: [], hasMore: false, total: 0 }),
  };
  h = harness(makeStub(emptyStub));
  for (const [name, args] of [["get_messages", { number_id: "num_1" }], ["list_voices", {}], ["list_webhook_deliveries", {}]]) {
    r = await h.call(name, args);
    assert.equal(r.isError, undefined, name);
    assert.ok(r.structuredContent, `${name}: missing structuredContent`);
    assert.ok(OUTPUT_SCHEMAS[name].safeParse(r.structuredContent).success, `${name}: empty branch`);
  }
});

// Every field marked required in the schemas. Enumerated explicitly so that
// re-optionalizing any one of them fails this test instead of slipping through.
const REQUIRED = {
  list_numbers: ["data"],
  get_messages: ["data"],
  list_calls: ["data"],
  list_agents: ["data"],
  list_voices: ["data"],
  list_conversations: ["data"],
  list_contacts: ["data"],
  list_webhook_deliveries: ["data"],
  get_call: ["id"],
  make_call: ["id"],
  make_conversation_call: ["id"],
  create_agent: ["id"],
  update_agent: ["id"],
  get_agent: ["id"],
  send_message: ["id"],
  get_conversation: ["id"],
  update_conversation: ["id"],
  delete_agent: ["success", "id", "name"],
  attach_number: ["agentId", "number"],
  detach_number: ["success"],
  delete_webhook: ["success"],
  test_webhook: ["success", "statusCode", "responseMs", "error"],
};
const VAL = { id: "x", name: "x", agentId: "x", data: [], success: true, number: {}, statusCode: null, responseMs: null, error: null };

test("every required output field is enforced (omitting any one fails)", () => {
  for (const [tool, fields] of Object.entries(REQUIRED)) {
    const full = Object.fromEntries(fields.map((f) => [f, VAL[f]]));
    assert.ok(OUTPUT_SCHEMAS[tool].safeParse(full).success, `${tool}: full required object should parse`);
    for (const f of fields) {
      const missing = { ...full };
      delete missing[f];
      assert.equal(
        OUTPUT_SCHEMAS[tool].safeParse(missing).success,
        false,
        `${tool}.${f} must be required (schema accepted it missing)`
      );
    }
  }
});

// AgentResponse.numbers and CallSummary.phoneNumberId are documented as nullable.

const AGENT_WITHOUT_NUMBERS = { ...agent, numbers: null };
const CALL_WITHOUT_PHONE_NUMBER = { ...call, phoneNumberId: null };

async function callAndValidate(name, args, stub) {
  const h = harness(makeStub(stub));
  const r = await h.call(name, args);
  assert.equal(r.isError, undefined, `${name}: unexpected error: ${r.isError ? r.content[0].text : ""}`);
  const parsed = OUTPUT_SCHEMAS[name].safeParse(r.structuredContent);
  assert.ok(parsed.success, `${name}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues)}`);
  return r;
}

test("get_agent accepts documented numbers: null", async () => {
  const r = await callAndValidate("get_agent", { agent_id: "agt_1" }, { getAgent: async () => AGENT_WITHOUT_NUMBERS });
  assert.equal(r.structuredContent.numbers, null);
});

test("list_agents accepts documented numbers: null", async () => {
  const r = await callAndValidate("list_agents", {}, { listAgents: async () => ({ data: [AGENT_WITHOUT_NUMBERS], total: 1 }) });
  assert.equal(r.structuredContent.data[0].numbers, null);
});

test("create_agent accepts documented numbers: null", async () => {
  const r = await callAndValidate("create_agent", { name: "X" }, { createAgent: async () => AGENT_WITHOUT_NUMBERS });
  assert.equal(r.structuredContent.numbers, null);
});

test("account_overview accepts agents with documented numbers: null", async () => {
  const r = await callAndValidate("account_overview", {}, { listAgents: async () => ({ data: [AGENT_WITHOUT_NUMBERS], total: 1 }) });
  assert.equal(r.structuredContent.agents[0].numbers, null);
});

test("list_calls accepts documented phoneNumberId: null", async () => {
  const r = await callAndValidate("list_calls", {}, { listCalls: async () => ({ data: [CALL_WITHOUT_PHONE_NUMBER], hasMore: false, total: 1 }) });
  assert.equal(r.structuredContent.data[0].phoneNumberId, null);
});

test("get_call accepts documented phoneNumberId: null", async () => {
  const r = await callAndValidate("get_call", { call_id: "call_1" }, { getCall: async () => CALL_WITHOUT_PHONE_NUMBER });
  assert.equal(r.structuredContent.phoneNumberId, null);
});
