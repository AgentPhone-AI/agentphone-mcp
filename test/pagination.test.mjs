import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const messages = [
  { id: "m3", from: "sender", to: "agent", body: "Newest", receivedAt: "2026-10-13T12:00:00.123456Z" },
  { id: "m2", from: "sender", to: "agent", body: "Middle", receivedAt: "2026-10-13T11:00:00+01:00" },
  { id: "m1", from: "sender", to: "agent", body: "Oldest", receivedAt: "2026-10-13T09:00:00Z" },
];
const agents = [{ id: "a1" }, { id: "a2" }, { id: "a3" }];
const ties = Array.from({ length: 205 }, (_, index) => ({
  id: `t${index}`, from: "sender", to: "agent", body: `Message ${index}`, receivedAt: "2026-10-13T12:00:00Z",
}));
const cursorFor = (offset) => `opaque/+ =${offset}`;

async function connect(t, respond) {
  const requests = [];
  const cursors = new Map();
  const backend = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (respond) {
      const { status = 200, body } = respond(url);
      res.statusCode = status;
      res.end(JSON.stringify(body));
      return;
    }
    const limit = Number(url.searchParams.get("limit"));
    if (url.pathname === "/v1/agents") {
      const offset = Number(url.searchParams.get("offset"));
      res.end(JSON.stringify({ data: agents.slice(offset, offset + limit), total: agents.length }));
      return;
    }
    const before = url.searchParams.get("before");
    const after = url.searchParams.get("after");
    const source = url.pathname.includes("ties") ? ties : messages;
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !cursors.has(cursor)) {
      res.statusCode = 422;
      res.end(JSON.stringify({ detail: "Invalid cursor" }));
      return;
    }
    const filtered = cursor !== null ? cursors.get(cursor).data : source.filter((message) =>
      (!before || Date.parse(message.receivedAt) < Date.parse(before)) &&
      (!after || Date.parse(message.receivedAt) > Date.parse(after))
    );
    const offset = cursor === null ? 0 : cursors.get(cursor).offset;
    const data = filtered.slice(offset, offset + limit);
    const hasMore = filtered.length > offset + data.length;
    const nextCursor = hasMore ? cursorFor(offset + data.length) : null;
    if (nextCursor !== null) cursors.set(nextCursor, { data: filtered, offset: offset + data.length });
    res.end(JSON.stringify({ data, hasMore, nextCursor }));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(() => new Promise((resolve) => backend.close(resolve)));

  const client = new Client({ name: "pagination-test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "--stdio"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      AGENTPHONE_BASE_URL: `http://127.0.0.1:${backend.address().port}`,
      AGENTPHONE_API_KEY: "test-key",
      MCP_USE_ANONYMIZED_TELEMETRY: "false",
    },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, requests };
}

function text(result) {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return result.content.map((item) => item.text).join("\n");
}

test("MCP schemas advertise message cursors, time filters, and agent offsets", async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  const messageSchema = tools.find((tool) => tool.name === "get_messages").inputSchema;
  assert.ok(messageSchema.properties.before);
  assert.ok(messageSchema.properties.after);
  assert.ok(messageSchema.properties.cursor);
  assert.equal(messageSchema.properties.cursor.minLength, 1);
  const outputSchema = tools.find((tool) => tool.name === "get_messages").outputSchema;
  assert.ok(outputSchema.properties.nextCursor);
  assert.ok(outputSchema.properties.nextCursor.anyOf.some((item) => item.type === "null"));
  assert.equal(messageSchema.properties.offset, undefined);
  assert.ok(tools.find((tool) => tool.name === "list_agents").inputSchema.properties.offset);
});

test("message pages advance using the opaque cursor returned by the backend", async (t) => {
  const { client, requests } = await connect(t);
  const firstResult = await client.callTool({
    name: "get_messages", arguments: { number_id: "number/with spaces", limit: 2 },
  });
  const first = text(firstResult);
  assert.match(first, /Newest/);
  assert.match(first, /Middle/);
  assert.doesNotMatch(first, /Oldest/);
  assert.match(first, /More messages/);
  assert.deepEqual(firstResult.structuredContent.data, messages.slice(0, 2));
  assert.equal(firstResult.structuredContent.nextCursor, cursorFor(2));
  assert.ok(first.includes(`cursor=${JSON.stringify(cursorFor(2))}`));

  const second = text(await client.callTool({
    name: "get_messages",
    arguments: { number_id: "number/with spaces", limit: 2, cursor: firstResult.structuredContent.nextCursor },
  }));
  assert.match(second, /Oldest/);
  assert.doesNotMatch(second, /Newest|Middle|More messages/);
  assert.equal(requests[1].url.pathname, "/v1/numbers/number%2Fwith%20spaces/messages");
  assert.equal(requests[1].url.searchParams.get("cursor"), cursorFor(2));
  assert.match(requests[1].url.search, /cursor=opaque%2F%2B\+%3D2/);
  assert.equal(requests[1].url.searchParams.has("offset"), false);
  assert.equal(requests[1].authorization, "Bearer test-key");
});

