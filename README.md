# AgentPhone MCP Server

Give AI agents real phone numbers, SMS, and voice calls via the [Model Context Protocol](https://modelcontextprotocol.io).

**AgentPhone** lets your AI agent buy phone numbers, send/receive SMS, and place voice calls — all through natural language in Cursor, Claude Desktop, or any MCP-compatible client.

**Agents** are the core concept — each agent gets its own phone numbers, voice personality, system prompt, and webhook. Think of an agent as a virtual team member with its own phone line. You can create agents for different purposes (support, sales, scheduling) and configure how they sound and behave on calls.

## Quick Start

### 1. Get your API key

Sign up at [agentphone.ai](https://agentphone.ai) and create an API key from **Settings**.

### 2. Connect via MCP

**Option A: Remote server (recommended)**

Point your MCP client at the hosted endpoint — no install needed:

```json
{
  "mcpServers": {
    "agentphone": {
      "type": "streamable-http",
      "url": "https://mcp.agentphone.ai/mcp",
      "headers": {
        "Authorization": "Bearer your_api_key_here"
      }
    }
  }
}
```

Works with any MCP client that supports Streamable HTTP transport (Switchboard, remote agent platforms, etc.).

**Option B: Local server (stdio)**

Runs locally via `npx` — works with Cursor, Claude Desktop, Windsurf, and Claude Code:

**Cursor:** Settings > MCP or `~/.cursor/mcp.json`
**Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "agentphone": {
      "command": "npx",
      "args": ["-y", "agentphone-mcp"],
      "env": {
        "AGENTPHONE_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

**Option C: Self-hosted HTTP server**

Run your own HTTP MCP endpoint:

```bash
AGENTPHONE_API_KEY=your_api_key npx agentphone-mcp --http --port 3000
```

Then connect to `http://localhost:3000/mcp`.

## What Can It Do?

Once configured, just ask your AI agent things like:

- *"Buy me a phone number in the 415 area code"*
- *"Create a support agent that greets callers and helps with billing"*
- *"Call +14155551234 and have a conversation about scheduling a dentist appointment"*
- *"Text +14155551234 saying 'Your appointment is confirmed for 3pm tomorrow'"*
- *"Show me my recent calls and transcripts"*
- *"List the available voices and switch my agent to a different one"*
- *"Set up a webhook so I get notified when someone calls or texts my number"*
- *"Show me this month's usage breakdown"*

## Transports

| Transport | Command | Use case |
|-----------|---------|----------|
| **Streamable HTTP** (remote) | `https://mcp.agentphone.ai/mcp` | Agent platforms (Switchboard, etc.), remote clients |
| **Streamable HTTP** (self-hosted) | `npx agentphone-mcp --http --port 3000` | Your own infrastructure |
| **stdio** (default) | `npx agentphone-mcp` | Cursor, Claude Desktop, Windsurf, Claude Code |

### Authentication

- **stdio:** API key via `AGENTPHONE_API_KEY` environment variable
- **HTTP (self-hosted):** API key via env var or `Authorization: Bearer <key>` header per request
- **HTTP (hosted):** API key via `Authorization: Bearer <key>` header per request

### Endpoints (HTTP mode)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/mcp` | MCP Streamable HTTP endpoint (stateless — each request is independent) |
| `GET` | `/health` | Health check |

## Highlights

- **Phone numbers** — buy and manage numbers in any US/CA area code
- **SMS** — send and receive text messages, view conversation threads
- **Voice calls** — place outbound calls with built-in AI conversation (no webhook needed) or bring your own webhook
- **Inbound handling** — set up webhooks to receive and respond to inbound calls and texts in real time
- **Agents** — create agents with custom voices, system prompts, call transfer, and voicemail
- **Usage & billing** — monitor your plan limits, message/call volume, and daily/monthly breakdowns

## All Tools (26)

### Account

| Tool | Description |
|------|-------------|
| `account_overview` | Get a full snapshot of your account — agents, numbers, webhook, and usage |
| `get_usage` | Get usage stats, plan limits, and quotas. Use `breakdown` for daily or monthly time-series. |

### Phone Numbers

| Tool | Description |
|------|-------------|
| `list_numbers` | List all phone numbers in your account |
| `buy_number` | Purchase a new phone number with optional `area_code` and `agent_id` |

### SMS

| Tool | Description |
|------|-------------|
| `send_message` | Send SMS or iMessage. Supports media, threaded replies (`reply_to_message_id`), iMessage send effects (`send_style`), and group chats |
| `get_messages` | Get messages for a specific number |
| `list_conversations` | List SMS conversations. Pass `agent_id` to filter by agent. |
| `get_conversation` | Get a conversation with full message history |
| `update_conversation` | Set metadata on a conversation |

### Voice Calls

| Tool | Description |
|------|-------------|
| `list_calls` | List calls. Filter by `agent_id`, `number_id`, status, direction, or keyword. |
| `get_call` | Get call details and transcript |
| `make_call` | Place an outbound call (webhook-driven) |
| `make_conversation_call` | Place a call with built-in AI conversation — no webhook needed |

### Agents

| Tool | Description |
|------|-------------|
| `list_agents` | List all agents with their numbers and voice config |
| `create_agent` | Create an agent with voice, system prompt, call transfer, voicemail, and voice tuning (speed, interruption sensitivity, backchannel, language, and more) |
| `update_agent` | Update an agent's configuration |
| `delete_agent` | Delete an agent (numbers are kept but unassigned) |
| `get_agent` | Get agent details including phone numbers and voice config |
| `attach_number` | Assign a phone number to an agent |
| `detach_number` | Remove a phone number from an agent |
| `list_voices` | List available voices for agents |

### Webhooks

All webhook tools accept an optional `agent_id` — pass it to manage an agent-specific webhook, omit it for the project-level default. Agent webhooks take priority over project-level.

| Tool | Description |
|------|-------------|
| `get_webhook` | Get webhook configuration |
| `set_webhook` | Set a webhook URL for inbound messages and call events |
| `delete_webhook` | Remove a webhook |
| `test_webhook` | Send a test event to verify your webhook works |
| `list_webhook_deliveries` | View delivery history for debugging |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTPHONE_API_KEY` | stdio: yes, HTTP: no | Your AgentPhone API key (HTTP mode can use Authorization header instead) |
| `AGENTPHONE_BASE_URL` | No | Override the API base URL (defaults to `https://api.agentphone.ai`) |
| `PORT` | No | Port for HTTP mode (defaults to `3000`, overridden by `--port`) |

## Development

```bash
git clone https://github.com/AgentPhone-AI/agentphone-mcp.git
cd agentphone-mcp
npm install
npm run dev     # Run with tsx (hot reload)
npm run build   # Compile TypeScript
npm start       # Run compiled JS (stdio)
```

## How It Works

This MCP server connects your AI assistant to the [AgentPhone API](https://agentphone.ai). Your assistant talks to the MCP server, which calls the AgentPhone API, which talks to the phone network.

```
Your AI Assistant  <-->  agentphone-mcp  <-->  AgentPhone API  <-->  Phone Network
```

**Outbound**: your assistant places calls and sends texts through AgentPhone's API.

**Inbound**: when someone calls or texts your number, AgentPhone sends a webhook event to your server — you can then respond programmatically or let your agent's built-in AI handle it.

## License

MIT
