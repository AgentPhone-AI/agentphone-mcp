#!/usr/bin/env node

/**
 * AgentPhone MCP Server
 *
 * Gives AI agents access to phone numbers, SMS, and voice calls
 * via the Model Context Protocol.
 *
 * Transports:
 *   stdio (default):  npx agentphone-mcp
 *   HTTP:             npx agentphone-mcp --http [--port 3000]
 *
 * In HTTP mode the API key can come from:
 *   1. The Authorization header on each request (multi-tenant / hosted)
 *   2. The AGENTPHONE_API_KEY env var (single-tenant / self-hosted)
 *
 * Tools (26):
 *   Overview:  account_overview
 *   Numbers:   list_numbers, buy_number
 *   SMS:       send_message, get_messages
 *   Calls:     list_calls, get_call, make_call, make_conversation_call
 *   Agents:    list_agents, create_agent, update_agent, delete_agent, get_agent, attach_number, detach_number, list_voices
 *   Convos:    list_conversations, get_conversation, update_conversation
 *   Usage:     get_usage
 *   Webhooks:  get_webhook, set_webhook, delete_webhook, test_webhook, list_webhook_deliveries
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AgentPhoneAPI } from "./api.js";
import { registerTools } from "./tools.js";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const httpMode = args.includes("--http");
const portIndex = args.indexOf("--port");
const port = portIndex !== -1 ? parseInt(args[portIndex + 1], 10) : parseInt(process.env.PORT || "3000", 10);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.AGENTPHONE_API_KEY;
const BASE_URL =
  process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.to";

// In stdio mode, API key is always required from env var.
// In HTTP mode, it can come from the Authorization header per-request.
if (!httpMode && !API_KEY) {
  console.error("AGENTPHONE_API_KEY environment variable is required");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMcpServer(api: AgentPhoneAPI): McpServer {
  const server = new McpServer({
    name: "agentphone",
    version: "0.5.0",
  });
  registerTools(server, api);
  return server;
}

/**
 * Extract a Bearer token from the Authorization header.
 * Returns the token string or null if missing/malformed.
 */
function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers["authorization"];
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}

/**
 * Resolve the API key for a request.
 * Priority: Authorization header > query param > AGENTPHONE_API_KEY env var.
 */
function resolveApiKey(req: IncomingMessage): string | null {
  // 1. Authorization: Bearer <key>
  const bearer = extractBearerToken(req);
  if (bearer) return bearer;

  // 2. Query parameter (used by Smithery gateway and similar proxies)
  const url = new URL(req.url || "/", "http://localhost");
  const queryKey =
    url.searchParams.get("AGENTPHONE_API_KEY") ||
    url.searchParams.get("AgentPhone_API_Key");
  if (queryKey) return queryKey;

  // 3. Environment variable
  return API_KEY || null;
}

// ---------------------------------------------------------------------------
// Stdio transport (default)
// ---------------------------------------------------------------------------

async function startStdio(): Promise<void> {
  const api = new AgentPhoneAPI(BASE_URL, API_KEY!);
  const server = createMcpServer(api);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// MCP Server Card — static metadata for directory services (Smithery, etc.)
// ---------------------------------------------------------------------------

const serverCard = {
  serverInfo: {
    name: "agentphone",
    version: "0.5.0",
  },
  authentication: {
    required: true,
    schemes: ["bearer"],
  },
  tools: [
    { name: "account_overview", description: "Full snapshot of account: agents, numbers, webhook status, usage limits" },
    { name: "get_usage", description: "Detailed usage stats with optional daily or monthly breakdown" },
    { name: "list_numbers", description: "List all phone numbers in account" },
    { name: "buy_number", description: "Purchase a new phone number with optional country and area code" },
    { name: "send_message", description: "Send an SMS or iMessage from an agent's phone number" },
    { name: "get_messages", description: "Get SMS messages for a specific phone number" },
    { name: "list_conversations", description: "List SMS conversation threads, optionally filtered by agent" },
    { name: "get_conversation", description: "Get a specific conversation with full message history" },
    { name: "update_conversation", description: "Set or clear metadata on a conversation" },
    { name: "list_calls", description: "List recent calls with optional agent, number, status, or direction filters" },
    { name: "get_call", description: "Get call details and transcript with optional long-polling" },
    { name: "make_call", description: "Place an outbound call with optional voice override, using webhook for conversation handling" },
    { name: "make_conversation_call", description: "Place an autonomous AI call that returns the full transcript" },
    { name: "list_agents", description: "List all agents with phone numbers and voice config" },
    { name: "create_agent", description: "Create a new agent with voice, system prompt, model tier, call transfer, and voicemail" },
    { name: "update_agent", description: "Update agent configuration including voice, model tier, transfer, and voicemail" },
    { name: "delete_agent", description: "Delete an agent" },
    { name: "get_agent", description: "Get agent details including numbers and voice config" },
    { name: "attach_number", description: "Assign a phone number to an agent" },
    { name: "detach_number", description: "Detach a phone number from an agent" },
    { name: "list_voices", description: "List available voice options" },
    { name: "get_webhook", description: "Get webhook configuration (project-level or per-agent)" },
    { name: "set_webhook", description: "Set webhook URL for inbound messages and call events" },
    { name: "delete_webhook", description: "Remove a webhook" },
    { name: "test_webhook", description: "Send a test event to verify a webhook is working" },
    { name: "list_webhook_deliveries", description: "View recent webhook delivery history" },
  ],
  resources: [],
  prompts: [],
};

// ---------------------------------------------------------------------------
// HTTP transport (--http)
//
// Stateless mode: each POST creates a fresh McpServer + transport so the
// server works on platforms that don't guarantee sticky routing (Railway,
// serverless, etc.). AgentPhone's MCP server is a stateless proxy to the
// REST API, so no session persistence is needed.
// ---------------------------------------------------------------------------

async function startHttp(): Promise<void> {
  console.error(`Starting AgentPhone MCP server in HTTP mode on port ${port}...`);

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      // Health check
      if (url.pathname === "/health" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // MCP Server Card (no auth required) — lets Smithery and other
      // directories discover tools without scanning the authenticated endpoint.
      if (url.pathname === "/.well-known/mcp/server-card.json" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(JSON.stringify(serverCard));
        return;
      }

      // Only /mcp is handled
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not Found" }));
        return;
      }

      if (req.method === "POST") {
        const apiKey = resolveApiKey(req);
        if (!apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message:
                  "Authentication required. Pass your AgentPhone API key via Authorization: Bearer <key>",
              },
              id: null,
            })
          );
          return;
        }

        const api = new AgentPhoneAPI(BASE_URL, apiKey);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });

        const server = createMcpServer(api);
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } else if (req.method === "GET") {
        // SSE streaming is not supported in stateless mode
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "SSE streaming not supported in stateless mode. Use POST requests." },
            id: null,
          })
        );
      } else if (req.method === "DELETE") {
        // No sessions to close in stateless mode
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", result: {}, id: null }));
      } else {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
          })
        );
      }
    }
  );

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Error: port ${port} is already in use`);
    } else if (err.code === "EACCES") {
      console.error(`Error: permission denied for port ${port} (try a port >= 1024)`);
    } else {
      console.error(`Server error: ${err.message}`);
    }
    process.exit(1);
  });

  httpServer.listen(port, () => {
    console.error(`AgentPhone MCP server (Streamable HTTP) listening on port ${port}`);
    console.error(`Endpoint: http://localhost:${port}/mcp`);
    console.error(`Health:   http://localhost:${port}/health`);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(httpMode ? startHttp() : startStdio()).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
