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
// Genuine reads (get_messages, list_conversations, get_conversation, get_usage)
// are marked readOnlyHint:true with destructive/openWorld false — their true
// semantics. The checker's name-based heuristic can misread "messages"/
// "conversation" as sending a communication; the accurate answer is that these
// only fetch. The real writes below carry destructive/openWorld hints.
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
  create_agent: { title: "Create Agent", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  update_agent: { title: "Update Agent", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  delete_agent: { title: "Delete Agent", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  get_agent: { title: "Get Agent", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  attach_number: { title: "Attach Number to Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  detach_number: { title: "Detach Number from Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  list_voices: { title: "List Voices", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_conversations: { title: "List Conversations", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_conversation: { title: "Get Conversation", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  update_conversation: { title: "Update Conversation", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_contacts: { title: "List Contacts", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  manage_contact: { title: "Manage Contact", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  get_usage: { title: "Get Usage", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_webhook: { title: "Get Webhook", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  set_webhook: { title: "Set Webhook", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
        issues
          .map((i) => `${(i.path ?? []).join(".") || "input"}: ${i.message ?? "invalid value"}`)
          .join("; ") || "one or more arguments are invalid";
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
  const tokenStore = new AsyncLocalStorage<string>();
  const api = new AgentPhoneAPI(
    BASE_URL,
    () => tokenStore.getStore() || process.env.AGENTPHONE_API_KEY || ""
  );

  const clientId = process.env.MCP_OAUTH_CLIENT_ID;
  const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    console.error(
      "Both MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET must be set to enable OAuth; " +
        "partial config ignored, OAuth disabled."
    );
  }
  const oauthEnabled = Boolean(clientId && clientSecret);
  const hasServerApiKey = Boolean(process.env.AGENTPHONE_API_KEY);

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
        required: oauthEnabled || !hasServerApiKey,
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
          const token: string =
            ctx?.auth?.accessToken || bearerFromHeader() || process.env.AGENTPHONE_API_KEY || "";
          return tokenStore.run(token, () => handler(params as any)) as any;
        }
      );
    },
  };

  registerTools(registrar, api);
  await server.listen(PORT);
  console.error(`AgentPhone MCP server listening on port ${PORT} (oauth ${oauthEnabled ? "on" : "off"})`);
}

(httpMode ? startHttp() : startStdio()).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