test("message requests preserve before and after filters and fractional seconds", async (t) => {
  const { client, requests } = await connect(t);
  const result = text(await client.callTool({
    name: "get_messages",
    arguments: { number_id: "n1", before: messages[0].receivedAt, after: messages[2].receivedAt },
  }));
  assert.match(result, /Middle/);
  assert.doesNotMatch(result, /Newest|Oldest/);
  assert.equal(requests[0].url.searchParams.get("before"), messages[0].receivedAt);
  assert.equal(requests[0].url.searchParams.get("after"), messages[2].receivedAt);
});

test("cursor pagination retrieves over 200 messages once each across equal timestamp boundaries", async (t) => {
  const { client, requests } = await connect(t);
  let cursor;
  const ids = [];
  for (let page = 0; page < 3; page++) {
    const response = await client.callTool({
      name: "get_messages", arguments: { number_id: "ties", limit: 100, ...(cursor ? { cursor, before: "2000-01-01T00:00:00Z", after: "2099-01-01T00:00:00Z" } : {}) },
    });
    const rendered = text(response);
    ids.push(...response.structuredContent.data.map((item) => item.id));
    cursor = response.structuredContent.nextCursor;
    if (page < 2) assert.ok(rendered.includes(`cursor=${JSON.stringify(cursor)}`));
    else {
      assert.equal(cursor, null);
      assert.doesNotMatch(rendered, /More messages/);
    }
  }
  assert.deepEqual(ids, ties.map((item) => item.id));
  assert.equal(requests[1].url.searchParams.get("cursor"), cursorFor(100));
  assert.equal(requests[1].url.searchParams.get("before"), "2000-01-01T00:00:00Z");
  assert.equal(requests[1].url.searchParams.get("after"), "2099-01-01T00:00:00Z");
});

test("complete message pages do not advertise another page", async (t) => {
  const { client, requests } = await connect(t);
  const result = text(await client.callTool({ name: "get_messages", arguments: { number_id: "n1" } }));
  assert.match(result, /3 message\(s\)/);
  assert.doesNotMatch(result, /More messages|before=/);
  assert.equal(requests[0].url.searchParams.get("limit"), "50");
  assert.equal(requests[0].url.searchParams.has("before"), false);
  assert.equal(requests[0].url.searchParams.has("after"), false);
});

test("empty filtered pages do not imply the number has never received messages", async (t) => {
  const { client } = await connect(t);
  const response = await client.callTool({
    name: "get_messages", arguments: { number_id: "n1", before: "2026-01-01T00:00:00Z" },
  });
  const result = text(response);
  assert.match(result, /No messages found.*time range/);
  assert.doesNotMatch(result, /More messages/);
  assert.deepEqual(response.structuredContent.data, []);
});

test("missing or empty next cursors give qualified fallback guidance without inventing a cursor", async (t) => {
  for (const nextCursor of [null, undefined, ""]) {
    await t.test(String(nextCursor), async (t) => {
      const body = { data: [messages[0]], hasMore: true, ...(nextCursor === undefined ? {} : { nextCursor }) };
      const { client } = await connect(t, () => ({ body }));
      const response = await client.callTool({ name: "get_messages", arguments: { number_id: "n1" } });
      const rendered = text(response);
      assert.match(rendered, /API did not return a usable next cursor/);
      assert.match(rendered, /omit cursor and use before\/after filters/);
      assert.match(rendered, /skip messages sharing a page boundary/);
      assert.match(rendered, /cannot guarantee complete history/);
      assert.doesNotMatch(rendered, /cursor=|before=/);
      assert.deepEqual(response.structuredContent, body);
    });
  }
});

test("empty pages distinguish cursors, time filters, and unfiltered requests", async (t) => {
  const body = { data: [], hasMore: false, nextCursor: null };
  const { client } = await connect(t, () => ({ body }));
  for (const [args, expected] of [
    [{}, "No messages found for this number."],
    [{ before: "2026-01-01T00:00:00Z" }, "No messages found for this number in the requested time range."],
    [{ cursor: "end" }, "No messages found on this page."],
    [{ cursor: "end", after: "2026-01-01T00:00:00Z" }, "No messages found on this page."],
  ]) {
    const response = await client.callTool({ name: "get_messages", arguments: { number_id: "n1", ...args } });
    assert.equal(text(response), expected);
    assert.deepEqual(response.structuredContent, body);
  }
});

