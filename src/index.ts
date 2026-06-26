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

// ---------------------------------------------------------------------------
// stdio transport (default for local clients)
// ---------------------------------------------------------------------------

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
  const { MCPServer, oauthProxy } = await import("mcp-use/server");

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
      const annotations =
        typeof annotationsOrHandler === "function" ? {} : annotationsOrHandler;
      server.tool(
        {
          name,
          description,
          schema: z.object(schema ?? {}),
          annotations: annotations as Record<string, unknown>,
        },
        async (params: unknown, ctx: any) => {
          const token: string = ctx?.auth?.accessToken || process.env.AGENTPHONE_API_KEY || "";
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
