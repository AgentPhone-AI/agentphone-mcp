import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerTools } from "../dist/tools.js";
import { OUTPUT_SCHEMAS } from "../dist/output-schemas.js";
import { ApiError } from "../dist/api.js";

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
    getContactCapabilities: async () => ({ phoneNumber: "+14155550123", capabilities: { imessage: true, sms: true, rcs: false }, checkedAt: "t" }),
    getNumber: async () => ({ id: "num_1", phoneNumber: "+14155550123", country: "US", status: "active", type: "local", agentId: "agt_1", outboundSms: "enabled", inboundCallsEnabled: true, whatsappEnabled: true }),
    getRegisterStatus: async () => ({ campaign_status: "approved", message: "ok", stage: null, issue: null, sub_account_id: null }),
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
    getConversationMessages: async () => ({ data: [convFull.messages[0]], hasMore: false, nextCursor: null }),
    updateConversation: async () => conv,
    listCalls: async () => ({ data: [call], hasMore: false, total: 1 }),
    listCallsForNumber: async () => ({ data: [call], hasMore: false, total: 1 }),
    listAgentCalls: async () => ({ data: [call], hasMore: false, total: 1 }),
    getCall: async () => call,
    endCall: async () => ({ id: "call_1", status: "completed", endedAt: "t", success: true }),
    makeCall: async () => ({ id: "call_1", fromNumber: "+1415", toNumber: "+1310", direction: "outbound", status: "ringing", startedAt: "t", retellCallId: null }),
    makeConversationCall: async () => call,
    listContacts: async () => ({ data: [contact], hasMore: false, total: 1 }),
    createContact: async () => contact,
    updateContact: async () => contact,
    deleteContact: async () => ({ success: true }),
    getWebhook: async () => webhook,
    setWebhook: async () => webhook,
    deleteWebhook: async () => ({ success: true }),
    testWebhook: async () => ({ success: true, httpStatus: 200, errorMessage: null }),
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
    schema: (name) => tools.get(name).schema,
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
  check_capabilities: { phone_number: "+14155550123" },
  check_readiness: { number_id: "num_1" },
  get_messages: { number_id: "num_1" },
  list_calls: {},
  get_call: { call_id: "call_1" },
  end_call: { call_id: "call_1" },
  make_call: { agent_id: "agt_1", to_number: "+14155550123" },
  make_conversation_call: { agent_id: "agt_1", to_number: "+14155550123", topic: "x" },
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
  get_conversation_messages: { conversation_id: "conv_1" },
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

test("test_webhook uses the real success/httpStatus/errorMessage contract (#191)", async () => {
  // Real deployed shape.
  let h = harness(makeStub({ testWebhook: async () => ({ success: false, httpStatus: 500, errorMessage: "boom" }) }));
  let r = await h.call("test_webhook", {});
  assert.equal(r.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.test_webhook.safeParse(r.structuredContent).success, "schema accepts real shape");
  assert.equal(r.structuredContent.httpStatus, 500);
  assert.equal(r.structuredContent.errorMessage, "boom");
  assert.match(r.content[0].text, /500/);
  assert.match(r.content[0].text, /boom/);
  // Legacy statusCode/error still normalize into httpStatus/errorMessage.
  h = harness(makeStub({ testWebhook: async () => ({ success: false, statusCode: 502, error: "legacy boom" }) }));
  r = await h.call("test_webhook", {});
  assert.equal(r.structuredContent.httpStatus, 502);
  assert.equal(r.structuredContent.errorMessage, "legacy boom");
  assert.match(r.content[0].text, /legacy boom/);
  assert.ok(OUTPUT_SCHEMAS.test_webhook.safeParse(r.structuredContent).success);
});

