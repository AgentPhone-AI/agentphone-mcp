# AgentPhone MCP Server

Give AI agents real phone numbers, SMS, and voice calls via the [Model Context Protocol](https://modelcontextprotocol.io).

**AgentPhone** lets your AI agent buy phone numbers, send/receive SMS, and place voice calls — all through natural language in Cursor, Claude Desktop, or any MCP-compatible client.

## Quick Start

### 1. Get your API key

Sign up at [agentphone.to](https://agentphone.to) and create an API key from **Settings**.

### 2. Add to Cursor or Claude Desktop

Both use the same config. Add this under `mcpServers`:

**Cursor:** **Settings > MCP** or `~/.cursor/mcp.json`  
**Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "agentphone": {
      "command": "npx",
      "args": ["-y", "agentphone-mcp"],
      "env": {
        "AGENTPHONE_API_KEY": "your_api_key_here",
        "AGENTPHONE_BASE_URL": "https://api.agentphone.to"
      }
    }
  }
}
```

You can also run the built server with `node` and a path to `dist/index.js` (e.g. after cloning and building this repo).

## What Can It Do?

Once configured, just ask your AI agent things like:

- *"Show me an overview of my account"*
- *"Buy me a phone number in the 415 area code"*
- *"Create a support agent with a hosted AI voice that greets callers and helps with billing"*
- *"Call +14155551234 and have a conversation about scheduling a dentist appointment"*
- *"Show me my recent calls and transcripts"*
- *"List the available voices and switch my agent to a different one"*
- *"Set up a webhook to receive inbound messages"*
- *"How many numbers can I still provision?"*

## Available Tools (26)

### Account

| Tool | Description |
|------|-------------|
| `account_overview` | Get a full snapshot of your account — agents, numbers, webhook, and usage. Call this first to orient yourself. |
| `get_usage` | Get detailed usage stats: plan limits, number quotas, message/call volume, webhook delivery stats. |

### Phone Numbers

| Tool | Description |
|------|-------------|
| `list_numbers` | List all phone numbers in your account |
| `buy_number` | Purchase a new phone number. Supports `area_code` (e.g. `415`) and optional `agent_id` to attach immediately. |
| `release_number` | Release a phone number (irreversible) |

### SMS

| Tool | Description |
|------|-------------|
| `get_messages` | Get SMS messages for a specific number |
| `list_conversations` | List SMS conversation threads across all numbers |
| `get_conversation` | Get a conversation with full message history |

### Voice Calls

| Tool | Description |
|------|-------------|
| `list_calls` | List recent calls across all numbers |
| `list_calls_for_number` | List calls for a specific phone number |
| `get_call` | Get call details and transcript |
| `make_call` | Place an outbound call (uses your webhook for conversation) |
| `make_conversation_call` | Place a call with built-in AI — no webhook needed, just provide a topic |

### Agents

| Tool | Description |
|------|-------------|
| `list_agents` | List all agents with their numbers and voice config |
| `create_agent` | Create a new agent with optional voice mode, system prompt, and voice selection |
| `update_agent` | Update an agent's name, voice mode, system prompt, greeting, or voice |
| `delete_agent` | Delete an agent (numbers are kept but unassigned) |
| `get_agent` | Get agent details including phone numbers and voice configuration |
| `attach_number` | Assign a phone number to an agent |
| `list_voices` | List available voices for agents |

### Webhooks (project-level)

| Tool | Description |
|------|-------------|
| `get_webhook` | Get the project-level webhook configuration |
| `set_webhook` | Set a webhook URL for inbound messages and call events |
| `delete_webhook` | Remove the project-level webhook |

### Webhooks (per-agent)

| Tool | Description |
|------|-------------|
| `get_agent_webhook` | Get the webhook for a specific agent |
| `set_agent_webhook` | Set a webhook URL for a specific agent (overrides project default) |
| `delete_agent_webhook` | Remove an agent's webhook (falls back to project default) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTPHONE_API_KEY` | Yes | Your AgentPhone API key |
| `AGENTPHONE_BASE_URL` | No | Override the API base URL (defaults to `https://api.agentphone.to`) |

## Development

```bash
git clone https://github.com/AgentPhone-AI/agentphone-mcp.git
cd agentphone-mcp
npm install
npm run dev     # Run with tsx (hot reload)
npm run build   # Compile TypeScript
npm start       # Run compiled JS
```

## How It Works

This is an MCP (Model Context Protocol) server that connects your AI assistant to the [AgentPhone API](https://agentphone.to). It runs as a local process that your AI client (Cursor, Claude Desktop, etc.) communicates with over stdio.

```
Your AI Assistant  <-->  agentphone-mcp (local)  <-->  AgentPhone API  <-->  Phone Network
```

The MCP server itself is stateless — it's a thin typed client that translates MCP tool calls into AgentPhone API requests. All state (numbers, calls, messages) lives on the AgentPhone platform.

## License

MIT
