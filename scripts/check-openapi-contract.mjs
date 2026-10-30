#!/usr/bin/env node
/**
 * Compare the API surface this MCP server depends on against the live OpenAPI
 * (tasks#205): endpoints, request fields, and consumed response fields/types.
 *
 * The CLI fetch is network-dependent: run `npm run check:contract` before a
 * release or as a non-blocking CI job. Override the URL with OPENAPI_URL.
 * The exported checker is pure; its fixture tests run offline in `npm test`.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function paramNames(op) {
  // A same-named path/header parameter must not satisfy a query contract.
  return new Set((op?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name));
}

function responseSchema(op) {
  return op?.responses?.["200"]?.content?.["application/json"]?.schema;
}

// Only the schema forms used by the consumed responses are needed here: local
// refs, anyOf (including null), and explicit types. This is not a full OpenAPI
// validator. Unknown/unresolved shapes must fail instead of silently passing.
function variants(spec, schema, seen = new Set()) {
  if (!schema || typeof schema !== "object") return [{}];
  let result;
  if (schema.$ref) {
    if (!schema.$ref.startsWith("#/") || seen.has(schema.$ref)) {
      return [{ error: `unresolvable schema reference ${schema.$ref}` }];
    }
    const target = schema.$ref.slice(2).split("/").reduce(
      (value, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec,
    );
    if (!target) return [{ error: `missing schema reference ${schema.$ref}` }];
    result = variants(spec, target, new Set([...seen, schema.$ref]));
  } else if (Array.isArray(schema.anyOf)) {
    result = schema.anyOf.flatMap((branch) => variants(spec, branch, seen));
    if (!result.length) result = [{}];
  } else {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    result = types.map((type) => ({ ...schema, type }));
  }
  // Also accept OpenAPI 3.0's spelling of a nullable type.
  return schema.nullable === true ? [...result, { type: "null" }] : result;
}

function checkSchema(spec, schema, expected, path, problems) {
  const types = Array.isArray(expected.type) ? expected.type : [expected.type];
  for (const branch of variants(spec, schema)) {
    if (branch.error) {
      problems.push(`${path}: ${branch.error}`);
    } else if (!types.includes(branch.type)) {
      problems.push(`${path}: expected ${types.join(" | ")}, got ${branch.type ?? "an unspecified type"}`);
    } else if (branch.type === "object") {
      for (const [field, contract] of Object.entries(expected.properties ?? {})) {
        if (!Object.hasOwn(branch.properties ?? {}, field)) {
          problems.push(`${path} missing ${field}`);
        } else {
          checkSchema(spec, branch.properties[field], contract, `${path}.${field}`, problems);
        }
      }
    } else if (branch.type === "array") {
      checkSchema(spec, branch.items, expected.items, `${path}[]`, problems);
    }
  }
}

const string = { type: "string" };
const boolean = { type: "boolean" };
const nullableString = { type: ["string", "null"] };
const nullableBoolean = { type: ["boolean", "null"] };
const object = (properties) => ({ type: "object", properties });
const messagePage = (properties) => object({
  data: { type: "array", items: object(properties) },
  hasMore: boolean,
  nextCursor: nullableString,
});

/** Return incompatibilities without fetching, logging, or changing the spec. */
export function checkOpenApiContract(spec) {
  const problems = [];
  const require$ = (cond, msg) => { if (!cond) problems.push(msg); };
  const paths = spec.paths ?? {};
  const checkResponse = (op, path, contract) => {
    if (op) checkSchema(spec, responseSchema(op), contract, `${path} response`, problems);
  };

  // These types mirror output-schemas.ts and api.ts's response normalization.
  // Only consumed fields are pinned; additional fields/enums are harmless.
  for (const [path, fields] of [
    ["/v1/numbers/{number_id}/messages", {
      id: string,
      // api.getMessages maps from_ to the nullable `from` output field.
      from_: nullableString,
      to: nullableString,
      body: string,
      receivedAt: string,
    }],
    ["/v1/conversations/{conversation_id}/messages", {
      id: string, body: string, fromNumber: string, toNumber: string,
      direction: string, receivedAt: string,
    }],
  ]) {
    const op = paths[path]?.get;
    require$(op, `missing GET ${path}`);
    if (op) {
      const names = paramNames(op);
      for (const q of ["limit", "cursor", "before", "after"]) {
        require$(names.has(q), `GET ${path} no longer accepts query '${q}'`);
      }
      checkResponse(op, path, messagePage(fields));
    }
  }

  // Outbound call request fields sent by makeCall/makeConversationCall.
  const createCall = paths["/v1/calls"]?.post;
  require$(createCall, "missing POST /v1/calls");
  if (createCall) {
    const reqRef = createCall.requestBody?.content?.["application/json"]?.schema?.$ref ?? "";
    const reqName = reqRef.split("/").pop();
    const cp = spec.components?.schemas?.[reqName]?.properties ?? {};
    for (const f of [
      "agentId", "toNumber", "initialGreeting", "fromNumberId", "voice", "systemPrompt",
      "disableRecording", "variables", "modelTier", "callScreeningIdentity", "callScreeningPurpose",
    ]) {
      require$(f in cp, `CreateOutboundCallRequest (${reqName}) missing ${f} (sent by the client)`);
    }
    // The spec leaves the POST /v1/calls success schema empty. Do not infer or
    // assert response fields that the API does not document.
  }

  require$(paths["/v1/calls/{call_id}/end"]?.post, "missing POST /v1/calls/{call_id}/end (end_call)");

  const listCalls = paths["/v1/calls"]?.get;
  require$(listCalls, "missing GET /v1/calls");
  if (listCalls) {
    const names = paramNames(listCalls);
    for (const q of ["status", "direction", "search", "limit", "offset"]) {
      require$(names.has(q), `GET /v1/calls no longer accepts '${q}'`);
    }
  }

  // Readiness responses: agentId may be null before assignment; flags and
  // status strings are forwarded to non-nullable MCP output fields.
  const numberPath = "/v1/numbers/{number_id}";
  const number = paths[numberPath]?.get;
  require$(number, `missing GET ${numberPath} (check_readiness)`);
  checkResponse(number, numberPath, object({
    id: string, phoneNumber: string, status: string, agentId: nullableString,
    outboundSms: string, whatsappEnabled: boolean, inboundCallsEnabled: boolean,
  }));

  const registerPath = "/v1/register/status";
  const register = paths[registerPath]?.get;
  require$(register, `missing GET ${registerPath} (check_readiness)`);
  checkResponse(register, registerPath, object({
    campaign_status: string, stage: nullableString, issue: { type: ["object", "null"] },
  }));

  const capabilitiesPath = "/v1/contacts/capabilities";
  const capabilities = paths[capabilitiesPath]?.get;
  require$(capabilities, `missing GET ${capabilitiesPath} (check_capabilities)`);
  if (capabilities) {
    require$(paramNames(capabilities).has("phone_number"), `GET ${capabilitiesPath} no longer accepts query 'phone_number'`);
    checkResponse(capabilities, capabilitiesPath, object({
      phoneNumber: string,
      capabilities: object({ imessage: nullableBoolean, sms: nullableBoolean, rcs: nullableBoolean }),
      checkedAt: string,
    }));
  }

  // detach_number tolerates both an empty 200 and a 204 response.
  require$(paths["/v1/agents/{agent_id}/numbers/{number_id}"]?.delete,
    "missing DELETE /v1/agents/{agent_id}/numbers/{number_id} (detach_number)");

  return problems;
}

// Importing this module for offline tests must never fetch the live API.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const url = process.env.OPENAPI_URL || "https://api.agentphone.ai/openapi.json";
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    console.error(`Could not fetch OpenAPI from ${url}: HTTP ${res.status}`);
    process.exit(2);
  }
  const problems = checkOpenApiContract(await res.json());
  if (problems.length) {
    console.error(`OpenAPI contract check FAILED against ${url}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`OpenAPI contract OK: ${url} still matches the surface the MCP depends on.`);
}
