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
  return new Set((op?.parameters ?? []).map((p) => p.name));
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

// --- Cursor-paged message history (get_messages, get_conversation_messages) ---
for (const p of ["/v1/numbers/{number_id}/messages", "/v1/conversations/{conversation_id}/messages"]) {
  const op = paths[p]?.get;
  require$(op, `missing GET ${p}`);
  if (op) {
    const names = paramNames(op);
    for (const q of ["limit", "cursor", "before", "after"]) {
      require$(names.has(q), `GET ${p} no longer accepts '${q}'`);
    }
    const rs = responseSchemaName(op);
    const rp = rs ? props(spec, rs) : {};
    require$("hasMore" in rp, `${p} response (${rs}) missing hasMore`);
    require$("nextCursor" in rp, `${p} response (${rs}) missing nextCursor`);
  }
}

// --- Sender field: MessageResponse exposes from_ (we normalize to `from`) ---
require$("from_" in props(spec, "MessageResponse"), "MessageResponse no longer exposes from_ (sender normalization would break)");

// --- Call lifecycle: end endpoint + outbound controls ---
require$(paths["/v1/calls/{call_id}/end"]?.post, "missing POST /v1/calls/{call_id}/end (end_call)");
const createCall = paths["/v1/calls"]?.post;
require$(createCall, "missing POST /v1/calls");
if (createCall) {
  const reqName = requestSchemaName(createCall);
  const cp = reqName ? props(spec, reqName) : {};
  for (const f of ["disableRecording", "variables", "modelTier", "callScreeningIdentity", "callScreeningPurpose"]) {
    require$(f in cp, `CreateOutboundCallRequest (${reqName}) missing ${f}`);
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
