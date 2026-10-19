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

async function connect(t) {
  const requests = [];
  const backend = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ url, authorization: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    const limit = Number(url.searchParams.get("limit"));
    if (url.pathname === "/v1/agents") {
      const offset = Number(url.searchParams.get("offset"));
      res.end(JSON.stringify({ data: agents.slice(offset, offset + limit), total: agents.length }));
      return;
    }
    const before = url.searchParams.get("before");
    const after = url.searchParams.get("after");
    const filtered = messages.filter((message) =>
      (!before || Date.parse(message.receivedAt) < Date.parse(before)) &&
      (!after || Date.parse(message.receivedAt) > Date.parse(after))
    );
    const data = filtered.slice(0, limit);
    res.end(JSON.stringify({ data, hasMore: filtered.length > data.length }));
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
  assert.notEqual(result.isError, true);
  return result.content.map((item) => item.text).join("\n");
}

test("MCP schemas advertise timestamp cursors for messages and offsets for agents", async (t) => {
  const { client } = await connect(t);
  const { tools } = await client.listTools();
  const messageSchema = tools.find((tool) => tool.name === "get_messages").inputSchema;
  assert.ok(messageSchema.properties.before);
  assert.ok(messageSchema.properties.after);
  assert.equal(messageSchema.properties.offset, undefined);
  assert.ok(tools.find((tool) => tool.name === "list_agents").inputSchema.properties.offset);
});

test("message pages advance using the exact timestamp returned by the backend", async (t) => {
  const { client, requests } = await connect(t);
  const first = text(await client.callTool({
    name: "get_messages", arguments: { number_id: "number/with spaces", limit: 2 },
  }));
  assert.match(first, /Newest/);
  assert.match(first, /Middle/);
  assert.doesNotMatch(first, /Oldest/);
  assert.match(first, /More messages/);
  assert.ok(first.includes(`before="${messages[1].receivedAt}"`));

  const second = text(await client.callTool({
    name: "get_messages",
    arguments: { number_id: "number/with spaces", limit: 2, before: messages[1].receivedAt },
  }));
  assert.match(second, /Oldest/);
  assert.doesNotMatch(second, /Newest|Middle|More messages/);
  assert.equal(requests[1].url.pathname, "/v1/numbers/number%2Fwith%20spaces/messages");
  assert.equal(requests[1].url.searchParams.get("before"), messages[1].receivedAt);
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

test("continuing an after-filtered page preserves the lower timestamp bound", async (t) => {
  const { client } = await connect(t);
  const first = text(await client.callTool({
    name: "get_messages",
    arguments: { number_id: "n1", limit: 1, after: messages[2].receivedAt },
  }));
  assert.ok(first.includes(`before="${messages[0].receivedAt}"`));
  assert.match(first, /same number_id and after filter/);

  const second = text(await client.callTool({
    name: "get_messages",
    arguments: {
      number_id: "n1", limit: 1, before: messages[0].receivedAt, after: messages[2].receivedAt,
    },
  }));
  assert.match(second, /Middle/);
  assert.doesNotMatch(second, /Newest|Oldest|More messages/);
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
  const result = text(await client.callTool({
    name: "get_messages", arguments: { number_id: "n1", before: "2026-01-01T00:00:00Z" },
  }));
  assert.match(result, /No messages found.*time range/);
  assert.doesNotMatch(result, /More messages/);
});

test("agents advance with offset while preserving the total", async (t) => {
  const { client, requests } = await connect(t);
  const result = JSON.parse(text(await client.callTool({
    name: "list_agents", arguments: { limit: 2, offset: 2 },
  })));
  assert.deepEqual(result, { data: [{ id: "a3" }], total: 3 });
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
    ["list_agents", { offset: -1 }],
    ["list_agents", { offset: 1.5 }],
  ]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(requests.length, 0);
});
