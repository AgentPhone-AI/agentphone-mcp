import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json");

async function reservePort() {
  const socket = net.createServer();
  socket.listen(0, "localhost");
  await once(socket, "listening");
  const address = socket.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve, reject) => socket.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitUntilReady(url, child) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`HTTP server exited before becoming ready (${child.exitCode})`);
    }
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP server did not become ready: ${lastError ?? "timeout"}`);
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
  delete env.AGENTPHONE_BASE_URL;
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

  return { child, logs: () => logs, origin };
}

test("production HTTP routing serves discovery JSON and returns real 404s", async (t) => {
  const { child, logs, origin } = await startHttpServer(t, {
    MCP_OAUTH_CLIENT_ID: "test-client",
    MCP_OAUTH_CLIENT_SECRET: "test-secret",
  });

  try {
    await waitUntilReady(`${origin}/.well-known/oauth-authorization-server`, child);

    const cardResponse = await fetch(`${origin}/.well-known/mcp/server-card.json`);
    assert.equal(cardResponse.status, 200);
    assert.match(cardResponse.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal(cardResponse.headers.get("access-control-allow-origin"), "*");
    assert.equal(cardResponse.headers.get("cache-control"), "public, max-age=3600");
    const card = await cardResponse.json();
    assert.equal(card.serverInfo.name, "agentphone");
    assert.equal(card.serverInfo.version, packageVersion);
    assert.equal(card.transport.type, "streamable-http");
    assert.equal(card.transport.endpoint, "/mcp");
    assert.equal(card.authentication.required, true);
    assert.deepEqual(card.authentication.schemes, ["oauth2", "bearer"]);
    assert.deepEqual(card.tools, ["dynamic"]);

    const protectedResource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(protectedResource.status, 200);
    assert.match(protectedResource.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal((await protectedResource.json()).resource, `${origin}/mcp`);

    const authorizationServer = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    assert.equal(authorizationServer.status, 200);
    assert.match(authorizationServer.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal((await authorizationServer.json()).issuer, origin);

    const challenge = await fetch(`${origin}/mcp`);
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("content-type") ?? "", /^application\/json\b/);
    const authenticate = challenge.headers.get("www-authenticate") ?? "";
    const metadataMatch = authenticate.match(/resource_metadata="([^"]+)"/);
    assert.ok(metadataMatch, "WWW-Authenticate must advertise OAuth resource metadata");
    const advertisedMetadata = await fetch(metadataMatch[1]);
    assert.equal(advertisedMetadata.status, 200);
    assert.match(advertisedMetadata.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.match((await advertisedMetadata.json()).resource, new RegExp(`^${origin}/?(?:mcp)?$`));

    const missing = await fetch(`${origin}/this-route-does-not-exist`);
    assert.equal(missing.status, 404);
    assert.doesNotMatch(missing.headers.get("content-type") ?? "", /^text\/html\b/);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("server card requires authentication for a self-hosted API-key server by default", async (t) => {
  const { child, logs, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "test-api-key",
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const response = await fetch(`${origin}/.well-known/mcp/server-card.json`);
    assert.equal(response.status, 200);
    const card = await response.json();
    assert.equal(card.authentication.required, true);
    assert.deepEqual(card.authentication.schemes, ["bearer"]);
    assert.match(logs(), /AGENTPHONE_API_KEY is not used for HTTP callers/);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("server card reflects the explicit anonymous opt-in", async (t) => {
  const { child, logs, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "test-api-key",
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const response = await fetch(`${origin}/.well-known/mcp/server-card.json`);
    const card = await response.json();
    assert.equal(card.authentication.required, false);
    assert.deepEqual(card.authentication.schemes, ["bearer"]);
    assert.match(logs(), /AGENTPHONE_ALLOW_ANONYMOUS=true/);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

// A stand-in for api.agentphone.ai that records the Authorization header it
// receives, so the tests can prove which credential the MCP server forwarded.
async function startFakeBackend(t, respond) {
  const seen = [];
  const backend = http.createServer((req, res) => {
    seen.push(req.headers.authorization ?? "");
    if (respond) return respond(req, res);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        numbers: { used: 0, limit: 1, remaining: 1 },
        stats: {},
        periodStart: "",
        periodEnd: "",
      })
    );
  });
  backend.listen(0, "localhost");
  await once(backend, "listening");
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  return { seen, url: `http://localhost:${backend.address().port}` };
}

