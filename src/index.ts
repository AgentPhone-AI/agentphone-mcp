#!/usr/bin/env node

/**
 * AgentPhone MCP Server
 *
 * Gives AI agents phone numbers, SMS, and voice calls via the Model Context
 * Protocol. Two transports:
 *
 *   - HTTP (hosted / `PORT` set, or `--http`): built on the mcp-use server
 *     framework, which owns Streamable HTTP, the SSE stream, session
 *     management, and OAuth discovery. OAuth (when configured) proxies the
 *     sign-in to the AgentPhone authorization server.
 *   - stdio (default for `npx agentphone-mcp`): standard MCP stdio transport
 *     for local clients (Cursor, Claude Desktop, Windsurf, Claude Code). Uses
 *     AGENTPHONE_API_KEY from the environment.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { normalizeObjectSchema, safeParseAsync } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { AgentPhoneAPI } from "./api.js";
import { registerTools, type ToolRegistrar } from "./tools.js";

const NAME = "agentphone";
const VERSION = "0.7.0";
const BASE_URL = (process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.ai").replace(/\/$/, "");
const PORT = parseInt(process.env.PORT || "3000", 10);

// Hosted platforms (Manufact, etc.) set PORT. Local MCP clients launch the bare
// command with a clean env and expect stdio. `--http` / `--stdio` force a mode.
const args = process.argv.slice(2);
const httpMode = args.includes("--http") || (!args.includes("--stdio") && !!process.env.PORT);

// mcp-use controls its Inspector and other development features through
// NODE_ENV. Let the dedicated Inspector flag take precedence, otherwise honor
// an explicitly configured environment and use the safe production default.
if (httpMode) {
  if (process.env.MCP_ENABLE_INSPECTOR === "true") {
    process.env.NODE_ENV = "development";
  } else if (process.env.MCP_ENABLE_INSPECTOR === "false" || !process.env.NODE_ENV) {
    process.env.NODE_ENV = "production";
  }
}

// ---------------------------------------------------------------------------
// Tool metadata: a human-readable title + the three MCP behavior-hint booleans
// (readOnlyHint, destructiveHint, openWorldHint) for every tool. Required by
// the OpenAI Apps / Anthropic directory compatibility checks, which want all
// three hints declared and a top-level title on each tool. Kept here (keyed by
// name) rather than inline in tools.ts, where many annotation lines are
// identical and can't carry a per-tool title.
//
// Values follow OpenAI's published tool-annotation definitions:
//   readOnlyHint    = true only when the tool just fetches/lists/retrieves and
//                     changes nothing (all get_*/list_* tools).
//   openWorldHint   = true only for writes that change publicly visible internet
//                     state or send/submit to a third party (buy_number,
//                     send_message, make_call(s), test_webhook). Internal
//                     account writes (create/update agent, contacts, webhook
//                     config, conversation metadata) are closed-system → false.
//   destructiveHint = true only for irreversible effects: sends/transactions
//                     that can't be undone (buy_number, send_message, calls),
//                     deletes (delete_agent, delete_webhook, manage_contact,
//                     which can delete), and update_conversation (metadata:null
//                     clears stored data). Reversible updates → false.
// Some automated checkers apply a name-based heuristic that (wrongly) flags
// reads like get_messages as senders; we keep the accurate values above and
// dispute those flags rather than mislabel behavior.
type ToolMeta = { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
const TOOL_META: Record<string, ToolMeta> = {
  account_overview: { title: "Account Overview", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_numbers: { title: "List Phone Numbers", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  buy_number: { title: "Buy Phone Number", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  send_message: { title: "Send Message", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  get_messages: { title: "Get Messages", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_calls: { title: "List Calls", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_call: { title: "Get Call", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  make_call: { title: "Make Call", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  make_conversation_call: { title: "Make AI Conversation Call", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_agents: { title: "List Agents", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  create_agent: { title: "Create Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  update_agent: { title: "Update Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  delete_agent: { title: "Delete Agent", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  get_agent: { title: "Get Agent", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  attach_number: { title: "Attach Number to Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  detach_number: { title: "Detach Number from Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  list_voices: { title: "List Voices", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_conversations: { title: "List Conversations", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_conversation: { title: "Get Conversation", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  update_conversation: { title: "Update Conversation", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  list_contacts: { title: "List Contacts", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  manage_contact: { title: "Manage Contact", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  get_usage: { title: "Get Usage", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_webhook: { title: "Get Webhook", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  set_webhook: { title: "Set Webhook", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  delete_webhook: { title: "Delete Webhook", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  test_webhook: { title: "Test Webhook", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  list_webhook_deliveries: { title: "List Webhook Deliveries", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

// ---------------------------------------------------------------------------
// stdio transport (default for local clients)
// ---------------------------------------------------------------------------

/**
 * Replace the MCP SDK's default input-validation error — a raw, multi-line JSON
 * dump of Zod issues (`Invalid arguments for tool X: [ { "expected": "string",
 * "code": "invalid_type", ... } ]`) — with one concise, human-readable
 * INVALID_PARAMS message. The SDK derives both the advertised tools/list schema
 * and its validation from the same `tool.inputSchema`, so overriding the
 * validation method leaves every advertised schema (types, enums, required,
 * descriptions) untouched and only changes the error text a client sees on bad
 * arguments.
 *
 * We patch the McpServer *prototype* (reached from a live instance) rather than
 * the instance itself: mcp-use runs a fresh McpServer per HTTP session, so an
 * instance-level patch on the startup server would never be hit. mcp-use also
 * loads its own nested copy of the SDK, so we take the prototype off the actual
 * instance mcp-use handed us instead of importing the class. Guarded so it runs
 * once per class.
 */
/**
 * Turn a single Zod issue into one plain-English sentence, e.g.
 * "number_id is required." or "url must be a valid URL." — instead of Zod's
 * technical phrasing ("Invalid input: expected string, received undefined").
 * `args` is the original arguments, used to tell a missing field from a
 * wrong-typed one.
 */
function describeValidationIssue(
  issue: { code?: string; path?: Array<string | number>; message?: string; [k: string]: any },
  args: unknown
): string {
  const path = issue.path ?? [];
  const field = path.join(".") || "input";
  const valueAt = (): unknown => {
    let v: any = args;
    for (const k of path) {
      if (v == null) return undefined;
      v = v[k as any];
    }
    return v;
  };
  const typeWord = (t: string): string =>
    ({
      string: "a string (text)",
      number: "a number",
      integer: "a whole number",
      boolean: "true or false",
      array: "a list",
      object: "an object",
    })[t] ?? `a ${t}`;

  switch (issue.code) {
    case "invalid_type":
      return valueAt() === undefined
        ? `${field} is required`
        : `${field} must be ${typeWord(String(issue.expected))}`;
    case "too_small": {
      const unit = issue.origin === "string" ? " characters" : issue.origin === "array" ? " items" : "";
      // Zod flags exact:true for .length(n) — report the single required value.
      if (issue.exact) return `${field} must be exactly ${issue.minimum}${unit}`;
      return `${field} must be ${issue.inclusive === false ? "greater than" : "at least"} ${issue.minimum}${unit}`;
    }
    case "too_big": {
      const unit = issue.origin === "string" ? " characters" : issue.origin === "array" ? " items" : "";
      if (issue.exact) return `${field} must be exactly ${issue.maximum}${unit}`;
      return `${field} must be ${issue.inclusive === false ? "less than" : "at most"} ${issue.maximum}${unit}`;
    }
    case "invalid_format":
      if (issue.format === "url" || issue.format === "uri") return `${field} must be a valid URL`;
      if (issue.format === "email") return `${field} must be a valid email address`;
      return `${field} has an invalid format`;
    case "invalid_value":
    case "invalid_enum_value": {
      const values = (issue.values ?? issue.options) as unknown[] | undefined;
      return values?.length
        ? `${field} must be one of: ${values.join(", ")}`
        : `${field} has an invalid value`;
    }
    case "unrecognized_keys":
      return `unexpected field(s): ${(issue.keys ?? []).join(", ")}`;
    default:
      // Fall back to Zod's message, but strip its "Invalid input: " prefix.
      return `${field}: ${(issue.message ?? "invalid value").replace(/^Invalid input:\s*/i, "")}`;
  }
}

function installConciseValidation(nativeServer: unknown): void {
  if (!nativeServer) return;
  const proto = Object.getPrototypeOf(nativeServer) as
    | {
        validateToolInput?: (tool: any, args: unknown, toolName: string) => Promise<unknown>;
        __agentphoneConciseValidation?: boolean;
      }
    | null;
  if (!proto || typeof proto.validateToolInput !== "function" || proto.__agentphoneConciseValidation) {
    return;
  }
  proto.__agentphoneConciseValidation = true;
  proto.validateToolInput = async function (tool: any, args: unknown, toolName: string) {
    if (!tool?.inputSchema) return undefined;
    const schemaToParse = normalizeObjectSchema(tool.inputSchema) ?? tool.inputSchema;
    const result = (await safeParseAsync(schemaToParse, args)) as {
      success: boolean;
      data?: unknown;
      error?: { issues?: Array<{ path?: Array<string | number>; message?: string }> };
    };
    if (!result.success) {
      const issues = result.error?.issues ?? [];
      const summary =
        issues.map((i) => describeValidationIssue(i, args)).join("; ") ||
        "one or more arguments are invalid";
      // Throw a plain Error, not the SDK's McpError: HTTP sessions run mcp-use's
      // nested SDK copy, whose `instanceof McpError` wouldn't recognize a class
      // imported from the top-level copy. Both copies funnel any thrown Error
      // through the same createToolError path, so a plain Error yields the
      // concise message as an isError result on every transport.
      throw new Error(`Invalid arguments for ${toolName}: ${summary}`);
    }
    return result.data;
  };
}

async function startStdio(): Promise<void> {
  const apiKey = process.env.AGENTPHONE_API_KEY;
  if (!apiKey) {
    console.error("AGENTPHONE_API_KEY environment variable is required for stdio mode");
    process.exit(1);
  }
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const api = new AgentPhoneAPI(BASE_URL, apiKey);
  const server = new McpServer({ name: NAME, version: VERSION });
  installConciseValidation(server);
  // McpServer.tool's signature matches ToolRegistrar exactly.
  registerTools(server as unknown as ToolRegistrar, api);
  await server.connect(new StdioServerTransport());
}

// ---------------------------------------------------------------------------
// HTTP transport (hosted) — mcp-use framework
// ---------------------------------------------------------------------------

async function verifyTokenAgainstBackend(
  token: string
): Promise<{ payload: Record<string, unknown> }> {
  // Our AS signs HS256 session JWTs (not JWKS), so validate via the backend.
  const res = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Token verification failed (${res.status})`);
  const data: any = await res.json().catch(() => ({}));
  const user = data.user ?? data;
  // Spread the raw response first so our derived identity fields win — a
  // top-level `sub`/`email` in /auth/me must not override the user's id.
  return {
    payload: {
      ...data,
      sub: String(user?.id ?? user?.user_id ?? "unknown"),
      email: user?.email,
      name: user?.name,
    },
  };
}

async function startHttp(): Promise<void> {
  const { MCPServer, oauthProxy, getRequestContext } = await import("mcp-use/server");

  // Extract a Bearer token from the raw request when OAuth isn't configured.
  // ctx.auth is only populated by the OAuth proxy flow; for the documented
  // direct-API-key setup (Authorization: Bearer <key>, no OAuth), we must read
  // the header ourselves or every call falls back to "" and 401s.
  const bearerFromHeader = (): string => {
    try {
      const c: any = getRequestContext();
      const raw: string = c?.req?.header?.("authorization") ?? "";
      return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : "";
    } catch {
      return "";
    }
  };

  // Per-request credential: the framework passes ctx.auth (verified user + raw
  // access token). We stash the token in AsyncLocalStorage so the shared API
  // client forwards the right credential without threading it through 28 tools.
  //
  // No AGENTPHONE_API_KEY fallback here: the tool wrapper below resolves the
  // credential (including the opt-in anonymous fallback) and always runs the
  // handler inside tokenStore.run, so an empty store means the request was
  // never authorized and must not silently borrow the server's own key.
  const tokenStore = new AsyncLocalStorage<string>();
  const api = new AgentPhoneAPI(BASE_URL, () => tokenStore.getStore() ?? "");

  const clientId = process.env.MCP_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    console.error(
      "Both MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET must be set to enable OAuth; " +
        "partial config ignored, OAuth disabled."
    );
  }
  const oauthEnabled = Boolean(clientId && clientSecret);
  const serverApiKey = process.env.AGENTPHONE_API_KEY;
  const hasServerApiKey = Boolean(serverApiKey);

  // A request that carries no caller credential is refused rather than falling
  // back to the server's own AGENTPHONE_API_KEY: that fallback turned any
  // self-hosted HTTP deployment into an open proxy onto the operator's account
  // for anyone who could reach the port. Single-tenant setups that genuinely
  // want one shared key for every caller (a loopback-only endpoint, a private
  // network) opt in explicitly.
  const anonymousAccess =
    !oauthEnabled && hasServerApiKey && process.env.AGENTPHONE_ALLOW_ANONYMOUS === "true";
  if (anonymousAccess) {
    console.error(
      "WARNING: AGENTPHONE_ALLOW_ANONYMOUS=true — every unauthenticated request to this " +
        "server acts on the AgentPhone account behind AGENTPHONE_API_KEY. Only run this on an " +
        "endpoint that is not publicly reachable."
    );
  }

  const AUTH_REQUIRED_MESSAGE =
    "Authentication required. Send your AgentPhone API key as an 'Authorization: Bearer <key>' " +
    "header (get one at https://agentphone.ai)." +
    (hasServerApiKey
      ? " This server has an AGENTPHONE_API_KEY configured but will not use it for " +
        "unauthenticated callers; set AGENTPHONE_ALLOW_ANONYMOUS=true to intentionally run it " +
        "as a single-tenant endpoint."
      : "");

  const server = new MCPServer({
    name: NAME,
    version: VERSION,
    ...(oauthEnabled
      ? {
          oauth: oauthProxy({
            authEndpoint:
              process.env.AGENTPHONE_OAUTH_AUTHORIZE || "https://agentphone.ai/oauth/authorize",
            tokenEndpoint: `${BASE_URL}/oauth/token`,
            issuer: process.env.AGENTPHONE_OAUTH_ISSUER || BASE_URL,
            clientId: clientId!,
            clientSecret: clientSecret!,
            scopes: ["mcp"],
            verifyToken: verifyTokenAgainstBackend,
          }),
        }
      : {}),
  });

  // mcp-use delegates tool validation to the SDK McpServer it wraps
  // (exposed as `nativeServer` / `server`); swap in concise error messages.
  installConciseValidation(
    (server as unknown as { nativeServer?: unknown; server?: unknown }).nativeServer ??
      (server as unknown as { server?: unknown }).server
  );

  // Public, unauthenticated discovery metadata. Server cards are currently a
  // draft MCP enhancement, so avoid a $schema URL until the proposal publishes
  // a stable schema. The fields below follow the draft card shape and mirror
  // the actual initialize response without exposing credentials or user data.
  server.app.get("/.well-known/mcp/server-card.json", (c: any) => {
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Access-Control-Allow-Methods", "GET");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    return c.json({
      version: "1.0",
      protocolVersion: LATEST_PROTOCOL_VERSION,
      serverInfo: {
        name: NAME,
        title: "AgentPhone MCP Server",
        version: VERSION,
      },
      description: "Give AI agents phone numbers, SMS, and voice calls.",
      documentationUrl: "https://docs.agentphone.ai/mcp",
      transport: {
        type: "streamable-http",
        endpoint: "/mcp",
      },
      capabilities: {
        tools: { listChanged: true },
      },
      authentication: {
        // Only an explicit anonymous-access opt-in makes this endpoint usable
        // without a credential.
        required: !anonymousAccess,
        schemes: oauthEnabled ? ["oauth2", "bearer"] : ["bearer"],
      },
      tools: ["dynamic"],
    });
  });

  // Adapter: keep tools.ts's SDK-style registration (4- and 5-arg overloads)
  // and bind the per-request token.
  const registrar: ToolRegistrar = {
    tool(
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      annotationsOrHandler: Record<string, unknown> | ((args: any) => Promise<any>),
      maybeHandler?: (args: any) => Promise<any>
    ): void {
      const handler = (
        typeof annotationsOrHandler === "function" ? annotationsOrHandler : maybeHandler
      )!;
      // Authoritative title + complete behavior hints come from TOOL_META so
      // every tool satisfies the platform compatibility checks (top-level title
      // + all three of readOnlyHint/destructiveHint/openWorldHint). Fall back to
      // whatever tools.ts passed inline for any tool not in the map.
      const meta = TOOL_META[name];
      const passed = (
        typeof annotationsOrHandler === "function" ? {} : annotationsOrHandler
      ) as Record<string, unknown>;
      const { title: passedTitle, ...passedHints } = passed;
      const annotations = meta
        ? {
            // Keep any inline hints tools.ts set (e.g. idempotentHint) and
            // override only the three the compatibility checker mandates.
            ...passedHints,
            readOnlyHint: meta.readOnlyHint,
            destructiveHint: meta.destructiveHint,
            openWorldHint: meta.openWorldHint,
          }
        : passedHints;
      const title = meta?.title ?? (passedTitle as string | undefined);
      server.tool(
        {
          name,
          title,
          description,
          schema: z.object(schema ?? {}),
          annotations: annotations as Record<string, unknown>,
        },
        async (params: unknown, ctx: any) => {
          // Caller-supplied credential only: the OAuth-verified token, or a
          // Bearer header for the direct-API-key setup. The server's own key is
          // used only when anonymous access was explicitly enabled.
          const callerToken: string = ctx?.auth?.accessToken || bearerFromHeader();
          const token = callerToken || (anonymousAccess ? serverApiKey! : "");
          if (!token) {
            return {
              content: [{ type: "text", text: AUTH_REQUIRED_MESSAGE }],
              isError: true,
            } as any;
          }
          return tokenStore.run(token, () => handler(params as any)) as any;
        }
      );
    },
  };

  registerTools(registrar, api);
  await server.listen(PORT);
  console.error(
    `AgentPhone MCP server listening on port ${PORT} (oauth ${oauthEnabled ? "on" : "off"}, ` +
      `auth ${anonymousAccess ? "anonymous access ENABLED" : "required"})`
  );
}

(httpMode ? startHttp() : startStdio()).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