test("empty intermediate pages still surface the backend continuation cursor", async (t) => {
  const body = { data: [], hasMore: true, nextCursor: "next-page" };
  const { client } = await connect(t, () => ({ body }));
  const response = await client.callTool({ name: "get_messages", arguments: { number_id: "n1", cursor: "current-page" } });
  assert.match(text(response), /No messages found on this page/);
  assert.match(text(response), /cursor="next-page"/);
  assert.deepEqual(response.structuredContent, body);
});

test("final pages never advertise continuation even if a cursor remains in the response", async (t) => {
  const body = { data: [messages[2]], hasMore: false, nextCursor: "unused" };
  const { client } = await connect(t, () => ({ body }));
  const response = await client.callTool({ name: "get_messages", arguments: { number_id: "n1" } });
  assert.doesNotMatch(text(response), /More messages|cursor=/);
  assert.deepEqual(response.structuredContent, body);
});

test("opaque cursors survive reserved characters and text escaping unchanged", async (t) => {
  const cursor = ' opaque/+ =%&before=other#?"\\\n雪 ';
  const body = { data: [messages[0]], hasMore: true, nextCursor: cursor };
  const { client, requests } = await connect(t, () => ({ body }));
  const response = await client.callTool({ name: "get_messages", arguments: { number_id: "n1", cursor } });
  assert.equal(requests[0].url.searchParams.get("cursor"), cursor);
  assert.equal(requests[0].url.searchParams.has("before"), false);
  assert.equal(requests[0].url.searchParams.size, 2);
  assert.ok(text(response).includes(`cursor=${JSON.stringify(cursor)}`));
  assert.equal(response.structuredContent.nextCursor, cursor);
});

test("cursor continuation preserves the filtered result set selected by the backend", async (t) => {
  const { client } = await connect(t);
  const first = await client.callTool({ name: "get_messages", arguments: {
    number_id: "n1", limit: 1, after: messages[2].receivedAt,
  } });
  text(first);
  assert.deepEqual(first.structuredContent.data, [messages[0]]);
  const second = await client.callTool({ name: "get_messages", arguments: {
    number_id: "n1", limit: 1, cursor: first.structuredContent.nextCursor,
  } });
  text(second);
  assert.deepEqual(second.structuredContent.data, [messages[1]]);
  assert.equal(second.structuredContent.hasMore, false);
  assert.equal(second.structuredContent.nextCursor, null);
});

test("backend rejection of an invalid cursor is returned as a tool error", async (t) => {
  const { client, requests } = await connect(t);
  const response = await client.callTool({ name: "get_messages", arguments: { number_id: "n1", cursor: "invalid" } });
  assert.equal(response.isError, true);
  assert.match(response.content.map((item) => item.text).join("\n"), /Invalid cursor/);
  assert.equal(response.structuredContent, undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.searchParams.get("cursor"), "invalid");
});

test("agents advance with offset while preserving the total", async (t) => {
  const { client, requests } = await connect(t);
  const response = await client.callTool({
    name: "list_agents", arguments: { limit: 2, offset: 2 },
  });
  const result = JSON.parse(text(response));
  assert.deepEqual(result, { data: [{ id: "a3" }], total: 3 });
  assert.deepEqual(response.structuredContent, result);
  assert.equal(requests[0].url.searchParams.get("offset"), "2");
  assert.equal(requests[0].url.searchParams.get("limit"), "2");
});

test("agent pagination defaults to the first page", async (t) => {
  const { client, requests } = await connect(t);
  await client.callTool({ name: "list_agents", arguments: {} });
  assert.equal(requests[0].url.searchParams.get("offset"), "0");
  assert.equal(requests[0].url.searchParams.get("limit"), "20");
});

test("invalid pagination arguments are rejected before making backend requests", async (t) => {
  const { client, requests } = await connect(t);
  for (const [name, args] of [
    ["get_messages", { number_id: "n1", before: "not-a-timestamp" }],
    ["get_messages", { number_id: "n1", after: "2026-10-13" }],
    ["get_messages", { number_id: "n1", cursor: "" }],
    ["get_messages", { number_id: "n1", cursor: 42 }],
    ["list_agents", { offset: -1 }],
    ["list_agents", { offset: 1.5 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(requests.length, 0);
});
