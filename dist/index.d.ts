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
export {};
//# sourceMappingURL=index.d.ts.map