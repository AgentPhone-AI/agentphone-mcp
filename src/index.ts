#!/usr/bin/env node

/**
 * AgentPhone MCP Server
 *
 * Gives AI agents phone numbers, SMS, and voice calls via the Model Context
 * Protocol. Built on the mcp-use server framework, which owns the HTTP
 * transport: Streamable HTTP, the SSE stream, session management, OAuth
 * discovery (.well-known/*), and token verification. We just register tools
 * and point the OAuth proxy at the AgentPhone authorization server.
 *
 * Auth:
 *   - OAuth (hosted): clients sign in at agentphone.ai; mcp-use proxies the
 *     authorization-code+PKCE flow to our AS and verifies the resulting token.
 *     The per-request access token is forwarded to the AgentPhone REST API.
 *   - API key (fallback): AGENTPHONE_API_KEY is used when no OAuth token is
 *     present (single-tenant / local).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { MCPServer, oauthProxy } from "mcp-use/server";
import { z } from "zod";
import { AgentPhoneAPI } from "./api.js";
import { registerTools, type ToolRegistrar } from "./tools.js";

const BASE_URL = (process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.ai").replace(/\/$/, "");
const PORT = parseInt(process.env.PORT || "3000", 10);

// ---------------------------------------------------------------------------
// Per-request credential
//
// The mcp-use framework calls each tool with ctx.auth (the verified user +
// raw access token). We stash that token in AsyncLocalStorage so the shared
// AgentPhoneAPI instance forwards the right credential per request without
// threading it through all 29 tool handlers.
// ---------------------------------------------------------------------------

const tokenStore = new AsyncLocalStorage<string>();

const api = new AgentPhoneAPI(
  BASE_URL,
  () => tokenStore.getStore() || process.env.AGENTPHONE_API_KEY || ""
);

// ---------------------------------------------------------------------------
// Token verification (used by oauthProxy)
//
// Our AS signs HS256 session JWTs (not JWKS), so instead of jwksVerifier we
// validate the bearer against the backend's /auth/me. No secret sharing.
// ---------------------------------------------------------------------------

async function verifyToken(token: string): Promise<{ payload: Record<string, unknown> }> {
  const res = await fetch(`${BASE_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Token verification failed (${res.status})`);
  const data: any = await res.json().catch(() => ({}));
  const user = data.user ?? data;
  return {
    payload: {
      sub: String(user?.id ?? user?.user_id ?? "unknown"),
      email: user?.email,
      name: user?.name,
      ...data,
    },
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const oauthEnabled = !!process.env.MCP_OAUTH_CLIENT_ID;

const server = new MCPServer({
  name: "agentphone",
  version: "0.7.0",
  ...(oauthEnabled
    ? {
        oauth: oauthProxy({
          authEndpoint:
            process.env.AGENTPHONE_OAUTH_AUTHORIZE || "https://agentphone.ai/oauth/authorize",
          tokenEndpoint: `${BASE_URL}/oauth/token`,
          issuer: process.env.AGENTPHONE_OAUTH_ISSUER || BASE_URL,
          clientId: process.env.MCP_OAUTH_CLIENT_ID!,
          clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
          scopes: ["mcp"],
          verifyToken,
        }),
      }
    : {}),
});

// Adapter: translate tools.ts's SDK-style registration into mcp-use's
// server.tool(definition, callback) and bind the per-request token. Handles
// both the 4-arg (no annotations) and 5-arg overloads.
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
        const token: string =
          ctx?.auth?.accessToken || process.env.AGENTPHONE_API_KEY || "";
        return tokenStore.run(token, () => handler(params as any)) as any;
      }
    );
  },
};

registerTools(registrar, api);

server.listen(PORT).then(
  () => {
    console.error(
      `AgentPhone MCP server listening on port ${PORT} (oauth ${oauthEnabled ? "on" : "off"})`
    );
  },
  (err) => {
    console.error("Fatal error starting server:", err);
    process.exit(1);
  }
);
