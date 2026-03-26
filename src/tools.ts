/**
 * AgentPhone MCP Tool Registrations
 *
 * All 26 MCP tools, extracted so they can be registered on any McpServer instance.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentPhoneAPI } from "./api.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(error: unknown): ToolResult {
  const message =
    error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function registerTools(server: McpServer, api: AgentPhoneAPI): void {
  // ============================================================
  // Account Overview
  // ============================================================

  server.tool(
    "account_overview",
    "Get a complete snapshot of your AgentPhone account: agents, phone numbers, webhook status, " +
      "and usage limits. Call this first to orient yourself before using other tools.",
    {},
    async () => {
      try {
        const [agents, numbers, webhook, usage] = await Promise.all([
          api.listAgents(100),
          api.listNumbers(100),
          api.getWebhook(),
          api.getUsage(),
        ]);

        const sections: string[] = [];

        sections.push(`=== Account Overview ===`);
        sections.push(`Plan: ${usage.plan.name}`);
        sections.push(
          `Phone Numbers: ${usage.numbers.used}/${usage.numbers.limit} used (${usage.numbers.remaining} remaining)`
        );
        sections.push(``);

        if (agents.data.length > 0) {
          sections.push(`--- Agents (${agents.data.length}) ---`);
          for (const a of agents.data) {
            const nums =
              a.numbers && a.numbers.length > 0
                ? a.numbers.map((n) => n.phoneNumber).join(", ")
                : "no numbers";
            sections.push(
              `  ${a.name} (id=${a.id}, voiceMode=${a.voiceMode}, ${nums})`
            );
          }
        } else {
          sections.push(`--- Agents ---`);
          sections.push(`  None yet. Use create_agent to get started.`);
        }
        sections.push(``);

        if (numbers.data.length > 0) {
          sections.push(`--- Phone Numbers (${numbers.data.length}) ---`);
          for (const n of numbers.data) {
            const agent = n.agentId
              ? `agent=${n.agentId}`
              : "unassigned";
            sections.push(
              `  ${n.phoneNumber} (id=${n.id}, ${n.country}, ${n.status}, ${agent})`
            );
          }
        } else {
          sections.push(`--- Phone Numbers ---`);
          sections.push(`  None yet. Use buy_number to provision one.`);
        }
        sections.push(``);

        sections.push(`--- Webhook ---`);
        if (webhook) {
          sections.push(`  URL: ${webhook.url}`);
          sections.push(`  Status: ${webhook.status}`);
        } else {
          sections.push(
            `  Not configured. Use set_webhook to receive inbound messages and call events.`
          );
        }
        sections.push(``);

        sections.push(`--- Recent Activity ---`);
        sections.push(
          `  Messages (30d): ${usage.stats.messagesLast30d}  Calls (30d): ${usage.stats.callsLast30d}`
        );

        return ok(sections.join("\n"));
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Phone Numbers
  // ============================================================

  server.tool(
    "list_numbers",
    "List all phone numbers in your account. Each number has an ID needed by other tools " +
      "(get_messages, release_number, attach_number, list_calls_for_number).",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
    },
    async ({ limit }) => {
      try {
        const result = await api.listNumbers(limit);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "buy_number",
    "Purchase a new phone number. Use area_code to request a specific region (e.g. '415' for " +
      "San Francisco). Tip: pass agent_id to attach it immediately, or use attach_number later. " +
      "Check get_usage first to see how many numbers you can still provision.",
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
        .describe(
          "3-digit area code for a specific region (e.g. '415', '212', '310')"
        ),
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to attach this number to immediately"),
    },
    async ({ country, area_code, agent_id }) => {
      try {
        const result = await api.buyNumber(country, agent_id, area_code);
        return ok(
          `Purchased number ${result.phoneNumber} (${result.country})\n\n${JSON.stringify(result, null, 2)}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "release_number",
    "Release (delete) a phone number. This is irreversible — the number goes back to the carrier pool. " +
      "Use list_numbers to find the number ID.",
    {
      number_id: z
        .string()
        .describe("The ID of the phone number to release"),
    },
    async ({ number_id }) => {
      try {
        const result = await api.releaseNumber(number_id);
        return ok(
          `Released number ${result.phoneNumber}\n\n${JSON.stringify(result, null, 2)}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // SMS / Messages
  // ============================================================

  server.tool(
    "get_messages",
    "Get SMS messages for a specific phone number. Use list_numbers to find the number ID. " +
      "For threaded conversations, use list_conversations + get_conversation instead.",
    {
      number_id: z.string().describe("The ID of the phone number"),
      limit: z
        .number()
        .min(1)
        .max(200)
        .default(50)
        .describe("Max messages to return"),
    },
    async ({ number_id, limit }) => {
      try {
        const result = await api.getMessages(number_id, limit);
        if (result.data.length === 0) {
          return ok("No messages found for this number.");
        }

        const formatted = result.data
          .map((m) => `[${m.receivedAt}] ${m.from} → ${m.to}: ${m.body}`)
          .join("\n");

        return ok(`${result.data.length} message(s):\n\n${formatted}`);
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Calls
  // ============================================================

  server.tool(
    "list_calls",
    "List recent phone calls across all numbers. Use get_call with a call ID to fetch the full transcript.",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
    },
    async ({ limit }) => {
      try {
        const result = await api.listCalls(limit);
        if (result.data.length === 0) {
          return ok("No calls found.");
        }

        const formatted = result.data
          .map(
            (c) =>
              `[${c.startedAt}] ${c.direction} ${c.fromNumber} → ${c.toNumber} (${c.status}) id=${c.id}`
          )
          .join("\n");

        return ok(
          `${result.data.length} call(s):\n\n${formatted}\n\nTotal: ${result.total}\n\nUse get_call with the id= value to fetch transcript.`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_calls_for_number",
    "List calls for a specific phone number. Use list_numbers to find the number ID.",
    {
      number_id: z.string().describe("The phone number ID"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
    },
    async ({ number_id, limit }) => {
      try {
        const result = await api.listCallsForNumber(number_id, limit);
        if (result.data.length === 0) {
          return ok("No calls found for this number.");
        }

        const formatted = result.data
          .map(
            (c) =>
              `[${c.startedAt}] ${c.direction} ${c.fromNumber} → ${c.toNumber} (${c.status}) id=${c.id}`
          )
          .join("\n");

        return ok(
          `${result.data.length} call(s):\n\n${formatted}\n\nTotal: ${result.total}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_call",
    "Get details and transcript for a specific call. Use list_calls to find call IDs.",
    {
      call_id: z.string().describe("The call ID"),
    },
    async ({ call_id }) => {
      try {
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

        return ok(
          [
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
            .join("\n")
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "make_call",
    "Initiate an outbound phone call. The agent must have at least one phone number attached. " +
      "Requires a webhook to handle the conversation — use set_webhook or set_agent_webhook first. " +
      "For autonomous AI calls without a webhook, use make_conversation_call instead.",
    {
      agent_id: z
        .string()
        .describe(
          "The agent ID (must have a phone number attached — use list_agents to check)"
        ),
      to_number: z
        .string()
        .describe(
          "Recipient phone number in E.164 format (e.g. +14155551234)"
        ),
      initial_greeting: z
        .string()
        .optional()
        .describe("What the agent says when the call connects"),
    },
    async ({ agent_id, to_number, initial_greeting }) => {
      try {
        const result = await api.makeCall(
          agent_id,
          to_number,
          initial_greeting
        );
        return ok(
          `Call initiated!\n  From: ${result.fromNumber}\n  To: ${result.toNumber}\n  Call ID: ${result.id}\n  Status: ${result.status}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "make_conversation_call",
    "Place a phone call where the AI has an autonomous conversation about a given topic. " +
      "Unlike make_call (which forwards to a webhook), this uses a built-in LLM so the AI " +
      "can hold a full conversation without any webhook setup. " +
      "The agent must have a phone number attached — use list_agents to check.",
    {
      agent_id: z
        .string()
        .describe(
          "The agent ID (must have a phone number attached)"
        ),
      to_number: z
        .string()
        .describe(
          "Recipient phone number in E.164 format (e.g. +14155551234)"
        ),
      topic: z.string().describe(
        "The conversation topic or instructions. This becomes the AI's system prompt. " +
          "Be specific about what the AI should discuss, its personality, and any goals."
      ),
      initial_greeting: z
        .string()
        .optional()
        .describe(
          "What the AI says when the call connects. If not set, the AI will generate one from the topic."
        ),
    },
    async ({ agent_id, to_number, topic, initial_greeting }) => {
      try {
        const result = await api.makeConversationCall(
          agent_id,
          to_number,
          topic,
          initial_greeting
        );
        return ok(
          [
            `Conversation call initiated!`,
            `  From: ${result.fromNumber}`,
            `  To: ${result.toNumber}`,
            `  Call ID: ${result.id}`,
            `  Status: ${result.status}`,
            ``,
            `The AI will have an autonomous conversation about the topic you provided.`,
            `Use get_call with the call ID to check the transcript once the call ends.`,
          ].join("\n")
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Agents
  // ============================================================

  server.tool(
    "list_agents",
    "List all agents with their phone numbers and voice configuration. " +
      "An agent is required before you can make calls — it owns phone numbers and handles voice/SMS.",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
    },
    async ({ limit }) => {
      try {
        const result = await api.listAgents(limit);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "create_agent",
    "Create a new agent. An agent owns phone numbers and handles calls/SMS. " +
      "After creating, use buy_number or attach_number to give it a phone number. " +
      "Set voice_mode to 'hosted' with a system_prompt for autonomous AI voice calls, " +
      "or 'webhook' (default) to forward call transcripts to your webhook URL. " +
      "Use list_voices to see available voice options.",
    {
      name: z
        .string()
        .describe("Name for the agent (e.g. 'Customer Support', 'Sales Bot')"),
      description: z
        .string()
        .optional()
        .describe("Description of what this agent does"),
      voice_mode: z
        .enum(["webhook", "hosted"])
        .optional()
        .describe(
          "'webhook' (default) forwards transcripts to your webhook. 'hosted' uses built-in AI with system_prompt."
        ),
      system_prompt: z
        .string()
        .optional()
        .describe(
          "Required when voice_mode is 'hosted'. The AI's personality and instructions for voice calls."
        ),
      begin_message: z
        .string()
        .optional()
        .describe(
          "What the AI says when a call connects. Only used in 'hosted' mode."
        ),
      voice: z
        .string()
        .optional()
        .describe(
          "Voice ID for the agent (use list_voices to see options). Defaults to '11labs-Brian'."
        ),
    },
    async ({
      name,
      description,
      voice_mode,
      system_prompt,
      begin_message,
      voice,
    }) => {
      try {
        const result = await api.createAgent({
          name,
          description,
          voiceMode: voice_mode,
          systemPrompt: system_prompt,
          beginMessage: begin_message,
          voice,
        });
        return ok(
          `Agent created!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n\n${JSON.stringify(result, null, 2)}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "update_agent",
    "Update an agent's configuration — name, description, voice settings, system prompt, or greeting. " +
      "Only provided fields are updated. Use list_voices to see available voice IDs. " +
      "Switching voice_mode to 'hosted' requires a system_prompt.",
    {
      agent_id: z.string().describe("The agent ID to update"),
      name: z.string().optional().describe("New name for the agent"),
      description: z.string().optional().describe("New description"),
      voice_mode: z
        .enum(["webhook", "hosted"])
        .optional()
        .describe(
          "'webhook' forwards transcripts to your webhook. 'hosted' uses built-in AI with system_prompt."
        ),
      system_prompt: z
        .string()
        .optional()
        .describe(
          "The AI's personality and instructions. Required when voice_mode is 'hosted'."
        ),
      begin_message: z
        .string()
        .optional()
        .describe(
          "What the AI says when a call connects (hosted mode only)."
        ),
      voice: z
        .string()
        .optional()
        .describe("Voice ID (use list_voices to see options)."),
    },
    async ({
      agent_id,
      name,
      description,
      voice_mode,
      system_prompt,
      begin_message,
      voice,
    }) => {
      try {
        const params: Record<string, string | undefined> = {};
        if (name !== undefined) params.name = name;
        if (description !== undefined) params.description = description;
        if (voice_mode !== undefined) params.voiceMode = voice_mode;
        if (system_prompt !== undefined) params.systemPrompt = system_prompt;
        if (begin_message !== undefined) params.beginMessage = begin_message;
        if (voice !== undefined) params.voice = voice;

        const result = await api.updateAgent(agent_id, params);
        return ok(
          `Agent updated!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n\n${JSON.stringify(result, null, 2)}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_agent",
    "Delete an agent. Phone numbers attached to it will be kept but unassigned. This cannot be undone.",
    {
      agent_id: z.string().describe("The agent ID to delete"),
    },
    async ({ agent_id }) => {
      try {
        const result = await api.deleteAgent(agent_id);
        return ok(`Deleted agent '${result.name}' (${result.id})`);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_agent",
    "Get details for a specific agent including its phone numbers, voice configuration, and system prompt.",
    {
      agent_id: z.string().describe("The agent ID"),
    },
    async ({ agent_id }) => {
      try {
        const result = await api.getAgent(agent_id);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "attach_number",
    "Attach a phone number to an agent so the agent handles calls/SMS on that number. " +
      "Use list_numbers to find unassigned number IDs and list_agents for agent IDs.",
    {
      agent_id: z.string().describe("The agent ID"),
      number_id: z.string().describe("The phone number ID to attach"),
    },
    async ({ agent_id, number_id }) => {
      try {
        const result = await api.attachNumber(agent_id, number_id);
        return ok(
          `Attached number ${result.number.phoneNumber} to agent ${result.agentId}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_voices",
    "List available voices for agents. Use the voice_id value when calling create_agent or update_agent.",
    {},
    async () => {
      try {
        const result = await api.listVoices();
        if (result.data.length === 0) {
          return ok("No voices available.");
        }

        const formatted = result.data
          .map(
            (v) =>
              `${v.voice_id} — ${v.voice_name} (${v.provider}, ${v.gender}, ${v.accent})`
          )
          .join("\n");

        return ok(
          `${result.data.length} voice(s) available:\n\n${formatted}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Conversations
  // ============================================================

  server.tool(
    "list_conversations",
    "List SMS conversations across all your numbers. Each conversation is a thread between " +
      "your number and an external contact. Use get_conversation with the ID to read messages.",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
    },
    async ({ limit }) => {
      try {
        const result = await api.listConversations(limit);
        if (result.data.length === 0) {
          return ok("No conversations found.");
        }

        const formatted = result.data
          .map(
            (c) =>
              `${c.participant} ↔ ${c.phoneNumber} (${c.messageCount} msgs, last: ${c.lastMessageAt || "never"}) id=${c.id}`
          )
          .join("\n");

        return ok(
          `${result.data.length} conversation(s):\n\n${formatted}\n\nTotal: ${result.total}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_conversation",
    "Get a specific SMS conversation with message history. Use list_conversations to find IDs.",
    {
      conversation_id: z.string().describe("The conversation ID"),
      message_limit: z
        .number()
        .min(1)
        .max(100)
        .default(50)
        .describe("Max messages to include"),
    },
    async ({ conversation_id, message_limit }) => {
      try {
        const result = await api.getConversation(
          conversation_id,
          message_limit
        );

        let messages = "No messages.";
        if (result.messages && result.messages.length > 0) {
          messages = result.messages
            .map((m) => `[${m.receivedAt}] ${m.fromNumber}: ${m.body}`)
            .join("\n");
        }

        return ok(
          [
            `Conversation ${result.id}`,
            `Contact: ${result.participant}`,
            `Number: ${result.phoneNumber}`,
            `Messages: ${result.messageCount}`,
            `\n${messages}`,
          ].join("\n")
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Usage
  // ============================================================

  server.tool(
    "get_usage",
    "Get account usage statistics: plan limits, phone number quotas, message/call volume, " +
      "and webhook delivery stats. Use this to check remaining capacity before provisioning resources.",
    {},
    async () => {
      try {
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

        return ok(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Webhooks (project-level)
  // ============================================================

  server.tool(
    "get_webhook",
    "Get the project-level webhook endpoint that receives inbound messages and call events. " +
      "For agent-specific webhooks, use get_agent_webhook.",
    {},
    async () => {
      try {
        const result = await api.getWebhook();
        if (!result) {
          return ok("No webhook configured.");
        }
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "set_webhook",
    "Set the project-level webhook URL that receives inbound messages and call events for all agents. " +
      "To route a specific agent's events to a different URL, use set_agent_webhook instead. " +
      "The webhook secret is returned — use it to verify webhook signatures.",
    {
      url: z
        .string()
        .url()
        .describe("The publicly accessible webhook URL (must be HTTPS in production)"),
      context_limit: z
        .number()
        .min(0)
        .max(50)
        .optional()
        .describe(
          "Number of recent messages to include as conversation context in each webhook (0-50)"
        ),
    },
    async ({ url, context_limit }) => {
      try {
        const result = await api.setWebhook(url, context_limit);
        return ok(
          `Webhook set!\n  URL: ${result.url}\n  Secret: ${result.secret}\n  Status: ${result.status}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_webhook",
    "Remove the project-level webhook. Agents with their own webhook (set via set_agent_webhook) are not affected.",
    {},
    async () => {
      try {
        await api.deleteWebhook();
        return ok("Webhook deleted.");
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Webhooks (per-agent)
  // ============================================================

  server.tool(
    "get_agent_webhook",
    "Get the webhook configured for a specific agent. When set, this agent's events go here " +
      "instead of the project-level webhook.",
    {
      agent_id: z.string().describe("The agent ID"),
    },
    async ({ agent_id }) => {
      try {
        const result = await api.getAgentWebhook(agent_id);
        if (!result) {
          return ok(
            "No agent-specific webhook configured. Events go to the project-level webhook."
          );
        }
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "set_agent_webhook",
    "Set a webhook URL for a specific agent. When configured, this agent's inbound messages " +
      "and call events are delivered here instead of the project-level webhook. " +
      "Useful when different agents need different backends.",
    {
      agent_id: z.string().describe("The agent ID"),
      url: z
        .string()
        .url()
        .describe("The publicly accessible webhook URL (must be HTTPS in production)"),
      context_limit: z
        .number()
        .min(0)
        .max(50)
        .optional()
        .describe(
          "Number of recent messages to include as conversation context (0-50)"
        ),
    },
    async ({ agent_id, url, context_limit }) => {
      try {
        const result = await api.setAgentWebhook(
          agent_id,
          url,
          context_limit
        );
        return ok(
          `Agent webhook set!\n  Agent: ${agent_id}\n  URL: ${result.url}\n  Secret: ${result.secret}\n  Status: ${result.status}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_agent_webhook",
    "Remove the webhook for a specific agent. Events will fall back to the project-level webhook.",
    {
      agent_id: z.string().describe("The agent ID"),
    },
    async ({ agent_id }) => {
      try {
        await api.deleteAgentWebhook(agent_id);
        return ok(
          "Agent webhook deleted. Events will now go to the project-level webhook."
        );
      } catch (e) {
        return err(e);
      }
    }
  );
}
