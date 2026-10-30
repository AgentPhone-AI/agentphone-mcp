import test from "node:test";
import assert from "node:assert/strict";
import { checkOpenApiContract } from "../scripts/check-openapi-contract.mjs";

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const strings = (...names) => Object.fromEntries(names.map((name) => [name, { type: "string" }]));
const object = (properties) => ({ type: "object", properties });
const query = (...names) => names.map((name) => ({ in: "query", name }));
const response = (name, parameters = []) => ({
  parameters,
  responses: { "200": { content: { "application/json": { schema: ref(name) } } } },
});
const numberMessages = "/v1/numbers/{number_id}/messages";
const conversationMessages = "/v1/conversations/{conversation_id}/messages";

test("importing the checker never fetches the live API", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("unexpected network request during import"); };
  try {
    await import("../scripts/check-openapi-contract.mjs?offline-import-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Small, offline representation of the documented surface. Unconsumed fields
// and metadata are deliberately omitted; this is not a snapshot of the API.
function fixture() {
  const page = (item) => object({
    data: { type: "array", items: ref(item) },
    hasMore: { type: "boolean" },
    nextCursor: nullable({ type: "string" }),
  });
  return {
    openapi: "3.1.0",
    paths: {
      [numberMessages]: { get: response("MessageListResponse", query("limit", "cursor", "before", "after")) },
      [conversationMessages]: { get: response("MessagesListResponse", query("limit", "cursor", "before", "after")) },
      "/v1/calls": {
        get: { parameters: query("status", "direction", "search", "limit", "offset") },
        post: { requestBody: { content: { "application/json": { schema: ref("CreateOutboundCallRequest") } } } },
      },
      "/v1/calls/{call_id}/end": { post: {} },
      "/v1/numbers/{number_id}": { get: response("PhoneNumberResponse") },
      "/v1/register/status": { get: response("CampaignStatusResponse") },
      "/v1/contacts/capabilities": { get: response("ContactCapabilitiesResponse", query("phone_number")) },
      "/v1/agents/{agent_id}/numbers/{number_id}": { delete: {} },
    },
    components: { schemas: {
      MessageListResponse: page("MessageResponse"),
      MessagesListResponse: page("MessageInConversation"),
      MessageResponse: object(strings("id", "from_", "to", "body", "receivedAt")),
      MessageInConversation: object(strings("id", "body", "fromNumber", "toNumber", "direction", "receivedAt")),
      CreateOutboundCallRequest: object(Object.fromEntries([
        "agentId", "toNumber", "initialGreeting", "fromNumberId", "voice", "systemPrompt",
        "disableRecording", "variables", "modelTier", "callScreeningIdentity", "callScreeningPurpose",
      ].map((field) => [field, {}]))),
      PhoneNumberResponse: object({
        ...strings("id", "phoneNumber", "status", "outboundSms"),
        agentId: nullable({ type: "string" }),
        whatsappEnabled: { type: "boolean" },
        inboundCallsEnabled: { type: "boolean" },
      }),
      CampaignStatusResponse: object({
        campaign_status: { type: "string" },
        stage: nullable({ type: "string" }),
        issue: nullable(ref("RegistrationIssue")),
      }),
      RegistrationIssue: object(strings("code", "message")),
      ContactCapabilitiesResponse: object({
        ...strings("phoneNumber", "checkedAt"),
        capabilities: ref("ContactCapabilityFlags"),
      }),
      ContactCapabilityFlags: object(Object.fromEntries(
        ["imessage", "sms", "rcs"].map((name) => [name, nullable({ type: "boolean" })]),
      )),
    } },
  };
}

test("documented response shapes pass without mutating the spec", () => {
  const spec = fixture();
  const before = structuredClone(spec);
  assert.deepEqual(checkOpenApiContract(spec), []);
  assert.deepEqual(spec, before);
});

for (const [schemaName, path] of [
  ["MessageListResponse", numberMessages],
  ["MessagesListResponse", conversationMessages],
]) {
  test(`${schemaName}: a string hasMore is incompatible`, () => {
    const spec = fixture();
    spec.components.schemas[schemaName].properties.hasMore = { type: "string" };
    assert.deepEqual(checkOpenApiContract(spec), [`${path} response.hasMore: expected boolean, got string`]);
    // A previous failure must not leak into the next invocation.
    assert.deepEqual(checkOpenApiContract(fixture()), []);
  });
}

for (const [description, mutate, expected] of [
  ["data must remain an array", (s) => { s.MessageListResponse.properties.data.type = "object"; }, /response\.data: expected array, got object/],
  ["array items must remain objects", (s) => { s.MessageListResponse.properties.data.items = { type: "string" }; }, /response\.data\[\]: expected object, got string/],
  ["array items need a documented type", (s) => { delete s.MessageListResponse.properties.data.items; }, /response\.data\[\]: expected object, got an unspecified type/],
  ["message text must remain a string", (s) => { s.MessageInConversation.properties.body = { type: "integer" }; }, /response\.data\[\]\.body: expected string, got integer/],
  ["sender normalization does not coerce numbers", (s) => { s.MessageResponse.properties.from_ = { type: "number" }; }, /response\.data\[\]\.from_: expected string \| null, got number/],
  ["every union branch must be compatible", (s) => { s.MessageResponse.properties.body = { anyOf: [{ type: "string" }, { type: "boolean" }] }; }, /response\.data\[\]\.body: expected string, got boolean/],
  ["readiness flags must remain booleans", (s) => { s.PhoneNumberResponse.properties.whatsappEnabled = { type: "string" }; }, /response\.whatsappEnabled: expected boolean, got string/],
  ["registration status must remain a string", (s) => { s.CampaignStatusResponse.properties.campaign_status = { type: "boolean" }; }, /response\.campaign_status: expected string, got boolean/],
  ["registration issues must remain objects or null", (s) => { s.RegistrationIssue.type = "array"; }, /response\.issue: expected object \| null, got array/],
  ["nested capabilities must remain booleans or null", (s) => { s.ContactCapabilityFlags.properties.sms = nullable({ type: "string" }); }, /response\.capabilities\.sms: expected boolean \| null, got string/],
]) {
  test(description, () => {
    const spec = fixture();
    mutate(spec.components.schemas);
    const problems = checkOpenApiContract(spec);
    assert.equal(problems.length, 1);
    assert.match(problems[0], expected);
  });
}

test("null is accepted for normalized senders, recipients, cursors, assignment, and compliance", () => {
  const spec = fixture();
  const s = spec.components.schemas;
  s.MessageResponse.properties.from_ = nullable({ type: "string" });
  s.MessageResponse.properties.to = { type: "string", nullable: true };
  s.MessageListResponse.properties.nextCursor = { type: ["string", "null"] };
  assert.deepEqual(checkOpenApiContract(spec), []);
  // Removing nullable alternatives is also compatible with the consumer.
  s.MessageListResponse.properties.nextCursor = { type: "string" };
  s.PhoneNumberResponse.properties.agentId = { type: "string" };
  assert.deepEqual(checkOpenApiContract(spec), []);
});

for (const [schemaName, field] of [
  ["MessageListResponse", "data"], ["MessageListResponse", "hasMore"],
  ["MessageResponse", "body"], ["MessageInConversation", "fromNumber"],
  ["PhoneNumberResponse", "inboundCallsEnabled"], ["ContactCapabilitiesResponse", "capabilities"],
  ["ContactCapabilitiesResponse", "checkedAt"],
]) {
  test(`${schemaName}.${field} cannot become nullable`, () => {
    for (const wrap of [nullable, (schema) => ({ ...schema, nullable: true })]) {
      const spec = fixture();
      const props = spec.components.schemas[schemaName].properties;
      props[field] = wrap(props[field]);
      const problems = checkOpenApiContract(spec);
      assert.equal(problems.length, 1);
      assert.match(problems[0], new RegExp(`\\.${field}: expected .* got null`));
    }
  });
}

test("response roots and message items cannot become nullable", () => {
  const spec = fixture();
  const op = spec.paths[numberMessages].get;
  op.responses["200"].content["application/json"].schema = nullable(ref("MessageListResponse"));
  spec.components.schemas.MessagesListResponse.properties.data.items = nullable(ref("MessageInConversation"));
  assert.deepEqual(checkOpenApiContract(spec), [
    `${numberMessages} response: expected object, got null`,
    `${conversationMessages} response.data[]: expected object, got null`,
  ]);
});

test("local refs resolve through response, array-item, and field aliases", () => {
  const spec = fixture();
  const s = spec.components.schemas;
  s.PageAlias = ref("MessageListResponse");
  spec.paths[numberMessages].get.responses["200"].content["application/json"].schema = ref("PageAlias");
  s.ItemAlias = ref("MessageResponse");
  s.MessageListResponse.properties.data.items = ref("ItemAlias");
  s.MessageResponse.properties.from_ = nullable(ref("StringAlias"));
  s.StringAlias = ref("Text");
  s.Text = { type: "string" };
  assert.deepEqual(checkOpenApiContract(spec), []);
  s.Text.type = "integer";
  assert.deepEqual(checkOpenApiContract(spec), [
    `${numberMessages} response.data[].from_: expected string | null, got integer`,
  ]);
});

test("missing or cyclic refs report the affected field without crashing", () => {
  const spec = fixture();
  const s = spec.components.schemas;
  s.MessageResponse.properties.body = ref("Missing");
  assert.match(checkOpenApiContract(spec)[0], /response\.data\[\]\.body: missing schema reference/);
  s.Missing = ref("Missing");
  assert.match(checkOpenApiContract(spec)[0], /response\.data\[\]\.body: unresolvable schema reference/);
});

test("additional fields, enum values, and undocumented call responses remain unrestricted", () => {
  const spec = fixture();
  const s = spec.components.schemas;
  s.MessageResponse.properties.newField = { anyOf: [{ type: "object" }, { type: "array" }] };
  s.MessageListResponse.properties.total = { type: "integer" };
  s.PhoneNumberResponse.properties.status.enum = ["active", "new-status"];
  spec.paths["/v1/calls"].post.responses = { "200": { content: { "application/json": { schema: {} } } } };
  assert.deepEqual(checkOpenApiContract(spec), []);
});

test("existing endpoint, query, request-field, and response-field guards still run", () => {
  const spec = fixture();
  delete spec.paths["/v1/calls/{call_id}/end"].post;
  spec.paths[numberMessages].get.parameters.find((p) => p.name === "cursor").in = "header";
  delete spec.components.schemas.CreateOutboundCallRequest.properties.voice;
  delete spec.components.schemas.MessageResponse.properties.receivedAt;
  const problems = checkOpenApiContract(spec);
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.includes("missing POST /v1/calls/{call_id}/end")));
  assert.ok(problems.some((p) => p.includes("no longer accepts query 'cursor'")));
  assert.ok(problems.some((p) => p.includes("missing voice (sent by the client)")));
  assert.ok(problems.some((p) => p.includes("response.data[] missing receivedAt")));
});
