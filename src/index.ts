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
 * Tools:
 *   Overview: account_overview
 *   Numbers:  list_numbers, buy_number, release_number
 *   SMS:      get_messages
 *   Calls:    list_calls, list_calls_for_number, get_call, make_call, make_conversation_call
 *   Agents:   list_agents, create_agent, update_agent, delete_agent, get_agent, attach_number, list_voices
 *   Convos:   list_conversations, get_conversation
 *   Usage:    get_usage
 *   Webhooks: get_webhook, set_webhook, delete_webhook, get_agent_webhook, set_agent_webhook, delete_agent_webhook
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
    version: "0.2.0",
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
 * Priority: Authorization header > AGENTPHONE_API_KEY env var.
 */
function resolveApiKey(req: IncomingMessage): string | null {
  return extractBearerToken(req) || API_KEY || null;
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
