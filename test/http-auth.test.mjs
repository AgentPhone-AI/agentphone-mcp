import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import test from "node:test";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

async function reservePort() {
  const socket = net.createServer();
  socket.listen(0, "localhost");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/**
 * Stub AgentPhone REST API. Records the Authorization header of every request
 * so a test can prove which credential the server forwarded upstream.
 */
async function startStubBackend(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization ?? null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [], total: 0 }));
  });
  server.listen(0, "localhost");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { origin: `http://localhost:${server.address().port}`, seen: () => seen };
}

async function startHttpServer(t, environment = {}) {
  const port = await reservePort();
  const origin = `http://localhost:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    MCP_URL: origin,
    MCP_USE_ANONYMIZED_TELEMETRY: "false",
    NODE_ENV: "production",
  };
  delete env.AGENTPHONE_API_KEY;
  delete env.AGENTPHONE_ALLOW_ANONYMOUS;
  delete env.MCP_ENABLE_INSPECTOR;
  delete env.MCP_OAUTH_CLIENT_ID;
  delete env.MCP_OAUTH_CLIENT_SECRET;
  Object.assign(env, environment);

  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => (logs += chunk));
  child.stderr.on("data", (chunk) => (logs += chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited before becoming ready (${child.exitCode})\n${logs}`);
    }
    try {
      const probe = await fetch(`${origin}/.well-known/mcp/server-card.json`);
      if (probe.status === 200) return { origin, logs: () => logs };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not become ready\n${logs}`);
}

/** Streamable HTTP replies with either a JSON body or a one-shot SSE frame. */
function decodeRpcBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return data ? JSON.parse(data) : null;
}

async function rpc(origin, { method, params, token, sessionId, id = 1 }) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const body = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { response, message: decodeRpcBody(await response.text()) };
}

/** Complete the MCP handshake and return the negotiated session id. */
async function openSession(origin, token) {
  const { response, message } = await rpc(origin, {
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "auth-test", version: "0.0.0" },
    },
    token,
  });
  assert.equal(response.status, 200, `initialize failed: ${JSON.stringify(message)}`);
  const sessionId = response.headers.get("mcp-session-id");
  await rpc(origin, { method: "notifications/initialized", token, sessionId, id: null });
  return sessionId;
}

async function callTool(origin, { name, args = {}, token, sessionId }) {
  const { message } = await rpc(origin, {
    method: "tools/call",
    params: { name, arguments: args },
    token,
    sessionId,
    id: 2,
  });
  return message?.result ?? message;
}

test("unauthenticated tool call does not borrow the server's API key", async (t) => {
  const backend = await startStubBackend(t);
  const { origin, logs } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-side-secret",
    AGENTPHONE_BASE_URL: backend.origin,
  });

  try {
    const sessionId = await openSession(origin);
    const result = await callTool(origin, { name: "list_agents", sessionId });

    assert.equal(result.isError, true, `expected refusal, got ${JSON.stringify(result)}`);
    assert.match(result.content[0].text, /Authentication required/i);
    // The refusal goes to an unauthenticated caller, so it must not disclose
    // whether the server holds a key, nor name the flag that would share it.
    assert.doesNotMatch(
      result.content[0].text,
      /AGENTPHONE_API_KEY|ALLOW_ANONYMOUS/,
      "refusal must not reflect server configuration"
    );
    // The decisive assertion: nothing reached the AgentPhone API at all.
    assert.deepEqual(backend.seen(), []);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("a caller-supplied key is forwarded instead of the server's own", async (t) => {
  const backend = await startStubBackend(t);
  const { origin, logs } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-side-secret",
    AGENTPHONE_BASE_URL: backend.origin,
  });

  try {
    const sessionId = await openSession(origin, "caller-key");
    const result = await callTool(origin, { name: "list_agents", token: "caller-key", sessionId });

    assert.notEqual(result.isError, true, `unexpected error: ${JSON.stringify(result)}`);
    const requests = backend.seen();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer caller-key");
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("anonymous opt-in is refused and reported when OAuth takes precedence", async (t) => {
  const backend = await startStubBackend(t);
  const { origin, logs } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-side-secret",
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
    MCP_OAUTH_CLIENT_ID: "test-client",
    MCP_OAUTH_CLIENT_SECRET: "test-secret",
    AGENTPHONE_BASE_URL: backend.origin,
  });

  try {
    // The card must not advertise an open endpoint just because the flag is set.
    const card = await (await fetch(`${origin}/.well-known/mcp/server-card.json`)).json();
    assert.equal(card.authentication.required, true);

    // OAuth rejects the unauthenticated call before it can reach a tool.
    const challenge = await fetch(`${origin}/mcp`);
    assert.equal(challenge.status, 401);
    assert.deepEqual(backend.seen(), []);

    // And the operator is told the flag did nothing, rather than it being
    // dropped silently.
    assert.match(logs(), /AGENTPHONE_ALLOW_ANONYMOUS=true ignored/);
    assert.match(logs(), /OAuth is configured and takes precedence/);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("anonymous opt-in without a server key is reported, not silently dropped", async (t) => {
  const { origin, logs } = await startHttpServer(t, {
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
  });

  try {
    const card = await (await fetch(`${origin}/.well-known/mcp/server-card.json`)).json();
    assert.equal(card.authentication.required, true);
    assert.match(logs(), /AGENTPHONE_ALLOW_ANONYMOUS=true ignored/);
    assert.match(logs(), /no AGENTPHONE_API_KEY is set/);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("anonymous access opt-in restores the shared-key behavior", async (t) => {
  const backend = await startStubBackend(t);
  const { origin, logs } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-side-secret",
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
    AGENTPHONE_BASE_URL: backend.origin,
  });

  try {
    const sessionId = await openSession(origin);
    const result = await callTool(origin, { name: "list_agents", sessionId });

    assert.notEqual(result.isError, true, `unexpected error: ${JSON.stringify(result)}`);
    const requests = backend.seen();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, "Bearer server-side-secret");
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});