async function callOverHttp(origin, toolName, headers = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await client.callTool({ name: toolName, arguments: {} });
  } finally {
    await client.close();
  }
}

test("an unauthenticated tool call is rejected and never reaches the backend", async (t) => {
  const backend = await startFakeBackend(t);
  const { child, logs, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_BASE_URL: backend.url,
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const result = await callOverHttp(origin, "get_usage");
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Unauthorized: send `Authorization: Bearer/);
    assert.doesNotMatch(result.content[0].text, /AGENTPHONE_ALLOW_ANONYMOUS/);
    assert.deepEqual(backend.seen, [], "the server key must not be used on the caller's behalf");
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("a caller's own bearer token is forwarded, not the server key", async (t) => {
  const backend = await startFakeBackend(t);
  const { child, logs, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_BASE_URL: backend.url,
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const result = await callOverHttp(origin, "get_usage", { Authorization: "Bearer caller-key" });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.deepEqual(backend.seen, ["Bearer caller-key"]);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("AGENTPHONE_ALLOW_ANONYMOUS=true restores the server-key fallback", async (t) => {
  const backend = await startFakeBackend(t);
  const { child, logs, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
    AGENTPHONE_BASE_URL: backend.url,
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const result = await callOverHttp(origin, "get_usage");
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.deepEqual(backend.seen, ["Bearer server-secret-key"]);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("malformed credentials never borrow the server key even with anonymous access enabled", async (t) => {
  const backend = await startFakeBackend(t);
  const { child, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
    AGENTPHONE_BASE_URL: backend.url,
  });
  await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
  for (const authorization of ["", "Basic dXNlcjpwYXNz", "Bearer", "Bearer   ", "Bearer key extra"]) {
    await t.test(JSON.stringify(authorization), async () => {
      const result = await callOverHttp(origin, "get_usage", { Authorization: authorization });
      assert.equal(result.isError, true, result.content?.[0]?.text);
      assert.deepEqual(backend.seen, [], "malformed credentials must not reach the backend");
    });
  }
});

test("an explicit rejected bearer is never replaced by the server key", async (t) => {
  const backend = await startFakeBackend(t, (_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ detail: "Invalid API key" }));
  });
  const { child, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
    AGENTPHONE_BASE_URL: backend.url,
  });
  await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
  const result = await callOverHttp(origin, "get_usage", { Authorization: "Bearer rejected-key" });
  assert.equal(result.isError, true);
  assert.deepEqual(backend.seen, ["Bearer rejected-key"]);
  assert.match(result.content[0].text, /bearer token \(HTTP\)/);
});

test("bearer credentials work without a server API key", async (t) => {
  const backend = await startFakeBackend(t);
  const { child, origin } = await startHttpServer(t, { AGENTPHONE_BASE_URL: backend.url });
  await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
  const result = await callOverHttp(origin, "get_usage", { Authorization: "bEaReR caller-key" });
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.deepEqual(backend.seen, ["Bearer caller-key"]);
});

test("anonymous access still fails closed without a usable server key", async (t) => {
  for (const key of ["", "   "]) {
    await t.test(JSON.stringify(key), async (t) => {
      const backend = await startFakeBackend(t);
      const { child, origin } = await startHttpServer(t, {
        AGENTPHONE_API_KEY: key,
        AGENTPHONE_ALLOW_ANONYMOUS: "true",
        AGENTPHONE_BASE_URL: backend.url,
      });
      await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
      const card = await (await fetch(`${origin}/.well-known/mcp/server-card.json`)).json();
      assert.equal(card.authentication.required, true);
      const result = await callOverHttp(origin, "get_usage");
      assert.equal(result.isError, true);
      assert.deepEqual(backend.seen, []);
    });
  }
});

test("anonymous access requires the exact opt-in value", async (t) => {
  const backend = await startFakeBackend(t);
  const { child, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_ALLOW_ANONYMOUS: "false",
    AGENTPHONE_BASE_URL: backend.url,
  });
  await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
  const result = await callOverHttp(origin, "get_usage");
  assert.equal(result.isError, true);
  assert.deepEqual(backend.seen, []);
});

test("concurrent callers keep their own credentials and an anonymous caller gets none", async (t) => {
  const backend = await startFakeBackend(t, (req, res) => {
    const match = req.headers.authorization?.match(/^Bearer caller-(\d+)$/);
    if (!match) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "Unexpected credential" }));
    }
    const caller = Number(match[1]);
    // Finish out of order so each response must remain bound to its own caller.
    setTimeout(() => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ numbers: { used: caller, limit: 10, remaining: 10 - caller }, stats: {} }));
    }, (6 - caller) * 15);
  });
  const { child, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_BASE_URL: backend.url,
  });
  await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
  const callers = Array.from({ length: 6 }, (_, i) => `caller-${i}`);
  const results = await Promise.all([
    ...callers.map((key) => callOverHttp(origin, "get_usage", { Authorization: `Bearer ${key}` })),
    callOverHttp(origin, "get_usage"),
  ]);
  for (const [caller, result] of results.slice(0, -1).entries()) {
    assert.notEqual(result.isError, true);
    assert.match(result.content[0].text, new RegExp(`Phone Numbers: ${caller}/10`));
  }
  assert.equal(results.at(-1).isError, true);
  assert.deepEqual(backend.seen.sort(), callers.map((key) => `Bearer ${key}`).sort());
});

test("OAuth still verifies credentials and ignores the anonymous opt-in", async (t) => {
  const requests = [];
  const backend = await startFakeBackend(t, (req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (req.url === "/auth/me") {
      if (!["Bearer oauth-caller", "Bearer oauth-second"].includes(req.headers.authorization)) {
        res.writeHead(401);
        return res.end(JSON.stringify({ detail: "Invalid token" }));
      }
      return res.end(JSON.stringify({ user: { id: "user-1" } }));
    }
    res.end(JSON.stringify({ numbers: { used: 0, limit: 1, remaining: 1 }, stats: {} }));
  });
  const { child, origin, logs } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "server-secret-key",
    AGENTPHONE_ALLOW_ANONYMOUS: "true",
    AGENTPHONE_BASE_URL: backend.url,
    MCP_OAUTH_CLIENT_ID: "local-client",
    AGENTPHONE_OAUTH_AUTHORIZE: `${backend.url}/authorize`,
    AGENTPHONE_OAUTH_ISSUER: backend.url,
  });
  await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
  const card = await (await fetch(`${origin}/.well-known/mcp/server-card.json`)).json();
  assert.equal(card.authentication.required, true);
  const post = (headers = {}) => fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_usage", arguments: {} } }),
  });
  assert.equal((await post()).status, 401);
  assert.equal((await post({ Authorization: "Bearer rejected-key" })).status, 401);
  assert.equal(requests.filter((r) => r.path === "/v1/usage").length, 0);
  const result = await callOverHttp(origin, "get_usage", { Authorization: "Bearer oauth-caller" });
  assert.notEqual(result.isError, true, `${JSON.stringify(result)} ${logs()}`);
  assert.deepEqual(requests.filter((r) => r.path === "/v1/usage"), [{ path: "/v1/usage", auth: "Bearer oauth-caller" }]);
  assert.ok(!backend.seen.includes("Bearer server-secret-key"));
  assert.match(logs(), /AGENTPHONE_ALLOW_ANONYMOUS is ignored because OAuth is enabled/);

  // Reuse a session with a different verified bearer, then remove it. The
  // framework must verify each request rather than reuse initialization auth.
  const headers = { Authorization: "Bearer oauth-caller" };
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "test", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  headers.Authorization = "Bearer oauth-second";
  const switched = await client.callTool({ name: "get_usage", arguments: {} });
  assert.notEqual(switched.isError, true);
  assert.equal(requests.filter((r) => r.path === "/v1/usage").at(-1).auth, "Bearer oauth-second");
  delete headers.Authorization;
  const before = requests.filter((r) => r.path === "/v1/usage").length;
  await assert.rejects(client.callTool({ name: "get_usage", arguments: {} }));
  assert.equal(requests.filter((r) => r.path === "/v1/usage").length, before);
});

test("HTTP credentials are read on every request in the same MCP session", async (t) => {
  const backend = await startFakeBackend(t);
  const { child, origin } = await startHttpServer(t, { AGENTPHONE_API_KEY: "server-secret-key", AGENTPHONE_BASE_URL: backend.url });
  await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
  const headers = { Authorization: "Bearer first-caller" };
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers } });
  const client = new Client({ name: "test", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.notEqual((await client.callTool({ name: "get_usage", arguments: {} })).isError, true);
  headers.Authorization = "Bearer second-caller";
  assert.notEqual((await client.callTool({ name: "get_usage", arguments: {} })).isError, true);
  delete headers.Authorization;
  assert.equal((await client.callTool({ name: "get_usage", arguments: {} })).isError, true);
  assert.deepEqual(backend.seen, ["Bearer first-caller", "Bearer second-caller"]);
});

test("HTTP and stdio enforce webhook defaults and reaction validation through the real SDK", async (t) => {
  for (const mode of ["http", "stdio"]) {
    await t.test(mode, async (t) => {
      const secret = "whsec_transport_test_secret";
      const requests = [];
      const backend = await startFakeBackend(t, (req, res) => {
        requests.push({ path: req.url, method: req.method });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "wh_1", url: "https://example.com/hook", secret, status: "active" }));
      });
      let transport;
      if (mode === "http") {
        const { child, origin } = await startHttpServer(t, { AGENTPHONE_BASE_URL: backend.url });
        await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);
        transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: "Bearer caller-key" } } });
      } else {
        transport = new StdioClientTransport({
          command: process.execPath, args: ["dist/index.js", "--stdio"], cwd: process.cwd(),
          env: { AGENTPHONE_API_KEY: "stdio-key", AGENTPHONE_BASE_URL: backend.url, MCP_USE_ANONYMIZED_TELEMETRY: "false" }, stderr: "pipe",
        });
        transport.stderr?.on("data", () => {});
      }
      const client = new Client({ name: "test", version: "0.0.0" });
      t.after(() => client.close());
      await client.connect(transport);
      const listed = (await client.listTools()).tools;
      for (const name of ["get_webhook", "set_webhook"]) {
        const schema = listed.find((tool) => tool.name === name).inputSchema;
        assert.equal(schema.properties.reveal_secret.default, false);
        assert.ok(!(schema.required ?? []).includes("reveal_secret"));
        const args = name === "set_webhook" ? { url: "https://example.com/hook" } : {};
        const masked = await client.callTool({ name, arguments: args });
        assert.notEqual(masked.isError, true, JSON.stringify(masked));
        assert.ok(!masked.content[0].text.includes(secret));
        const shown = await client.callTool({ name, arguments: { ...args, reveal_secret: true } });
        assert.ok(shown.content[0].text.includes(secret));
      }
      const callsBefore = requests.length;
      const invalid = await client.callTool({ name: "get_webhook", arguments: { reveal_secret: "true" } });
      assert.equal(invalid.isError, true);
      const mixed = await client.callTool({ name: "send_message", arguments: { reaction: "love", react_to_message_id: "msg_1", body: "hello" } });
      assert.equal(mixed.isError, true);
      assert.equal(requests.length, callsBefore, "invalid calls must not hit the API");
      assert.ok(backend.seen.every((auth) => auth === `Bearer ${mode === "http" ? "caller-key" : "stdio-key"}`));
    });
  }
});

test("stdio rejects a whitespace-only API key before any backend call", async (t) => {
  const backend = await startFakeBackend(t);
  const transport = new StdioClientTransport({
    command: process.execPath, args: ["dist/index.js", "--stdio"], cwd: process.cwd(),
    env: { AGENTPHONE_API_KEY: "   ", AGENTPHONE_BASE_URL: backend.url }, stderr: "pipe",
  });
  let logs = "";
  transport.stderr?.on("data", (chunk) => (logs += chunk));
  const client = new Client({ name: "test", version: "0.0.0" });
  t.after(() => client.close());
  await assert.rejects(client.connect(transport));
  assert.match(logs, /AGENTPHONE_API_KEY environment variable is required/);
  assert.deepEqual(backend.seen, []);
});

test("explicit Inspector opt-in overrides production mode", async (t) => {
  const { child, logs, origin } = await startHttpServer(t, {
    MCP_ENABLE_INSPECTOR: "true",
    NODE_ENV: "production",
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const response = await fetch(`${origin}/inspector`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});

test("HTTP mode preserves an explicit development environment", async (t) => {
  const { child, logs, origin } = await startHttpServer(t, {
    NODE_ENV: "development",
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const response = await fetch(`${origin}/inspector`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
});
