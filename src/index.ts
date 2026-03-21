#!/usr/bin/env node

/**
 * AgentPhone MCP Server
 *
 * Gives AI agents access to phone numbers, SMS, and voice calls
 * via the Model Context Protocol.
 *
 * Tools:
 *   Numbers:  list_numbers, buy_number, release_number
 *   SMS:      get_messages
 *   Calls:    list_calls, get_call, make_call, make_conversation_call
 *   Agents:   list_agents, create_agent, update_agent, delete_agent, get_agent, attach_number, list_voices
 *   Convos:   list_conversations, get_conversation
 *   Usage:    get_usage
 *   Webhooks: get_webhook, set_webhook, delete_webhook
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AgentPhoneAPI } from "./api.js";

const API_KEY = process.env.AGENTPHONE_API_KEY;
const BASE_URL =
  process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.to";

if (!API_KEY) {
  console.error("AGENTPHONE_API_KEY environment variable is required");
  process.exit(1);
}

const api = new AgentPhoneAPI(BASE_URL, API_KEY);

const server = new McpServer({
  name: "agentphone",
  version: "0.1.0",
});

// ============================================================
// Phone Numbers
// ============================================================

server.tool(
  "list_numbers",
  "List all phone numbers in your AgentPhone account",
  { limit: z.number().min(1).max(100).default(20).describe("Max results to return") },
  async ({ limit }) => {
    const result = await api.listNumbers(limit);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "buy_number",
  "Purchase a new phone number. Returns the provisioned number. " +
    "Use area_code to request a specific region (e.g. '415' for San Francisco, '212' for NYC).",
  {
    country: z
      .string()
      .length(2)
      .default("US")
      .describe("2-letter ISO country code (e.g. US, CA, GB)"),
    area_code: z
      .string()
      .length(3)
      .optional()
      .describe("3-digit area code to request a number in a specific region (e.g. '415', '212', '310')"),
    agent_id: z
      .string()
      .optional()
      .describe("Agent ID to attach this number to immediately"),
  },
  async ({ country, area_code, agent_id }) => {
    const result = await api.buyNumber(country, agent_id, area_code);
    return {
      content: [
        {
          type: "text" as const,
          text: `Purchased number ${result.phoneNumber} (${result.country})\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "release_number",
  "Release (delete) a phone number. This is irreversible — the number goes back to the carrier pool.",
  {
    number_id: z.string().describe("The ID of the phone number to release"),
  },
  async ({ number_id }) => {
    const result = await api.releaseNumber(number_id);
    return {
      content: [
        {
          type: "text" as const,
          text: `Released number ${result.phoneNumber}\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }
);

// ============================================================
// SMS / Messages
// ============================================================

server.tool(
  "get_messages",
  "Get SMS messages received on a phone number",
  {
    number_id: z.string().describe("The ID of the phone number"),
    limit: z.number().min(1).max(200).default(50).describe("Max messages to return"),
  },
  async ({ number_id, limit }) => {
    const result = await api.getMessages(number_id, limit);
    if (result.data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No messages found for this number." }],
      };
    }

    const formatted = result.data
      .map(
        (m) =>
          `[${m.receivedAt}] ${m.from} → ${m.to}: ${m.body}`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${result.data.length} message(s):\n\n${formatted}`,
        },
      ],
    };
  }
);

// ============================================================
// Calls
// ============================================================

server.tool(
  "list_calls",
  "List recent phone calls (inbound and outbound)",
  {
    limit: z.number().min(1).max(100).default(20).describe("Max results to return"),
  },
  async ({ limit }) => {
    const result = await api.listCalls(limit);
    if (result.data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No calls found." }],
      };
    }

    const formatted = result.data
      .map(
        (c) =>
          `[${c.startedAt}] ${c.direction} ${c.fromNumber} → ${c.toNumber} (${c.status}) id=${c.id}`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${result.data.length} call(s):\n\n${formatted}\n\nTotal: ${result.total}\n\nUse get_call with the id= value to fetch transcript.`,
        },
      ],
    };
  }
);

server.tool(
  "get_call",
  "Get details and transcript for a specific call",
  {
    call_id: z.string().describe("The call ID"),
  },
  async ({ call_id }) => {
    const result = await api.getCall(call_id);

    let transcript = "No transcript available.";
    if (result.transcripts && result.transcripts.length > 0) {
      transcript = result.transcripts
        .map((t) => {
          const response = t.response ? `\n  Agent: ${t.response}` : "";
          return `  Human: ${t.transcript}${response}`;
        })
        .join("\n");
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Call ${result.id}`,
            `Direction: ${result.direction}`,
            `From: ${result.fromNumber}`,
            `To: ${result.toNumber}`,
            `Status: ${result.status}`,
            `Started: ${result.startedAt}`,
            result.endedAt ? `Ended: ${result.endedAt}` : null,
            `\nTranscript:\n${transcript}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  }
);

server.tool(
  "make_call",
  "Initiate an outbound phone call from one of your numbers to a recipient",
  {
    agent_id: z
      .string()
      .describe("The agent ID (determines which number to call from)"),
    to_number: z
      .string()
      .describe("Recipient phone number in E.164 format (e.g. +14155551234)"),
    initial_greeting: z
      .string()
      .optional()
      .describe("What the agent says when the call connects"),
  },
  async ({ agent_id, to_number, initial_greeting }) => {
    const result = await api.makeCall(agent_id, to_number, initial_greeting);
    return {
      content: [
        {
          type: "text" as const,
          text: `Call initiated!\n  From: ${result.fromNumber}\n  To: ${result.toNumber}\n  Call ID: ${result.id}\n  Status: ${result.status}`,
        },
      ],
    };
  }
);

server.tool(
  "make_conversation_call",
  "Place a phone call where the AI has an autonomous conversation about a given topic. " +
    "Unlike make_call (which forwards to a webhook), this uses a built-in LLM so the AI " +
    "can hold a full conversation without any external webhook setup.",
  {
    agent_id: z
      .string()
      .describe("The agent ID (determines which number to call from)"),
    to_number: z
      .string()
      .describe("Recipient phone number in E.164 format (e.g. +14155551234)"),
    topic: z
      .string()
      .describe(
        "The conversation topic or instructions. This becomes the AI's system prompt. " +
          "Be specific about what the AI should discuss, its personality, and any goals."
      ),
    initial_greeting: z
      .string()
      .optional()
      .describe("What the AI says when the call connects. If not set, the AI will generate one from the topic."),
  },
  async ({ agent_id, to_number, topic, initial_greeting }) => {
    const systemPrompt = topic;
    const result = await api.makeConversationCall(
      agent_id,
      to_number,
      systemPrompt,
      initial_greeting
    );
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Conversation call initiated!`,
            `  From: ${result.fromNumber}`,
            `  To: ${result.toNumber}`,
            `  Call ID: ${result.id}`,
            `  Status: ${result.status}`,
            ``,
            `The AI will have an autonomous conversation about the topic you provided.`,
            `Use get_call with the call ID to check the transcript once the call ends.`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ============================================================
// Agents
// ============================================================

server.tool(
  "list_agents",
  "List all agents in your account with their phone numbers and voice configuration",
  {
    limit: z.number().min(1).max(100).default(20).describe("Max results to return"),
  },
  async ({ limit }) => {
    const result = await api.listAgents(limit);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "create_agent",
  "Create a new agent. An agent owns phone numbers and handles calls/SMS. " +
    "Set voice_mode to 'hosted' with a system_prompt for autonomous AI voice calls, " +
    "or 'webhook' (default) to forward call transcripts to your webhook.",
  {
    name: z.string().describe("Name for the agent (e.g. 'Customer Support', 'Sales Bot')"),
    description: z.string().optional().describe("Description of what this agent does"),
    voice_mode: z
      .enum(["webhook", "hosted"])
      .optional()
      .describe("'webhook' (default) forwards transcripts to your webhook. 'hosted' uses built-in AI with system_prompt."),
    system_prompt: z
      .string()
      .optional()
      .describe("Required when voice_mode is 'hosted'. The AI's personality and instructions for voice calls."),
    begin_message: z
      .string()
      .optional()
      .describe("What the AI says when a call connects. Only used in 'hosted' mode."),
    voice: z
      .string()
      .optional()
      .describe("Voice ID for the agent (use list_voices to see options). Defaults to '11labs-Brian'."),
  },
  async ({ name, description, voice_mode, system_prompt, begin_message, voice }) => {
    const result = await api.createAgent({
      name,
      description,
      voiceMode: voice_mode,
      systemPrompt: system_prompt,
      beginMessage: begin_message,
      voice,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Agent created!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "update_agent",
  "Update an agent's configuration. Use this to change voice settings, system prompt, " +
    "greeting, or switch between webhook and hosted voice modes. Only provided fields are updated.",
  {
    agent_id: z.string().describe("The agent ID to update"),
    name: z.string().optional().describe("New name for the agent"),
    description: z.string().optional().describe("New description"),
    voice_mode: z
      .enum(["webhook", "hosted"])
      .optional()
      .describe("'webhook' forwards transcripts to your webhook. 'hosted' uses built-in AI with system_prompt."),
    system_prompt: z
      .string()
      .optional()
      .describe("The AI's personality and instructions. Required when voice_mode is 'hosted'."),
    begin_message: z
      .string()
      .optional()
      .describe("What the AI says when a call connects (hosted mode only)."),
    voice: z
      .string()
      .optional()
      .describe("Voice ID (use list_voices to see options)."),
  },
  async ({ agent_id, name, description, voice_mode, system_prompt, begin_message, voice }) => {
    const params: Record<string, string | undefined> = {};
    if (name !== undefined) params.name = name;
    if (description !== undefined) params.description = description;
    if (voice_mode !== undefined) params.voiceMode = voice_mode;
    if (system_prompt !== undefined) params.systemPrompt = system_prompt;
    if (begin_message !== undefined) params.beginMessage = begin_message;
    if (voice !== undefined) params.voice = voice;

    const result = await api.updateAgent(agent_id, params);
    return {
      content: [
        {
          type: "text" as const,
          text: `Agent updated!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  }
);

server.tool(
  "delete_agent",
  "Delete an agent. Phone numbers attached to it will be kept but unassigned. This cannot be undone.",
  {
    agent_id: z.string().describe("The agent ID to delete"),
  },
  async ({ agent_id }) => {
    const result = await api.deleteAgent(agent_id);
    return {
      content: [
        {
          type: "text" as const,
          text: `Deleted agent '${result.name}' (${result.id})`,
        },
      ],
    };
  }
);

server.tool(
  "get_agent",
  "Get details for a specific agent including its phone numbers and voice configuration",
  {
    agent_id: z.string().describe("The agent ID"),
  },
  async ({ agent_id }) => {
    const result = await api.getAgent(agent_id);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "attach_number",
  "Attach a phone number to an agent so the agent handles calls/SMS on that number",
  {
    agent_id: z.string().describe("The agent ID"),
    number_id: z.string().describe("The phone number ID to attach"),
  },
  async ({ agent_id, number_id }) => {
    const result = await api.attachNumber(agent_id, number_id);
    return {
      content: [
        {
          type: "text" as const,
          text: `Attached number ${result.number.phoneNumber} to agent ${result.agentId}`,
        },
      ],
    };
  }
);

server.tool(
  "list_voices",
  "List available voices for agents. Use the voice_id when creating or updating an agent.",
  {},
  async () => {
    const result = await api.listVoices();
    if (result.data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No voices available." }],
      };
    }

    const formatted = result.data
      .map(
        (v) =>
          `${v.voice_id} — ${v.voice_name} (${v.provider}, ${v.gender}, ${v.accent})`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${result.data.length} voice(s) available:\n\n${formatted}`,
        },
      ],
    };
  }
);

// ============================================================
// Conversations
// ============================================================

server.tool(
  "list_conversations",
  "List SMS conversations across all your numbers",
  {
    limit: z.number().min(1).max(100).default(20).describe("Max results to return"),
  },
  async ({ limit }) => {
    const result = await api.listConversations(limit);
    if (result.data.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No conversations found." }],
      };
    }

    const formatted = result.data
      .map(
        (c) =>
          `${c.participant} ↔ ${c.phoneNumber} (${c.messageCount} msgs, last: ${c.lastMessageAt || "never"}) id=${c.id}`
      )
      .join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `${result.data.length} conversation(s):\n\n${formatted}\n\nTotal: ${result.total}`,
        },
      ],
    };
  }
);

server.tool(
  "get_conversation",
  "Get a specific SMS conversation with message history",
  {
    conversation_id: z.string().describe("The conversation ID"),
    message_limit: z.number().min(1).max(100).default(50).describe("Max messages to include"),
  },
  async ({ conversation_id, message_limit }) => {
    const result = await api.getConversation(conversation_id, message_limit);

    let messages = "No messages.";
    if (result.messages && result.messages.length > 0) {
      messages = result.messages
        .map((m) => `[${m.receivedAt}] ${m.fromNumber}: ${m.body}`)
        .join("\n");
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Conversation ${result.id}`,
            `Contact: ${result.participant}`,
            `Number: ${result.phoneNumber}`,
            `Messages: ${result.messageCount}`,
            `\n${messages}`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ============================================================
// Usage
// ============================================================

server.tool(
  "get_usage",
  "Get account usage statistics including plan limits, number quotas, message/call counts, and webhook delivery stats",
  {},
  async () => {
    const result = await api.getUsage();

    const lines = [
      `Plan: ${result.plan.name}`,
      ``,
      `Phone Numbers: ${result.numbers.used}/${result.numbers.limit} (${result.numbers.remaining} remaining)`,
      ``,
      `Messages:`,
      `  Total: ${result.stats.totalMessages}`,
      `  Last 24h: ${result.stats.messagesLast24h}`,
      `  Last 7d: ${result.stats.messagesLast7d}`,
      `  Last 30d: ${result.stats.messagesLast30d}`,
      ``,
      `Calls:`,
      `  Total: ${result.stats.totalCalls}`,
      `  Last 24h: ${result.stats.callsLast24h}`,
      `  Last 7d: ${result.stats.callsLast7d}`,
      `  Last 30d: ${result.stats.callsLast30d}`,
      ``,
      `Webhooks:`,
      `  Delivered: ${result.stats.totalWebhookDeliveries} (${result.stats.successfulWebhookDeliveries} ok, ${result.stats.failedWebhookDeliveries} failed)`,
      ``,
      `Plan Limits:`,
      `  Max numbers: ${result.plan.limits.numbers}`,
      `  Messages/month: ${result.plan.limits.messagesPerMonth}`,
      `  Voice minutes/month: ${result.plan.limits.voiceMinutesPerMonth}`,
      `  Max call duration: ${result.plan.limits.maxCallDurationMinutes} min`,
      `  Concurrent calls: ${result.plan.limits.concurrentCalls}`,
    ];

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  }
);

// ============================================================
// Webhooks
// ============================================================

server.tool(
  "get_webhook",
  "Get the currently configured webhook endpoint",
  {},
  async () => {
    const result = await api.getWebhook();
    if (!result) {
      return {
        content: [{ type: "text" as const, text: "No webhook configured." }],
      };
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "set_webhook",
  "Set the webhook URL that receives inbound messages and call events",
  {
    url: z.string().url().describe("The publicly accessible webhook URL"),
    context_limit: z
      .number()
      .min(0)
      .max(50)
      .optional()
      .describe("Number of recent messages to include as context (0-50)"),
  },
  async ({ url, context_limit }) => {
    const result = await api.setWebhook(url, context_limit);
    return {
      content: [
        {
          type: "text" as const,
          text: `Webhook set!\n  URL: ${result.url}\n  Secret: ${result.secret}\n  Status: ${result.status}`,
        },
      ],
    };
  }
);

server.tool(
  "delete_webhook",
  "Remove the currently configured webhook",
  {},
  async () => {
    await api.deleteWebhook();
    return {
      content: [{ type: "text" as const, text: "Webhook deleted." }],
    };
  }
);

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
