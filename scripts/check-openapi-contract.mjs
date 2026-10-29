#!/usr/bin/env node
/**
 * Compare the API surface this MCP server depends on against the live OpenAPI
 * (tasks#205). The unit suite drives handlers against stubs shaped like the API;
 * this closes the loop by asserting the real contract still matches — endpoints,
 * request fields and response fields the client reads — so a backend change that
 * breaks a tool is caught before release instead of in production.
 *
 * Network-dependent by design, so it is NOT part of `npm test`. Run it before a
 * release (`npm run check:contract`) or as a non-blocking CI job. Override the
 * spec URL with OPENAPI_URL.
 */
const OPENAPI_URL = process.env.OPENAPI_URL || "https://api.agentphone.ai/openapi.json";

const problems = [];
const require$ = (cond, msg) => { if (!cond) problems.push(msg); };

function paramNames(op) {
  // Only query parameters — a same-named path/header parameter must not satisfy a
  // query contract.
  return new Set((op?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name));
}
function props(spec, schemaName) {
  return spec.components?.schemas?.[schemaName]?.properties ?? {};
}
function requestSchemaName(op) {
  const ref = op?.requestBody?.content?.["application/json"]?.schema?.$ref ?? "";
  return ref.split("/").pop() || null;
}
function responseSchemaName(op, code = "200") {
  const ref = op?.responses?.[code]?.content?.["application/json"]?.schema?.$ref ?? "";
  return ref.split("/").pop() || null;
}

const res = await fetch(OPENAPI_URL, { headers: { Accept: "application/json" } });
if (!res.ok) {
  console.error(`Could not fetch OpenAPI from ${OPENAPI_URL}: HTTP ${res.status}`);
  process.exit(2);
}
const spec = await res.json();
const paths = spec.paths ?? {};

// Resolve a response schema's properties, following one array item $ref so we can
// assert on the element fields the client reads.
function itemProps(spec, schemaName, arrayField = "data") {
  const field = props(spec, schemaName)[arrayField];
  const ref = field?.items?.$ref ?? "";
  const itemName = ref.split("/").pop();
  return itemName ? props(spec, itemName) : {};
}

// --- Cursor-paged number messages (get_messages) ---
{
  const p = "/v1/numbers/{number_id}/messages";
  const op = paths[p]?.get;
  require$(op, `missing GET ${p}`);
  if (op) {
    const names = paramNames(op);
    for (const q of ["limit", "cursor", "before", "after"]) require$(names.has(q), `GET ${p} no longer accepts query '${q}'`);
    const rs = responseSchemaName(op);
    const rp = rs ? props(spec, rs) : {};
    require$("data" in rp, `${p} response (${rs}) missing data`);
    require$("hasMore" in rp, `${p} response (${rs}) missing hasMore`);
    require$("nextCursor" in rp, `${p} response (${rs}) missing nextCursor`);
    // The message item fields get_messages renders / normalizes.
    const item = rs ? itemProps(spec, rs) : {};
    for (const f of ["id", "from_", "to", "body", "receivedAt"]) require$(f in item, `${p} message item missing ${f}`);
  }
}

// --- Cursor-paged conversation messages (get_conversation_messages) ---
{
  const p = "/v1/conversations/{conversation_id}/messages";
  const op = paths[p]?.get;
  require$(op, `missing GET ${p}`);
  if (op) {
    const names = paramNames(op);
    for (const q of ["limit", "cursor", "before", "after"]) require$(names.has(q), `GET ${p} no longer accepts query '${q}'`);
    const rs = responseSchemaName(op);
    const rp = rs ? props(spec, rs) : {};
    require$("data" in rp && "hasMore" in rp && "nextCursor" in rp, `${p} response (${rs}) missing data/hasMore/nextCursor`);
    const item = rs ? itemProps(spec, rs) : {};
    for (const f of ["id", "body", "fromNumber", "toNumber", "direction", "receivedAt"]) require$(f in item, `${p} message item missing ${f}`);
  }
}

// --- Outbound call create: the request fields the client SENDS and response
//     fields it READS (end_call / recording controls live with tasks#204). ---
{
  const createCall = paths["/v1/calls"]?.post;
  require$(createCall, "missing POST /v1/calls");
  if (createCall) {
    const reqName = requestSchemaName(createCall);
    const cp = reqName ? props(spec, reqName) : {};
    // Request fields the client sends (makeCall and/or makeConversationCall).
    for (const f of ["agentId", "toNumber", "initialGreeting", "fromNumberId", "voice", "systemPrompt"]) {
      require$(f in cp, `CreateOutboundCallRequest (${reqName}) missing ${f} (sent by the client)`);
    }
    // NOTE: the spec does not document the POST /v1/calls success response shape
    // (empty schema), so the call-create response fields can't be asserted here.
    // The message endpoints below DO document their responses, which is where the
    // client's most fragile serialization lives.
  }
}

// --- Account-wide call filters (list_calls) ---
{
  const op = paths["/v1/calls"]?.get;
  require$(op, "missing GET /v1/calls");
  if (op) {
    const names = paramNames(op);
    for (const q of ["status", "direction", "search", "limit", "offset"]) {
      require$(names.has(q), `GET /v1/calls no longer accepts '${q}'`);
    }
  }
}

// --- Detach endpoint exists (detach_number tolerates an empty 200/204 body) ---
{
  const del = paths["/v1/agents/{agent_id}/numbers/{number_id}"]?.delete;
  require$(del, "missing DELETE /v1/agents/{agent_id}/numbers/{number_id} (detach_number)");
  // The handler tolerates both a 204 and an empty 200, so we don't pin the exact
  // code — only that the delete endpoint still exists.
}

if (problems.length) {
  console.error(`OpenAPI contract check FAILED against ${OPENAPI_URL}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`OpenAPI contract OK: ${OPENAPI_URL} still matches the surface the MCP depends on.`);
