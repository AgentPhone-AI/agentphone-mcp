import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";

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

test("server card reflects self-hosted API-key authentication", async (t) => {
  const { child, logs, origin } = await startHttpServer(t, {
    AGENTPHONE_API_KEY: "test-api-key",
  });

  try {
    await waitUntilReady(`${origin}/.well-known/mcp/server-card.json`, child);

    const response = await fetch(`${origin}/.well-known/mcp/server-card.json`);
    assert.equal(response.status, 200);
    const card = await response.json();
    assert.equal(card.authentication.required, false);
    assert.deepEqual(card.authentication.schemes, ["bearer"]);
  } catch (error) {
    throw new Error(`${error.message}\nServer output:\n${logs()}`, { cause: error });
  }
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
