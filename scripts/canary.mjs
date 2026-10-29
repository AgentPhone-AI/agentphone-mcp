#!/usr/bin/env node
/**
 * Read-only post-deploy canary (tasks#205). Connects to a deployed MCP endpoint
 * over Streamable HTTP, verifies the handshake and tool surface, and (when a
 * token is supplied) exercises one read-only tool to confirm the deployment can
 * actually serve a request end to end. It performs NO mutations — no sends,
 * purchases, calls, deletes or webhook dispatches.
 *
 *   MCP_CANARY_URL    deployed /mcp URL (e.g. https://mcp.agentphone.ai/mcp)
 *   MCP_CANARY_TOKEN  optional bearer; when set, runs a read-only tool call
 *
 * Exits 0 on success, 1 on failure, and skips cleanly (0) when no URL is set so
 * it is safe to wire into a deploy step unconditionally.
 */
const url = process.env.MCP_CANARY_URL;
if (!url) {
  console.log("canary: MCP_CANARY_URL not set — skipping.");
  process.exit(0);
}

const token = process.env.MCP_CANARY_TOKEN;
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

// Tools that must never be absent from a healthy deployment.
const EXPECTED = ["account_overview", "list_numbers", "list_agents", "get_call", "list_voices"];
// Read-only tool to exercise when a token is available (no side effects).
const READONLY_TOOL = "list_voices";

let failed = false;
const fail = (m) => { console.error(`  ✗ ${m}`); failed = true; };
const ok = (m) => console.log(`  ✓ ${m}`);

// Overall deadline so a reachable-but-stalled deployment fails instead of
// hanging npm run canary forever. Covers the handshake, tools/list and the
// optional read-only call.
const TIMEOUT_MS = Number(process.env.MCP_CANARY_TIMEOUT_MS || 20_000);
let timer;
const deadline = new Promise((_, reject) => {
  timer = setTimeout(() => reject(new Error(`canary exceeded ${TIMEOUT_MS}ms deadline`)), TIMEOUT_MS);
});

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
});
const client = new Client({ name: "agentphone-canary", version: "0.0.0" });

async function run() {
  await client.connect(transport);
  ok(`connected to ${url}`);

  const tools = (await client.listTools()).tools;
  ok(`tools/list returned ${tools.length} tools`);
  const names = new Set(tools.map((t) => t.name));
  for (const n of EXPECTED) {
    if (names.has(n)) ok(`exposes ${n}`);
    else fail(`missing expected tool ${n}`);
  }
  // Every tool must carry a title + behavior hints (platform compatibility).
  for (const t of tools) {
    const a = t.annotations ?? {};
    if (!t.title) fail(`${t.name}: missing title`);
    if (["readOnlyHint", "destructiveHint", "openWorldHint"].some((h) => typeof a[h] !== "boolean")) {
      fail(`${t.name}: incomplete behavior hints`);
    }
  }

  if (token) {
    const r = await client.callTool({ name: READONLY_TOOL, arguments: {} });
    if (r.isError) fail(`read-only ${READONLY_TOOL} call errored: ${r.content?.[0]?.text ?? ""}`);
    else ok(`read-only ${READONLY_TOOL} call succeeded`);
  } else {
    console.log("  (no MCP_CANARY_TOKEN — skipped the authenticated read-only call)");
  }
}

try {
  await Promise.race([run(), deadline]);
} catch (e) {
  fail(`canary threw: ${e?.message ?? e}`);
} finally {
  clearTimeout(timer);
  try { await client.close(); } catch {}
}

if (failed) {
  console.error("Post-deploy canary FAILED.");
  process.exit(1);
}
console.log("Post-deploy canary OK.");
