# AgentPhone MCP Server

Give AI agents real phone numbers, SMS, and voice calls via the [Model Context Protocol](https://modelcontextprotocol.io).

**AgentPhone** lets your AI agent buy phone numbers, send/receive SMS, and place voice calls — all through natural language in Cursor, Claude Desktop, or any MCP-compatible client.

## Quick Start

### 1. Get your API key

Sign up at [agentphone.dev](https://agentphone.dev) and create an API key from **Settings**.

### 2. Add to Cursor

Open **Cursor Settings > MCP Servers > Add new server** and paste:

```json
{
  "agentphone": {
    "command": "npx",
    "args": ["-y", "agentphone-mcp"],
    "env": {
      "AGENTPHONE_API_KEY": "your_api_key_here"
    }
  }
}
```

### 3. Add to Claude Desktop

Open your config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add:

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

## What Can It Do?

Once configured, just ask your AI agent things like:

- *"Buy me a US phone number"*
- *"Show me my recent calls and transcripts"*
- *"Call +14155551234 and have a conversation about scheduling a dentist appointment"*
- *"Create an agent called Support Bot and give it a number"*
- *"Show me the latest SMS messages"*
- *"Set up a webhook to receive inbound messages"*

## Available Tools

### Phone Numbers

| Tool | Description |
|------|-------------|
| `list_numbers` | List all phone numbers in your account |
| `buy_number` | Purchase a new phone number |
| `release_number` | Release a phone number (irreversible) |

### SMS

| Tool | Description |
|------|-------------|
| `get_messages` | Get SMS messages for a number |
| `list_conversations` | List SMS conversations |
| `get_conversation` | Get a conversation with full message history |

### Voice Calls

| Tool | Description |
|------|-------------|
| `list_calls` | List recent calls (inbound and outbound) |
| `get_call` | Get call details and transcript |
| `make_call` | Place an outbound call (uses your webhook for responses) |
| `make_conversation_call` | Place a call with a built-in AI conversation on a topic you define |

### Agents

| Tool | Description |
|------|-------------|
| `list_agents` | List all agents |
| `create_agent` | Create a new agent |
| `get_agent` | Get agent details and attached numbers |
| `attach_number` | Assign a phone number to an agent |

### Webhooks

| Tool | Description |
|------|-------------|
| `get_webhook` | Get your current webhook configuration |
| `set_webhook` | Set a webhook URL for inbound events |
| `delete_webhook` | Remove the webhook |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENTPHONE_API_KEY` | Yes | Your AgentPhone API key |
| `AGENTPHONE_BASE_URL` | No | Override the API base URL (defaults to production) |

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

This is an MCP (Model Context Protocol) server that connects your AI assistant to the [AgentPhone API](https://agentphone.dev). It runs as a local process that your AI client (Cursor, Claude Desktop, etc.) communicates with over stdio.

```
Your AI Assistant  <-->  agentphone-mcp (local)  <-->  AgentPhone API  <-->  Phone Network
```

The MCP server itself is stateless — it's a thin typed client that translates MCP tool calls into AgentPhone API requests. All state (numbers, calls, messages) lives on the AgentPhone platform.

## License

MIT