test("timeouts: outcome-unknown for mutations, safe retry for reads (#198)", async () => {
  // A mutation (POST) timeout must not advise a blind retry.
  let h = harness(makeStub({ sendMessage: async () => { throw new ApiError(0, "POST", "/v1/messages", "Request timed out after 30000ms"); } }));
  let r = await h.call("send_message", { agent_id: "a", to_number: "+14155550123", body: "hi" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /outcome is UNKNOWN/);
  assert.match(r.content[0].text, /Do NOT blindly retry/);

  // A read (GET) timeout is safe to retry.
  h = harness(makeStub({ getCall: async () => { throw new ApiError(0, "GET", "/v1/calls/call_1", "Request timed out"); } }));
  r = await h.call("get_call", { call_id: "call_1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /safe to retry with bounded backoff/);
  assert.doesNotMatch(r.content[0].text, /UNKNOWN/);
});

test("get_messages follows the cursor across identical-timestamp pages with no gaps (#196)", async () => {
  // Two pages whose messages all share the SAME timestamp — the exact case a
  // before/after time filter cannot page reliably. Following nextCursor must
  // return every message exactly once.
  const TS = "2026-01-01T00:00:00.000Z";
  const page1 = { data: [{ id: "m1", from: "+1", to: "+2", body: "a", receivedAt: TS }, { id: "m2", from: "+1", to: "+2", body: "b", receivedAt: TS }], hasMore: true, nextCursor: "CUR2" };
  const page2 = { data: [{ id: "m3", from: "+1", to: "+2", body: "c", receivedAt: TS }], hasMore: false, nextCursor: null };
  const calls = [];
  const h = harness(makeStub({
    getMessages: async (numberId, limit, opts) => { calls.push({ numberId, limit, opts }); return opts?.cursor === "CUR2" ? page2 : page1; },
  }));

  const r1 = await h.call("get_messages", { number_id: "num_1", limit: 2 });
  assert.equal(r1.structuredContent.hasMore, true);
  assert.equal(r1.structuredContent.nextCursor, "CUR2");
  assert.match(r1.content[0].text, /cursor="CUR2"/);

  const r2 = await h.call("get_messages", { number_id: "num_1", limit: 2, cursor: "CUR2" });
  assert.equal(r2.structuredContent.hasMore, false);
  assert.doesNotMatch(r2.content[0].text, /More available/);

  // Cursor was forwarded to the API, not before/after.
  assert.equal(calls[1].opts.cursor, "CUR2");
  // Union of ids: every message once, no omissions or duplicates.
  const ids = [...r1.structuredContent.data, ...r2.structuredContent.data].map((m) => m.id);
  assert.deepEqual(ids, ["m1", "m2", "m3"]);
  assert.equal(new Set(ids).size, ids.length);
});

test("get_messages reports an empty terminal page distinctly (#196)", async () => {
  const h = harness(makeStub({ getMessages: async () => ({ data: [], hasMore: false, nextCursor: null }) }));
  const r = await h.call("get_messages", { number_id: "num_1", cursor: "LAST" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /No more messages/);
  assert.ok(OUTPUT_SCHEMAS.get_messages.safeParse(r.structuredContent).success);
});

test("get_conversation_messages pages a conversation by cursor (#196)", async () => {
  const TS = "2026-01-01T00:00:00.000Z";
  const calls = [];
  const h = harness(makeStub({
    getConversationMessages: async (id, limit, opts) => {
      calls.push({ id, opts });
      return opts?.cursor
        ? { data: [{ id: "c2", body: "y", fromNumber: "+2", toNumber: "+1", direction: "outbound", receivedAt: TS }], hasMore: false, nextCursor: null }
        : { data: [{ id: "c1", body: "x", fromNumber: "+1", toNumber: "+2", direction: "inbound", receivedAt: TS }], hasMore: true, nextCursor: "N" };
    },
  }));
  const r1 = await h.call("get_conversation_messages", { conversation_id: "conv_1" });
  assert.equal(r1.structuredContent.nextCursor, "N");
  assert.match(r1.content[0].text, /cursor="N"/);
  const r2 = await h.call("get_conversation_messages", { conversation_id: "conv_1", cursor: "N" });
  assert.equal(r2.structuredContent.hasMore, false);
  assert.equal(calls[1].opts.cursor, "N");
  assert.ok(OUTPUT_SCHEMAS.get_conversation_messages.safeParse(r2.structuredContent).success);
});

test("list_agents exposes offset and a truncation/continuation signal (#196)", async () => {
  const calls = [];
  const h = harness(makeStub({
    listAgents: async (limit, offset) => { calls.push({ limit, offset }); return { data: [agent, agent], total: 5 }; },
  }));
  const r = await h.call("list_agents", { limit: 2, offset: 0 });
  assert.equal(calls[0].offset, 0);
  assert.equal(r.structuredContent.hasMore, true);
  assert.match(r.content[0].text, /of 5/);
  assert.match(r.content[0].text, /offset=2/);
  // Last page: no continuation.
  const h2 = harness(makeStub({ listAgents: async () => ({ data: [agent], total: 1 }) }));
  const r2 = await h2.call("list_agents", { limit: 2, offset: 0 });
  assert.equal(r2.structuredContent.hasMore, false);
  assert.doesNotMatch(r2.content[0].text, /next page/);
});

test("account_overview marks truncated agent/number sections (#196)", async () => {
  const many = Array.from({ length: 100 }, () => agent);
  const h = harness(makeStub({
    listAgents: async () => ({ data: many, total: 250 }),
    listNumbers: async () => ({ data: many.map(() => num), hasMore: true, total: 180 }),
  }));
  const r = await h.call("account_overview", {});
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.truncation.agents.hasMore, true);
  assert.equal(r.structuredContent.truncation.agents.total, 250);
  assert.equal(r.structuredContent.truncation.numbers.hasMore, true);
  assert.match(r.content[0].text, /showing 100 of 250/);
  assert.match(r.content[0].text, /showing 100 of 180/);
  assert.ok(OUTPUT_SCHEMAS.account_overview.safeParse(r.structuredContent).success);
});

test("list_calls composes supported filters or rejects unsupported combinations (#196)", async () => {
  // Account-wide: filters forwarded and echoed back.
  const seen = {};
  let h = harness(makeStub({ listCalls: async (l, o, f) => { seen.f = f; return { data: [call], hasMore: false, total: 1 }; } }));
  let r = await h.call("list_calls", { status: "completed", direction: "inbound", search: "+1310" });
  assert.deepEqual(seen.f, { status: "completed", direction: "inbound", search: "+1310" });
  assert.equal(r.structuredContent.scope, "account");
  assert.deepEqual(r.structuredContent.appliedFilters, { status: "completed", direction: "inbound", search: "+1310" });
  assert.match(r.content[0].text, /status=completed/);

  // Scoped to a number: dispatches to the number endpoint with pagination,
  // applies no filters.
  const numCalls = [];
  h = harness(makeStub({ listCallsForNumber: async (id, limit, offset) => { numCalls.push({ id, limit, offset }); return { data: [call], hasMore: false, total: 1 }; } }));
  r = await h.call("list_calls", { number_id: "num_1", limit: 5, offset: 10 });
  assert.deepEqual(numCalls, [{ id: "num_1", limit: 5, offset: 10 }]);
  assert.equal(r.structuredContent.scope, "number_id=num_1");
  assert.deepEqual(r.structuredContent.appliedFilters, {});

  // Scoped to an agent: dispatches to the agent endpoint with pagination.
  const agtCalls = [];
  h = harness(makeStub({ listAgentCalls: async (id, limit, offset) => { agtCalls.push({ id, limit, offset }); return { data: [call], hasMore: false, total: 1 }; } }));
  r = await h.call("list_calls", { agent_id: "agt_1", limit: 7, offset: 0 });
  assert.deepEqual(agtCalls, [{ id: "agt_1", limit: 7, offset: 0 }]);
  assert.equal(r.structuredContent.scope, "agent_id=agt_1");
  assert.deepEqual(r.structuredContent.appliedFilters, {});

  // Restore the filter-recording harness for the remaining rejection cases.
  h = harness(makeStub({ listCalls: async () => ({ data: [call], hasMore: false, total: 1 }) }));

  // number_id + a filter -> explicit error, not silent drop.
  r = await h.call("list_calls", { number_id: "num_1", status: "completed" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not supported when scoping by number_id/);

  // agent_id + a filter -> explicit error.
  r = await h.call("list_calls", { agent_id: "agt_1", direction: "inbound" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not supported when scoping by agent_id/);

  // Both IDs -> explicit error, no silent precedence.
  r = await h.call("list_calls", { agent_id: "agt_1", number_id: "num_1" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not both/);
});

test("call lifecycle serializes end to end: make_call then get_call (tasks#205)", async () => {
  // Distinct created vs fetched IDs, and capture the id get_call is actually
  // asked for, so the test proves the lifecycle is followed (not two unrelated
  // fixture calls).
  const madeId = "call_made_42";
  let fetchedId;
  const h = harness(makeStub({
    makeCall: async () => ({ id: madeId, fromNumber: "+1415", toNumber: "+1310", direction: "outbound", status: "ringing", startedAt: "t", retellCallId: null }),
    getCall: async (id) => { fetchedId = id; return { ...call, id }; },
  }));
  const made = await h.call("make_call", { agent_id: "agt_1", to_number: "+14155550123" });
  assert.equal(made.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.make_call.safeParse(made.structuredContent).success, "make_call structured content");
  assert.equal(made.structuredContent.id, madeId);
  const got = await h.call("get_call", { call_id: made.structuredContent.id });
  assert.equal(got.isError, undefined);
  assert.equal(fetchedId, madeId, "get_call must be asked for the id make_call returned");
  assert.equal(got.structuredContent.id, madeId);
  assert.ok(OUTPUT_SCHEMAS.get_call.safeParse(got.structuredContent).success, "get_call structured content");
});

test("mutation success is tracked separately from serialization (tasks#205)", async () => {
  // A mutation whose API call fails must be an isError result with NO structured
  // content — a serialization-valid empty object must never be mistaken for a
  // successful send.
  const h = harness(makeStub({ sendMessage: async () => { throw new ApiError(500, "POST", "/v1/messages", "boom"); } }));
  const r = await h.call("send_message", { agent_id: "agt_1", to_number: "+14155550123", body: "hi" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent, undefined, "failed mutation must not carry structuredContent");
  // The success path, by contrast, carries schema-valid structured content.
  const ok2 = await harness(makeStub()).call("send_message", { agent_id: "agt_1", to_number: "+14155550123", body: "hi" });
  assert.equal(ok2.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.send_message.safeParse(ok2.structuredContent).success);
});

test("end_call ends a call and tolerates an already-ended call (#204)", async () => {
  const calls = [];
  const h = harness(makeStub({ endCall: async (id) => { calls.push(id); return { id, status: "completed", endedAt: "t", success: true }; } }));
  const r = await h.call("end_call", { call_id: "call_1" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls, ["call_1"]);
  assert.match(r.content[0].text, /ended/);
  assert.ok(OUTPUT_SCHEMAS.end_call.safeParse(r.structuredContent).success);
  // Idempotent in behavior: a minimal/empty backend response still validates.
  const h2 = harness(makeStub({ endCall: async () => ({}) }));
  const r2 = await h2.call("end_call", { call_id: "call_1" });
  assert.equal(r2.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.end_call.safeParse(r2.structuredContent).success);
});

test("call tools forward recording/variables/model-tier/screening controls (#204)", async () => {
  for (const tool of ["make_call", "make_conversation_call"]) {
    let body;
    const stub = tool === "make_call"
      ? { makeCall: async (a, n, g, f, v, opts) => { body = opts; return { id: "call_1", fromNumber: "+1", toNumber: "+2", direction: "outbound", status: "ringing", startedAt: "t", retellCallId: null }; } }
      : { makeConversationCall: async (a, n, s, g, f, v, opts) => { body = opts; return call; } };
    const h = harness(makeStub(stub));
    const args = {
      agent_id: "agt_1", to_number: "+14155550123",
      disable_recording: true, variables: { customerName: "Sam" }, model_tier: "max",
      call_screening_identity: "Acme", call_screening_purpose: "reminder",
      ...(tool === "make_conversation_call" ? { topic: "x" } : {}),
    };
    const r = await h.call(tool, args);
    assert.equal(r.isError, undefined, `${tool} errored`);
    assert.equal(body.disableRecording, true, `${tool}: disableRecording`);
    assert.deepEqual(body.variables, { customerName: "Sam" }, `${tool}: variables`);
    assert.equal(body.modelTier, "max", `${tool}: modelTier`);
    assert.equal(body.callScreeningIdentity, "Acme", `${tool}: callScreeningIdentity`);
    assert.equal(body.callScreeningPurpose, "reminder", `${tool}: callScreeningPurpose`);
  }
});

test("call tools omit unset controls so backend defaults stand (#204)", async () => {
  let body = "unset";
  const h = harness(makeStub({ makeCall: async (a, n, g, f, v, opts) => { body = opts; return { id: "c", fromNumber: "+1", toNumber: "+2", direction: "outbound", status: "ringing", startedAt: "t", retellCallId: null }; } }));
  await h.call("make_call", { agent_id: "agt_1", to_number: "+14155550123" });
  // buildCallControls passes an object of all-undefined fields; applyCallControls
  // forwards none of them.
  for (const k of ["disableRecording", "variables", "modelTier", "callScreeningIdentity", "callScreeningPurpose"]) {
    assert.equal(body[k], undefined, `unset ${k} must not be forwarded`);
  }
});

test("send_message: new-group recipients, channel, and interactive rules (tasks#203)", async () => {
  // Capture what reaches the API.
  let body;
  const stub = { sendMessage: async (p) => { body = p; return { id: "m1", status: "sent", channel: p.channel ?? "imessage", from_number: "+1415", to_number: "+1310", media_urls: [], reply_to_message_id: null, reply_parent_unresolved: null }; } };

  // Existing group / single recipient via to_number still works.
  let h = harness(makeStub(stub));
  let r = await h.call("send_message", { agent_id: "agt_1", to_number: "+14155550123", body: "hi" });
  assert.equal(r.isError, undefined);
  assert.equal(body.toNumber, "+14155550123");

  // New group via recipients, including the manav case: 32 duplicates + 1 distinct
  // must be ACCEPTED here (the API dedupes); national/formatted numbers allowed.
  h = harness(makeStub(stub));
  const many = [...Array(32).fill("+14155550101"), "4155550102"];
  r = await h.call("send_message", { agent_id: "agt_1", recipients: many, body: "hey group" });
  assert.equal(r.isError, undefined, r.isError ? r.content[0].text : "");
  assert.deepEqual(body.recipients, many, "recipients forwarded unchanged for the API to normalize");

  // to_number + recipients together is rejected (exclusive destination).
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", to_number: "+1", recipients: ["+1", "+2"], body: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not both/);

  // recipients + channel=whatsapp is contradictory.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", recipients: ["+1", "+2"], channel: "whatsapp", body: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /whatsapp/i);

  // WhatsApp interactive requires channel=whatsapp.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", to_number: "+14155550123", body: "x", buttons: ["Yes", "No"] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /requires channel=whatsapp/);

  // Interactive shapes are mutually exclusive.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", to_number: "+14155550123", body: "x", channel: "whatsapp", buttons: ["a"], template: { name: "t" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only one of/);

  // A valid WhatsApp template send forwards channel + template.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", to_number: "+14155550123", body: "", channel: "whatsapp", template: { name: "welcome" } });
  assert.equal(r.isError, undefined, r.isError ? r.content[0].text : "");
  assert.equal(body.channel, "whatsapp");
  assert.deepEqual(body.template, { name: "welcome" });
  assert.ok(OUTPUT_SCHEMAS.send_message.safeParse(r.structuredContent).success);

  // Empty recipients value is rejected.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", recipients: ["+1", "  "], body: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /empty/);

  // A single-entry recipients list can't form a group.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", recipients: ["+14155550101"], body: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /at least 2/);

  // channel=whatsapp cannot target an iMessage group id.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", to_number: "grp_abc", channel: "whatsapp", body: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /group id/);

  // A blank to_number alongside recipients must not forward both destinations.
  h = harness(makeStub(stub));
  r = await h.call("send_message", { agent_id: "agt_1", to_number: "  ", recipients: ["+1", "+2"], body: "x" });
  assert.equal(r.isError, undefined, r.isError ? r.content[0].text : "");
  assert.equal(body.toNumber, undefined, "blank to_number must be dropped");
  assert.deepEqual(body.recipients, ["+1", "+2"]);
});

test("check_capabilities returns per-channel flags (tasks#203)", async () => {
  let asked;
  const h = harness(makeStub({ getContactCapabilities: async (n) => { asked = n; return { phoneNumber: n, capabilities: { imessage: true, sms: true, rcs: null }, checkedAt: "t" }; } }));
  const r = await h.call("check_capabilities", { phone_number: "+14155550123" });
  assert.equal(r.isError, undefined);
  assert.equal(asked, "+14155550123");
  assert.match(r.content[0].text, /iMessage: yes/);
  assert.match(r.content[0].text, /RCS: unknown/);
  assert.ok(OUTPUT_SCHEMAS.check_capabilities.safeParse(r.structuredContent).success);
  // Rejects a non-E.164 number before calling the API (and never calls it).
  let called = false;
  const h2 = harness(makeStub({ getContactCapabilities: async () => { called = true; return { phoneNumber: "x", capabilities: {}, checkedAt: "t" }; } }));
  const bad = await h2.call("check_capabilities", { phone_number: "4155550123" });
  assert.equal(bad.isError, true);
  assert.equal(called, false, "bad input must be rejected before any API call");
});

test("check_readiness reports ready and the documented blocker states (tasks#199)", async () => {
  const baseNum = { id: "num_1", phoneNumber: "+14155550123", country: "US", status: "active", type: "local", agentId: "agt_1", outboundSms: "enabled", inboundCallsEnabled: true, whatsappEnabled: true };
  const approved = { campaign_status: "approved", message: "ok", stage: null, issue: null, sub_account_id: null };

  // Ready state.
  let h = harness(makeStub({ getNumber: async () => baseNum, getRegisterStatus: async () => approved }));
  let r = await h.call("check_readiness", { number_id: "num_1" });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.ready, true);
  assert.equal(r.structuredContent.blockers.length, 0);
  assert.match(r.content[0].text, /READY/);
  assert.deepEqual(r.structuredContent.notChecked, ["creditBalance", "concurrency"]);
  assert.ok(OUTPUT_SCHEMAS.check_readiness.safeParse(r.structuredContent).success);

  // Unassigned -> blocker.
  h = harness(makeStub({ getNumber: async () => ({ ...baseNum, agentId: null }), getRegisterStatus: async () => approved }));
  r = await h.call("check_readiness", { number_id: "num_1" });
  assert.equal(r.structuredContent.ready, false);
  assert.match(r.content[0].text, /attach_number/);

  // Inactive -> blocker.
  h = harness(makeStub({ getNumber: async () => ({ ...baseNum, status: "pending" }), getRegisterStatus: async () => approved }));
  r = await h.call("check_readiness", { number_id: "num_1" });
  assert.equal(r.structuredContent.ready, false);
  assert.match(r.content[0].text, /not active/);

  // SMS registration_required -> blocker for sms.
  h = harness(makeStub({ getNumber: async () => ({ ...baseNum, outboundSms: "registration_required" }), getRegisterStatus: async () => approved }));
  r = await h.call("check_readiness", { number_id: "num_1", channel: "sms" });
  assert.equal(r.structuredContent.ready, false);
  assert.match(r.content[0].text, /10DLC/);

  // Channel mismatch: whatsapp not enabled -> blocker for whatsapp.
  h = harness(makeStub({ getNumber: async () => ({ ...baseNum, whatsappEnabled: false }), getRegisterStatus: async () => approved }));
  r = await h.call("check_readiness", { number_id: "num_1", channel: "whatsapp" });
  assert.equal(r.structuredContent.ready, false);
  assert.match(r.content[0].text, /WhatsApp is not enabled/);

  // Pending compliance -> warning (not a hard blocker), still ready if number ok.
  h = harness(makeStub({ getNumber: async () => baseNum, getRegisterStatus: async () => ({ campaign_status: "pending", message: "", stage: "vetting", issue: { message: "awaiting vetting" }, sub_account_id: null }) }));
  r = await h.call("check_readiness", { number_id: "num_1", channel: "sms" });
  assert.equal(r.structuredContent.ready, true);
  assert.ok(r.structuredContent.warnings.some((w) => /A2P/.test(w)));

  // Best-effort: register-status failure degrades to a warning, not an error.
  h = harness(makeStub({ getNumber: async () => baseNum, getRegisterStatus: async () => { throw new ApiError(500, "GET", "/v1/register/status", "boom"); } }));
  r = await h.call("check_readiness", { number_id: "num_1" });
  assert.equal(r.isError, undefined);
  assert.ok(r.structuredContent.warnings.some((w) => /unverified/.test(w)));

  // Missing number surfaces as an error.
  h = harness(makeStub({ getNumber: async () => { throw new ApiError(404, "GET", "/v1/numbers/x", "not found"); } }));
  r = await h.call("check_readiness", { number_id: "x" });
  assert.equal(r.isError, true);

  // Recipient check: an unreachable recipient produces a warning.
  h = harness(makeStub({
    getNumber: async () => baseNum, getRegisterStatus: async () => approved,
    getContactCapabilities: async () => ({ phoneNumber: "+14155550199", capabilities: { imessage: false, sms: false, rcs: false }, checkedAt: "t" }),
  }));
  r = await h.call("check_readiness", { number_id: "num_1", channel: "sms", to_number: "+14155550199" });
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.recipient.phoneNumber, "+14155550199");
  assert.ok(r.structuredContent.warnings.some((w) => /not appear reachable/.test(w)));

  // Recipient lookup failure degrades to a warning, not an error.
  let capCalled = false;
  h = harness(makeStub({
    getNumber: async () => baseNum, getRegisterStatus: async () => approved,
    getContactCapabilities: async () => { capCalled = true; throw new ApiError(500, "GET", "/v1/contacts/capabilities", "boom"); },
  }));
  r = await h.call("check_readiness", { number_id: "num_1", channel: "sms", to_number: "+14155550199" });
  assert.equal(r.isError, undefined);
  assert.equal(capCalled, true);
  assert.ok(r.structuredContent.warnings.some((w) => /Could not check reachability/.test(w)));

  // Non-messaging channel (voice) does NOT call the messaging-capabilities endpoint.
  capCalled = false;
  h = harness(makeStub({
    getNumber: async () => baseNum, getRegisterStatus: async () => approved,
    getContactCapabilities: async () => { capCalled = true; return { phoneNumber: "x", capabilities: {}, checkedAt: "t" }; },
  }));
  r = await h.call("check_readiness", { number_id: "num_1", channel: "voice", to_number: "+14155550199" });
  assert.equal(r.isError, undefined, "voice readiness should still succeed");
  assert.equal(typeof r.structuredContent.ready, "boolean");
  assert.equal(capCalled, false, "voice readiness must not query messaging capabilities");

  // A general (no channel) check does NOT hard-block on SMS registration.
  h = harness(makeStub({ getNumber: async () => ({ ...baseNum, outboundSms: "registration_required" }), getRegisterStatus: async () => approved }));
  r = await h.call("check_readiness", { number_id: "num_1" });
  assert.equal(r.structuredContent.ready, true, "general check must not hard-block on SMS 10DLC");
  assert.ok(r.structuredContent.warnings.some((w) => /10DLC/.test(w)));
});

test("registered tools and OUTPUT_SCHEMAS are the same set (no drift)", () => {
  const registered = new Set(harness(makeStub()).names());
  assert.equal(registered.size, 32);
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

test("make_conversation_call returns immediately without any wait inputs (#192)", async () => {
  const h = harness(makeStub());
  // The schema must not advertise the removed wait/max_wait_seconds options.
  const schema = h.schema("make_conversation_call");
  assert.ok(!("wait" in schema), "wait input must be removed");
  assert.ok(!("max_wait_seconds" in schema), "max_wait_seconds input must be removed");
  // Normal call returns the initiated state immediately, pointing at get_call.
  const r = await h.call("make_conversation_call", { agent_id: "a", to_number: "+14155550123", topic: "x" });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /initiated/);
  assert.match(r.content[0].text, /get_call/);
  assert.doesNotMatch(r.content[0].text, /in progress|wait elapsed/);
  assert.ok(OUTPUT_SCHEMAS.make_conversation_call.safeParse(r.structuredContent).success);
});

test("get_call takes only call_id, with no wait/timeout, and never long-polls (#192)", async () => {
  const schema = harness(makeStub()).schema("get_call");
  assert.deepEqual(Object.keys(schema).sort(), ["call_id"]);
  let argCount = -1;
  const h = harness(makeStub({ getCall: async (...args) => { argCount = args.length; return { ...call, id: args[0] }; } }));
  const r = await h.call("get_call", { call_id: "call_1" });
  assert.equal(r.isError, undefined);
  assert.equal(argCount, 1, "get_call must be called with only the id (no wait/timeout opts)");
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

test("list_voices tolerates null gender/accent and renders readable text (#190)", async () => {
  const sparse = { voice_id: "v2", voice_name: "Nova", provider: "p", gender: null, accent: null, preview_audio_url: null };
  const h = harness(makeStub({ listVoices: async () => ({ data: [voice, sparse] }) }));
  const r = await h.call("list_voices", {});
  assert.equal(r.isError, undefined, "list_voices should not error on null provider metadata");
  assert.ok(OUTPUT_SCHEMAS.list_voices.safeParse(r.structuredContent).success, "schema accepts null gender/accent");
  assert.doesNotMatch(r.content[0].text, /\bnull\b/, "no literal 'null' in display text");
  assert.match(r.content[0].text, /Nova/);
});

test("account_overview errors when every section fails (#190)", async () => {
  const boom = async () => { throw new Error("backend down"); };
  const h = harness(makeStub({ listAgents: boom, listNumbers: boom, getWebhook: boom, getUsage: boom }));
  const r = await h.call("account_overview", {});
  assert.equal(r.isError, true, "all-failed overview must be an error, not an empty account");
  assert.match(r.content[0].text, /every lookup errored/);
});

test("account_overview reports section status on partial failure (#190)", async () => {
  const h = harness(makeStub({ getWebhook: async () => { throw new Error("denied"); } }));
  const r = await h.call("account_overview", {});
  assert.equal(r.isError, undefined);
  assert.equal(r.structuredContent.sectionStatus.webhook, "failed");
  assert.equal(r.structuredContent.sectionStatus.agents, "ok");
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

  // make_conversation_call returns the initiated call immediately
  h = harness(makeStub());
  r = await h.call("make_conversation_call", { agent_id: "agt_1", to_number: "+14155550123", topic: "x" });
  assert.equal(r.isError, undefined);
  assert.ok(OUTPUT_SCHEMAS.make_conversation_call.safeParse(r.structuredContent).success, "mcc/initiated");

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
  list_calls: ["data", "scope", "appliedFilters"],
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
  get_conversation_messages: ["data"],
  update_conversation: ["id"],
  delete_agent: ["success", "id", "name"],
  attach_number: ["agentId", "number"],
  detach_number: ["success"],
  delete_webhook: ["success"],
  test_webhook: ["success", "httpStatus", "errorMessage"],
  check_capabilities: ["phoneNumber", "capabilities", "checkedAt"],
  check_readiness: ["numberId", "ready", "channels", "compliance", "blockers", "warnings", "nextSteps", "notChecked"],
};
const VAL = { id: "x", name: "x", agentId: "x", data: [], success: true, number: {}, httpStatus: null, errorMessage: null, statusCode: null, responseMs: null, error: null, scope: "account", appliedFilters: {}, phoneNumber: "+1", capabilities: {}, checkedAt: "t", numberId: "num_1", ready: true, blockers: [], warnings: [], nextSteps: [], channels: {}, compliance: null, notChecked: [] };

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

test("update_agent accepts documented numbers: null", async () => {
  const r = await callAndValidate("update_agent", { agent_id: "agt_1" }, { updateAgent: async () => AGENT_WITHOUT_NUMBERS });
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
