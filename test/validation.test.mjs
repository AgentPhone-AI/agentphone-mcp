import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  describeValidationIssue,
  installConciseValidation,
} from "../dist/validation.js";

// Real SDK, real server, bad arguments. If an SDK upgrade renames or removes
// validateToolInput, the patch cannot install and this test fails in CI.
test("bad arguments produce a concise message, not a raw Zod dump", async () => {
  const server = new McpServer({ name: "t", version: "0.0.0" });
  assert.equal(
    installConciseValidation(server),
    true,
    "Patch could be not be installed: SDK internals changed",
  );

  server.registerTool(
    "demo",
    { inputSchema: { number_id: z.string(), limit: z.number().optional() } },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  server.registerTool(
    "no_args",
    { inputSchema: {} },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const missing = await client.callTool({ name: "demo", arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(
    missing.content[0].text,
    /Invalid arguments for demo: number_id is required/,
  );
  assert.doesNotMatch(missing.content[0].text, /invalid_type|"expected"/);

  const wrongType = await client.callTool({
    name: "demo",
    arguments: { number_id: 5 },
  });
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.content[0].text, /number_id must be a string/);

  const good = await client.callTool({
    name: "demo",
    arguments: { number_id: "x" },
  });
  assert.notEqual(good.isError, true);

  const noArgs = await client.callTool({ name: "no_args" });
  assert.notEqual(noArgs.isError, true);

  await client.close();
});

test("installConciseValidation warns and returns false when the SDK method is missing", () => {
  class FakeServer {}
  const warnings = [];
  const original = console.error;
  console.error = (...a) => warnings.push(a.join(" "));
  try {
    assert.equal(installConciseValidation(new FakeServer()), false);
  } finally {
    console.error = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /validateToolInput/);
});

test("installConciseValidation is a no-op for missing servers", () => {
  assert.equal(installConciseValidation(null), false);
  assert.equal(installConciseValidation(undefined), false);
});

// --- describeValidationIssue unit tests ---

test("describeValidationIssue: missing vs wrong-typed field", () => {
  const issue = {
    code: "invalid_type",
    expected: "string",
    path: ["number_id"],
  };
  assert.equal(describeValidationIssue(issue, {}), "number_id is required");
  assert.equal(
    describeValidationIssue(issue, { number_id: 5 }),
    "number_id must be a string (text)",
  );
});

test("describeValidationIssue: nested path", () => {
  const issue = { code: "invalid_type", expected: "number", path: ["a", "b"] };
  assert.equal(describeValidationIssue(issue, { a: {} }), "a.b is required");
  assert.equal(
    describeValidationIssue(issue, { a: { b: "x" } }),
    "a.b must be a number",
  );
});

test("describeValidationIssue: too_small and too_big", () => {
  assert.equal(
    describeValidationIssue(
      {
        code: "too_small",
        origin: "string",
        minimum: 3,
        inclusive: true,
        path: ["x"],
      },
      {},
    ),
    "x must be at least 3 characters",
  );
  assert.equal(
    describeValidationIssue(
      {
        code: "too_small",
        origin: "string",
        minimum: 3,
        exact: true,
        path: ["x"],
      },
      {},
    ),
    "x must be exactly 3 characters",
  );
  assert.equal(
    describeValidationIssue(
      {
        code: "too_big",
        origin: "array",
        maximum: 5,
        inclusive: true,
        path: ["x"],
      },
      {},
    ),
    "x must be at most 5 items",
  );
});

test("describeValidationIssue: formats, enums, unknown keys, fallback", () => {
  assert.equal(
    describeValidationIssue(
      { code: "invalid_format", format: "url", path: ["url"] },
      {},
    ),
    "url must be a valid URL",
  );
  assert.equal(
    describeValidationIssue(
      { code: "invalid_value", values: ["a", "b"], path: ["mode"] },
      {},
    ),
    "mode must be one of: a, b",
  );
  assert.equal(
    describeValidationIssue(
      { code: "unrecognized_keys", keys: ["p", "q"], path: [] },
      {},
    ),
    "unexpected field(s): p, q",
  );
  assert.equal(
    describeValidationIssue(
      { code: "custom", message: "Invalid input: nope", path: ["f"] },
      {},
    ),
    "f: nope",
  );
});
