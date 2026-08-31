import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

const REQUIRED_HINTS = ["readOnlyHint", "destructiveHint", "openWorldHint"];

function startStdioServer(t) {
  const env = {
    ...process.env,
    AGENTPHONE_API_KEY: "test-api-key",
    MCP_USE_ANONYMIZED_TELEMETRY: "false",
  };
  // stdio mode must be selected even on a machine where PORT happens to be set.
  delete env.PORT;

  const child = spawn(process.execPath, ["dist/index.js", "--stdio"], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });

  // The stdio transport frames JSON-RPC as newline-delimited JSON on stdout.
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });

  let nextId = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) {
          reject(new Error(`Timed out waiting for ${method}\nServer output:\n${stderr}`));
        }
      }, 15_000).unref();
    });

  const notify = (method, params) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

  return { request, notify, stderr: () => stderr };
}

async function listTools(t) {
  const { request, notify, stderr } = startStdioServer(t);

  const initialized = await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "metadata-test", version: "0.0.0" },
  });
  assert.equal(initialized.result?.serverInfo?.name, "agentphone", stderr());
  notify("notifications/initialized", {});

  const listed = await request("tools/list", {});
  const tools = listed.result?.tools;
  assert.ok(Array.isArray(tools), `tools/list returned no tools\n${stderr()}`);
  return tools;
}

test("stdio tools advertise a title and all three behavior hints", async (t) => {
  const tools = await listTools(t);
  assert.equal(tools.length, 28);

  for (const tool of tools) {
    assert.equal(
      typeof tool.title,
      "string",
      `${tool.name} is missing a top-level title`
    );
    assert.ok(tool.title.length > 0, `${tool.name} has an empty title`);
    for (const hint of REQUIRED_HINTS) {
      assert.equal(
        typeof tool.annotations?.[hint],
        "boolean",
        `${tool.name} is missing annotations.${hint}`
      );
    }
  }
});

test("stdio tool metadata carries the declared values", async (t) => {
  const tools = await listTools(t);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  // A destructive, open-world write.
  const buyNumber = byName.get("buy_number");
  assert.equal(buyNumber.title, "Buy Phone Number");
  assert.deepEqual(
    {
      readOnlyHint: buyNumber.annotations.readOnlyHint,
      destructiveHint: buyNumber.annotations.destructiveHint,
      openWorldHint: buyNumber.annotations.openWorldHint,
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
  );

  // A pure read, and proof that inline hints from tools.ts survive the merge.
  const accountOverview = byName.get("account_overview");
  assert.equal(accountOverview.title, "Account Overview");
  assert.equal(accountOverview.annotations.readOnlyHint, true);
  assert.equal(accountOverview.annotations.destructiveHint, false);
  assert.equal(accountOverview.annotations.openWorldHint, false);
  assert.equal(accountOverview.annotations.idempotentHint, true);
});
