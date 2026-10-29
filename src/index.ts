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
import { createRequire } from "node:module";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { installConciseValidation } from "./validation.js";
import { z } from "zod";
import { AgentPhoneAPI } from "./api.js";
import { registerTools, type ToolRegistrar } from "./tools.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";

const NAME = "agentphone";
// Single source of truth for the version: read it from package.json so the
// handshake, server card, and manifest can never drift from the published
// package (dist/index.js sits one level below package.json).
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};
const BASE_URL = (process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.ai").replace(/\/$/, "");

// Input-size limits (tasks#193). maxToolInputElements bounds how many array/object
// elements one tool call may carry (enforced by the SDK before validation);
// MAX_REQUEST_BODY_BYTES caps an HTTP request body before it is parsed. Both sit
// far above any legitimate call (e.g. 128 recipients) but well below a payload
// that could exhaust memory.
const MAX_TOOL_INPUT_ELEMENTS = 10_000;
const MAX_REQUEST_BODY_BYTES = 1_000_000;

// Server handshake metadata surfaced in the MCP initialize/discovery response
// (serverInfo title/websiteUrl/icons, plus server-wide instructions). mcp-use
// (HTTP) and the SDK McpServer (stdio) both read these fields.
const TITLE = "AgentPhone";
const DESCRIPTION =
  "Give AI agents real phone numbers, SMS, and voice calls. Buy US/Canada numbers, " +
  "send and receive texts (SMS and iMessage), and place automated voice calls where a " +
  "built-in AI holds the conversation and returns a transcript — all through AgentPhone.";
const WEBSITE_URL = "https://docs.agentphone.ai/mcp";
const ICONS = [
  { src: "https://agentphone.ai/logo.png", mimeType: "image/png", sizes: ["943x960"] },
];
// Server-wide guidance for agents: cross-tool workflow, where IDs come from, and
// which actions cost money or can't be undone. Kept distinct from the per-tool
// descriptions so it adds orientation rather than repeating them.
const INSTRUCTIONS = [
  "AgentPhone gives you phone numbers and lets you text and call through them.",
  "",
  "Start with account_overview to see existing agents, numbers, webhook, and usage. The agent " +
    "IDs and number IDs it returns are the values the other tools expect.",
  "",
  "Setup: create_agent makes an agent (the entity that owns numbers and handles calls and texts). " +
    "buy_number provisions a number — a paid purchase that spends account balance and requires " +
    "confirm=true. attach_number links a number to an agent. list_voices gives the voice IDs you " +
    "can set on an agent.",
  "",
  "Messaging: send_message sends an SMS or iMessage from one of your numbers. get_messages, " +
    "list_conversations, and get_conversation read history.",
  "",
  "Calling: make_conversation_call is the simplest way to place an automated call — the built-in " +
    "AI pursues a topic you give it and returns the transcript, with no webhook needed. make_call " +
    "is for webhook-driven flows you control. The connector prepends an AI disclosure to the " +
    "greeting of calls its call tools place, and no tool argument disables it; calls placed " +
    "directly through the AgentPhone API or SDKs bypass it.",
  "",
  "Billing and irreversible actions: buy_number, calls, and messages are billed per use. " +
    "delete_agent and manage_contact with action=delete cannot be undone. Deleting a webhook is " +
    "reversible — set_webhook restores it.",
  "",
  "Use IDs returned by account_overview, create_agent, buy_number, or the relevant list_* tools " +
    "before calling anything that takes an agent_id, number_id, conversation_id, or call_id.",
].join("\n");

// Hosted platforms (Manufact, etc.) set PORT. Local MCP clients launch the bare
// command with a clean env and expect stdio. `--http` / `--stdio` force a mode.
const args = process.argv.slice(2);
const httpMode = args.includes("--http") || (!args.includes("--stdio") && !!process.env.PORT);
const portIndex = args.findIndex((arg) => arg === "--port" || arg.startsWith("--port="));
const portValue = portIndex === -1
  ? process.env.PORT || "3000"
  : args[portIndex].startsWith("--port=")
    ? args[portIndex].slice("--port=".length)
    : args[portIndex + 1];
const PORT = Number(portValue);
if (httpMode && (!portValue || !/^\d+$/.test(portValue) || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535)) {
  console.error("Invalid port: expected an integer between 1 and 65535 (--port or PORT).");
  process.exit(1);
}


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
//   destructiveHint = true for irreversible effects AND for overwriting updates
//                     that can replace or clear existing values (per OpenAI
//                     guidance, overwrite counts; reversibility alone is not
//                     enough). So: sends/transactions that can't be undone
//                     (buy_number, send_message, calls); deletes (delete_agent,
//                     delete_webhook, manage_contact, which can delete);
//                     update_conversation (metadata:null clears data);
//                     update_agent (overwrites config, can clear transfer/
//                     voicemail); and set_webhook (replaces the configured
//                     webhook). attach/detach_number stay false: they only add
//                     or remove an assignment and are each other's inverse.
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
  end_call: { title: "End Call", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  make_call: { title: "Make Call", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  make_conversation_call: { title: "Make AI Conversation Call", readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  list_agents: { title: "List Agents", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  create_agent: { title: "Create Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  update_agent: { title: "Update Agent", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  delete_agent: { title: "Delete Agent", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  get_agent: { title: "Get Agent", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  attach_number: { title: "Attach Number to Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  detach_number: { title: "Detach Number from Agent", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  list_voices: { title: "List Voices", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  check_capabilities: { title: "Check Messaging Capabilities", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  check_readiness: { title: "Check Send/Call Readiness", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  list_conversations: { title: "List Conversations", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_conversation: { title: "Get Conversation", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_conversation_messages: { title: "Get Conversation Messages", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  update_conversation: { title: "Update Conversation", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  list_contacts: { title: "List Contacts", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  manage_contact: { title: "Manage Contact", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  get_usage: { title: "Get Usage", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  get_webhook: { title: "Get Webhook", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  set_webhook: { title: "Set Webhook", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  delete_webhook: { title: "Delete Webhook", readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  test_webhook: { title: "Test Webhook", readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  list_webhook_deliveries: { title: "List Webhook Deliveries", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

// One authoritative annotation set per tool, identical on HTTP and stdio: the
// title and all three compatibility-checked hints come from TOOL_META, with any
// extra inline hints (e.g. idempotentHint) preserved. Keeping both transports on
// this helper prevents the title/hint drift that platform checks flag.
function resolveToolMeta(
  name: string,
  passed: Record<string, unknown>
): { title: string | undefined; annotations: Record<string, unknown> } {
  const meta = TOOL_META[name];
  const { title: passedTitle, ...passedHints } = passed;
  const annotations = meta
    ? {
        ...passedHints,
        readOnlyHint: meta.readOnlyHint,
        destructiveHint: meta.destructiveHint,
        openWorldHint: meta.openWorldHint,
      }
    : passedHints;
  return { title: meta?.title ?? (passedTitle as string | undefined), annotations };
}

// ---------------------------------------------------------------------------
// stdio transport (default for local clients)
// ---------------------------------------------------------------------------



async function startStdio(): Promise<void> {
  const apiKey = process.env.AGENTPHONE_API_KEY?.trim();
  if (!apiKey) {
    console.error("AGENTPHONE_API_KEY environment variable is required for stdio mode");
    process.exit(1);
  }
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const api = new AgentPhoneAPI(BASE_URL, apiKey);
  const server = new McpServer(
    { name: NAME, title: TITLE, version: VERSION, description: DESCRIPTION, websiteUrl: WEBSITE_URL, icons: ICONS },
    // Cap the total number of elements across a tool call's input arrays/objects.
    // The SDK enforces this BEFORE schema validation, which bounds the memory a
    // single malformed request can force the validator to allocate (the input
    // side of GHSA-mrhx-c7xc-m3w5). No legitimate call comes near the limit.
    { instructions: INSTRUCTIONS, maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS }
  );
  installConciseValidation(server);
  // Adapter: register each tool via registerTool so it can carry a title and an
  // outputSchema (the legacy .tool() overloads can't). Keeps tools.ts's
  // (name, description, schema, annotations, handler) call shape unchanged.
  const stdioRegistrar: ToolRegistrar = {
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
      const passed = (
        typeof annotationsOrHandler === "function" ? {} : annotationsOrHandler
      ) as Record<string, unknown>;
      // Same authoritative title + hints as the HTTP path (see resolveToolMeta).
      const { title, annotations } = resolveToolMeta(name, passed);
      const config: Record<string, unknown> = {
        description,
        inputSchema: schema ?? {},
        annotations,
      };
      if (title) config.title = title;
      if (OUTPUT_SCHEMAS[name]) config.outputSchema = OUTPUT_SCHEMAS[name];
      (server as any).registerTool(name, config, handler);
    },
  };
  registerTools(stdioRegistrar, api);
  await server.connect(new StdioServerTransport());
}

// ---------------------------------------------------------------------------
// HTTP transport (hosted) — mcp-use framework
// ---------------------------------------------------------------------------

async function verifyTokenAgainstBackend(
  token: string
): Promise<{ payload: Record<string, unknown> }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000); // 12 s

  try {
    const res = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Token verification failed (${res.status})`);
    const data: any = await res.json().catch((err) => {
      if (err?.name === "AbortError") throw err;
      return {};
    });
    const user = data.user ?? data;
    return {
      payload: {
        ...data,
        sub: String(user?.id ?? user?.user_id ?? "unknown"),
        email: user?.email,
        name: user?.name,
      },
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error("Token verification timed out", { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timeout)
  }
}


async function startHttp(): Promise<void> {
  const { MCPServer, oauthProxy, getRequestContext } = await import("mcp-use/server");

  // Preserve header presence: malformed credentials must never be treated as
  // an anonymous request and replaced with the server's credential. null means
  // the request context is unavailable; only undefined means a missing header.
  const authorizationHeader = (): string | undefined | null => {
    try {
      const c: any = getRequestContext();
      if (typeof c?.req?.header !== "function") return null;
      return c.req.header("authorization");
    } catch {
      return null;
    }
  };

  // Only the tool-call boundary chooses credentials. The shared API client
  // must not independently fall back to the server's account.
  const tokenStore = new AsyncLocalStorage<string>();
  const api = new AgentPhoneAPI(BASE_URL, () => tokenStore.getStore() || "");

  const clientId = process.env.MCP_OAUTH_CLIENT_ID;
  // Secret is optional: when the gateway client is registered as a PUBLIC client
  // (token_endpoint_auth_method "none") the proxy authenticates to the backend
  // with PKCE alone. Leaving it set keeps the gateway confidential. Crucially,
  // when unset, mcp-use advertises token_endpoint_auth_method "none" to
  // downstream DCR clients — strict clients (e.g. Vercel Connect) reject the
  // "client_secret_post" that mcp-use otherwise advertises without issuing a
  // secret. OAuth only needs a client_id to be enabled.
  const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET;
  const oauthEnabled = Boolean(clientId);
  if (clientSecret && !clientId) {
    console.error(
      "MCP_OAUTH_CLIENT_SECRET is set but MCP_OAUTH_CLIENT_ID is missing; OAuth is disabled."
    );
  } else if (oauthEnabled && !clientSecret) {
    // Make the mode flip visible in otherwise-silent self-host deployments.
    console.error(
      'OAuth enabled in PUBLIC-client mode (no MCP_OAUTH_CLIENT_SECRET): advertising ' +
        'token_endpoint_auth_method "none". The gateway client must be registered at the ' +
        "AgentPhone AS with token_endpoint_auth_method=none."
    );
  }
  const serverApiKey = process.env.AGENTPHONE_API_KEY?.trim() || "";
  const hasServerApiKey = Boolean(serverApiKey);
  // Without OAuth, a request that carries no Bearer token used to fall back to
  // the server's own AGENTPHONE_API_KEY, so anyone who could reach the port got
  // the whole account (calls, SMS, number purchases, agent deletion). That is
  // now opt-in: set AGENTPHONE_ALLOW_ANONYMOUS=true to restore it for a
  // single-tenant deployment you have deliberately put behind your own auth.
  const anonymousRequested = process.env.AGENTPHONE_ALLOW_ANONYMOUS === "true";
  const allowAnonymous = !oauthEnabled && anonymousRequested;
  if (anonymousRequested && oauthEnabled) {
    console.error("AGENTPHONE_ALLOW_ANONYMOUS is ignored because OAuth is enabled; caller authentication is required.");
  } else if (allowAnonymous && !hasServerApiKey) {
    console.error("AGENTPHONE_ALLOW_ANONYMOUS requires a non-empty AGENTPHONE_API_KEY; caller authentication is required.");
  } else if (hasServerApiKey && !allowAnonymous) {
    console.error("AGENTPHONE_API_KEY is not used for HTTP callers; each request must provide its own bearer credential.");
  } else if (allowAnonymous && hasServerApiKey) {
    console.error(
      "AGENTPHONE_ALLOW_ANONYMOUS=true: requests with no Authorization header will use the " +
        "server's AGENTPHONE_API_KEY. Anyone who can reach this port can act as this account."
    );
  }

  const server = new MCPServer({
    name: NAME,
    version: VERSION,
    title: TITLE,
    description: DESCRIPTION,
    instructions: INSTRUCTIONS,
    websiteUrl: WEBSITE_URL,
    icons: ICONS,
    // Serve the HTML landing page (connection/setup instructions + tool list)
    // on a browser GET to /mcp without a bearer token, while MCP protocol
    // traffic (POST) stays authenticated. Makes setup publicly discoverable.
    publicLandingPage: true,
    ...(oauthEnabled
      ? {
          oauth: oauthProxy({
            authEndpoint:
              process.env.AGENTPHONE_OAUTH_AUTHORIZE || "https://agentphone.ai/oauth/authorize",
            tokenEndpoint: `${BASE_URL}/oauth/token`,
            issuer: process.env.AGENTPHONE_OAUTH_ISSUER || BASE_URL,
            clientId: clientId!,
            ...(clientSecret ? { clientSecret } : {}),
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

  // Reject an oversized request body before it is parsed, so a malformed payload
  // can't force the JSON parser / validator to allocate unbounded memory on the
  // HTTP transport (tasks#193). mcp-use's server exposes the underlying hono app.
  const { bodyLimit } = await import("hono/body-limit");
  server.app.use(
    "/mcp",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c: any) =>
        c.json({ error: `Request body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit.` }, 413),
    })
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
        title: TITLE,
        version: VERSION,
        websiteUrl: WEBSITE_URL,
        icons: ICONS,
      },
      description: DESCRIPTION,
      instructions: INSTRUCTIONS,
      documentationUrl: WEBSITE_URL,
      transport: {
        type: "streamable-http",
        endpoint: "/mcp",
      },
      capabilities: {
        tools: { listChanged: true },
      },
      authentication: {
        required: oauthEnabled || !(hasServerApiKey && allowAnonymous),
        schemes: oauthEnabled ? ["oauth2", "bearer"] : ["bearer"],
      },
      tools: ["dynamic"],
    });
  });

  // Public, unauthenticated install manifest (the MCP registry `server.json`
  // shape) so clients and catalogs can discover how to connect. Served at both
  // the well-known path and /mcp.json. The remote URL is derived from the
  // incoming request so a self-hosted instance advertises its own endpoint
  // rather than the hosted one.
  const buildManifest = (origin: string) => ({
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.AgentPhone-AI/agentphone",
    title: TITLE,
    // The registry server.json schema caps description at 100 chars, so use a
    // short one here rather than the longer handshake DESCRIPTION.
    description: "Give AI agents real phone numbers, messages, and voice calls via MCP.",
    version: VERSION,
    websiteUrl: WEBSITE_URL,
    repository: { url: "https://github.com/AgentPhone-AI/agentphone-mcp", source: "github" },
    remotes: [
      {
        type: "streamable-http",
        url: `${origin}/mcp`,
        headers: [
          {
            name: "Authorization",
            description:
              "Bearer token for AgentPhone API authentication (format: Bearer YOUR_API_KEY). " +
              "Get your key at https://agentphone.ai",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
    packages: [
      {
        registryType: "npm",
        identifier: "agentphone-mcp",
        version: VERSION,
        transport: { type: "stdio" },
        environmentVariables: [
          {
            name: "AGENTPHONE_API_KEY",
            description: "Your AgentPhone API key. Get one at https://agentphone.ai",
            isRequired: true,
            isSecret: true,
          },
        ],
      },
    ],
  });
  // Prefer an explicitly configured public URL so the advertised, secret-bearing
  // remote never depends on client-controlled headers. The hosted deployment
  // should set AGENTPHONE_MCP_PUBLIC_URL (e.g. https://mcp.agentphone.ai).
  const configuredPublicUrl = process.env.AGENTPHONE_MCP_PUBLIC_URL?.replace(/\/+$/, "");
  const serveManifest = (c: any) => {
    c.header("Cache-Control", "public, max-age=3600");
    c.header("Access-Control-Allow-Methods", "GET");
    c.header("Access-Control-Allow-Headers", "Content-Type");
    let origin = configuredPublicUrl;
    if (!origin) {
      // Self-hosted fallback: derive from the request, but only trust the first
      // forwarded hop, allowlist the scheme to http/https (defaulting to https
      // for a secret-bearing URL), and Vary so a forged Host can't poison a
      // shared cache into advertising an attacker's endpoint.
      c.header("Vary", "Host, X-Forwarded-Proto");
      const reqUrl = new URL(c.req.url);
      const firstHop = (c.req.header("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
      // Default to https when no trusted forwarded scheme is present: the remote
      // carries the API key, so never advertise an unencrypted endpoint from the
      // bare Node request URL (which reports http behind a TLS-terminating proxy).
      const proto = firstHop === "http" ? "http" : "https";
      const host = c.req.header("host") || reqUrl.host;
      origin = `${proto}://${host}`;
    }
    return c.json(buildManifest(origin));
  };
  server.app.get("/.well-known/mcp.json", serveManifest);
  server.app.get("/mcp.json", serveManifest);

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
      // + all three of readOnlyHint/destructiveHint/openWorldHint), identical to
      // the stdio path (see resolveToolMeta).
      const passed = (
        typeof annotationsOrHandler === "function" ? {} : annotationsOrHandler
      ) as Record<string, unknown>;
      const { title, annotations } = resolveToolMeta(name, passed);
      server.tool(
        {
          name,
          title,
          description,
          schema: z.object(schema ?? {}),
          annotations: annotations as Record<string, unknown>,
          ...(OUTPUT_SCHEMAS[name] ? { outputSchema: OUTPUT_SCHEMAS[name] } : {}),
        },
        async (params: unknown, ctx: any) => {
          const header = authorizationHeader();
          const bearer = header?.match(/^Bearer +([^\s]+)$/i)?.[1] || "";
          const token: string = oauthEnabled
            ? ctx?.auth?.accessToken || ""
            : bearer || (allowAnonymous && header === undefined ? serverApiKey : "");
          if (!token) {
            // Fail closed. Never let an unauthenticated caller borrow the
            // server's credential by accident.
            return {
              content: [
                {
                  type: "text",
                  text: "Unauthorized: send `Authorization: Bearer <AgentPhone API key>` with each request.",
                },
              ],
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
  console.error(`AgentPhone MCP server listening on port ${PORT} (oauth ${oauthEnabled ? "on" : "off"})`);
}

(httpMode ? startHttp() : startStdio()).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
