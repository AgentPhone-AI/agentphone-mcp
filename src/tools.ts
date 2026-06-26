/**
 * AgentPhone MCP Tool Registrations
 *
 * 28 MCP tools with ToolAnnotations, input validation, and actionable errors.
 */

import { z } from "zod";
import { AgentPhoneAPI, ApiError } from "./api.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/**
 * Minimal registration surface this module needs. Implemented by an adapter in
 * index.ts that forwards to the mcp-use MCPServer. Keeping the SDK-style
 * (name, description, schema, annotations, handler) signature lets every tool
 * definition below stay unchanged across the transport migration.
 */
export interface ToolRegistrar {
  // With annotations (matches the SDK's 5-arg overload).
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    annotations: Record<string, unknown>,
    handler: (args: any) => Promise<ToolResult>
  ): void;
  // Without annotations (SDK's 4-arg overload).
  tool(
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: any) => Promise<ToolResult>
  ): void;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(error: unknown): ToolResult {
  if (error instanceof ApiError) {
    const base = error.detail;
    let hint = "";
    switch (error.status) {
      case 0:
        hint = " Request timed out — retry, or pass a longer timeout if the tool supports one.";
        break;
      case 401:
        hint = " Check your AGENTPHONE_API_KEY.";
        break;
      case 404:
        if (error.path.includes("/agents/"))
          hint = " Use list_agents to see valid agent IDs.";
        else if (error.path.includes("/numbers/"))
          hint = " Use list_numbers to see valid number IDs.";
        else if (error.path.includes("/calls/"))
          hint = " Use list_calls to see recent call IDs.";
        else if (error.path.includes("/conversations/"))
          hint = " Use list_conversations to see valid conversation IDs.";
        else if (error.path.includes("/webhook"))
          hint = " Use get_webhook to check whether a webhook is configured.";
        break;
      case 429:
        hint = " Rate limited — wait a moment and try again.";
        break;
    }
    return { content: [{ type: "text", text: base + hint }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

// --- Validation helpers ---

const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const COUNTRY_REGEX = /^[A-Z]{2}$/;
const AREA_CODE_REGEX = /^\d{3}$/;

function validateE164(phone: string): string | null {
  if (!E164_REGEX.test(phone))
    return "Phone number must be in E.164 format, e.g. +14155551234";
  return null;
}

function validateCountry(code: string): string | null {
  if (!COUNTRY_REGEX.test(code))
    return "Country must be a 2-letter ISO code, e.g. US, CA, GB";
  return null;
}

function validateAreaCode(code: string): string | null {
  if (!AREA_CODE_REGEX.test(code))
    return "Area code must be 3 digits, e.g. 415, 212, 310";
  return null;
}

export function registerTools(server: ToolRegistrar, api: AgentPhoneAPI): void {
  // ============================================================
  // Account Overview
  // ============================================================

  server.tool(
    "account_overview",
    "Get a complete snapshot of your AgentPhone account: agents, phone numbers, webhook status, " +
      "and usage limits. Call this first to orient yourself before using other tools.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      try {
        const results = await Promise.allSettled([
          api.listAgents(100),
          api.listNumbers(100),
          api.getWebhook(),
          api.getUsage(),
        ]);

        const agents = results[0].status === "fulfilled" ? results[0].value : null;
        const numbers = results[1].status === "fulfilled" ? results[1].value : null;
        const webhook = results[2].status === "fulfilled" ? results[2].value : null;
        const usage = results[3].status === "fulfilled" ? results[3].value : null;

        const sections: string[] = [];

        sections.push(`=== Account Overview ===`);
        if (usage) {
          sections.push(`Plan: ${usage.plan.name}`);
          sections.push(
            `Phone Numbers: ${usage.numbers.used}/${usage.numbers.limit} used (${usage.numbers.remaining} remaining)`
          );
        }
        sections.push(``);

        if (agents) {
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
        } else {
          sections.push(`--- Agents ---`);
          sections.push(`  Failed to load. ${results[0].status === "rejected" ? results[0].reason : ""}`);
        }
        sections.push(``);

        if (numbers) {
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
        } else {
          sections.push(`--- Phone Numbers ---`);
          sections.push(`  Failed to load.`);
        }
        sections.push(``);

        sections.push(`--- Webhook ---`);
        if (webhook) {
          sections.push(`  URL: ${webhook.url}`);
          sections.push(`  Status: ${webhook.status}`);
        } else if (results[2].status === "fulfilled") {
          sections.push(
            `  Not configured. Use set_webhook to receive inbound messages and call events.`
          );
        } else {
          sections.push(`  Failed to load.`);
        }
        sections.push(``);

        if (usage) {
          sections.push(`--- Recent Activity ---`);
          sections.push(
            `  Messages (30d): ${usage.stats.messagesLast30d}  Calls (30d): ${usage.stats.callsLast30d}`
          );
        }

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
      "(get_messages, attach_number, list_calls).",
    {
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
      offset: z
        .number()
        .min(0)
        .default(0)
        .describe("Number of results to skip (for pagination)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ limit, offset }) => {
      try {
        const result = await api.listNumbers(limit, offset);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "buy_number",
    "Purchase a new phone number. Use area_code to request a specific region (e.g. '415' for " +
      "San Francisco). Tip: pass agent_id to attach it immediately, or use attach_number later.",
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
        .describe("3-digit area code for a specific region (e.g. '415', '212', '310')"),
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to attach this number to immediately"),
    },
    { openWorldHint: true },
    async ({ country, area_code, agent_id }) => {
      const countryErr = validateCountry(country);
      if (countryErr) return err(new Error(countryErr));
      if (area_code) {
        const areaErr = validateAreaCode(area_code);
        if (areaErr) return err(new Error(areaErr));
      }

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

  // ============================================================
  // SMS / Messages
  // ============================================================

  server.tool(
    "send_message",
    "Send an SMS or iMessage from one of your agent's phone numbers.\n\n" +
      "USE THIS TOOL WHEN the user wants to text someone.\n" +
      "The agent must have at least one phone number attached. If the agent has multiple numbers, " +
      "use number_id or from_number to choose which one to send from.\n" +
      "iMessage extras (silently ignored on SMS): reply_to_message_id threads the reply under an " +
      "earlier message, and send_style adds an expressive screen/bubble effect.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("The agent ID to send from (must have a phone number attached — use list_agents to check). Optional if you pass from_number or number_id instead."),
      to_number: z
        .string()
        .describe("Recipient: a phone number in E.164 format (e.g. +14155551234), a US short code, or a group ID (grp_...) to post into an iMessage group chat. Other destination identifiers are accepted and routed by the server."),
      body: z
        .string()
        .describe("The message text to send (may be empty when sending media only)"),
      media_url: z
        .string()
        .url()
        .optional()
        .describe("URL of a single image/media file to attach"),
      media_urls: z
        .array(z.string().url())
        .optional()
        .describe("Multiple media URLs to attach (delivered as an image carousel on iMessage)"),
      number_id: z
        .string()
        .optional()
        .describe("Specific phone number ID to send from (if agent has multiple numbers)"),
      from_number: z
        .string()
        .optional()
        .describe("Exact number to send from in E.164 format (alternative to number_id)"),
      reply_to_message_id: z
        .string()
        .optional()
        .describe("iMessage only. ID of an earlier message to reply to inline (threaded reply)"),
      send_style: z
        .enum([
          "celebration", "fireworks", "lasers", "love", "confetti", "balloons",
          "spotlight", "echo", "invisible", "gentle", "loud", "slam",
        ])
        .optional()
        .describe("iMessage only. Expressive screen/bubble effect to send with the message"),
    },
    { openWorldHint: true },
    async ({ agent_id, to_number, body, media_url, media_urls, number_id, from_number, reply_to_message_id, send_style }) => {
      if (!agent_id && !from_number && !number_id) {
        return err(new Error("Provide agent_id, from_number, or number_id to identify the sender."));
      }
      // Only enforce E.164 when the recipient is clearly a phone number (leading +).
      // Short codes, group IDs (grp_...), emails, and other destination identifiers
      // are passed through for the server to normalize and route.
      if (to_number.startsWith("+")) {
        const phoneErr = validateE164(to_number);
        if (phoneErr) return err(new Error(phoneErr));
      }
      if (from_number) {
        const fromErr = validateE164(from_number);
        if (fromErr) return err(new Error(fromErr));
      }

      try {
        const result = await api.sendMessage({
          agentId: agent_id,
          toNumber: to_number,
          body,
          mediaUrl: media_url,
          mediaUrls: media_urls,
          numberId: number_id,
          fromNumber: from_number,
          replyToMessageId: reply_to_message_id,
          sendStyle: send_style,
        });
        const lines = [
          `Message sent!`,
          `  From: ${result.from_number}`,
          `  To: ${result.to_number}`,
          `  Channel: ${result.channel ?? "unknown"}`,
          `  Status: ${result.status}`,
          `  ID: ${result.id}`,
        ];
        if (result.reply_parent_unresolved) {
          lines.push(`  Note: couldn't thread under the reply parent; delivered without threading.`);
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return err(e);
      }
    }
  );

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
    { readOnlyHint: true, idempotentHint: true },
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
    "List recent calls. Scope by agent_id or number_id, or use status/direction/search to filter globally.\n\n" +
      "When agent_id or number_id is passed, status/direction/search filters are not applied.\n" +
      "Returns call IDs — use get_call with an ID to fetch the full transcript.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Filter to calls for a specific agent"),
      number_id: z
        .string()
        .optional()
        .describe("Filter to calls for a specific phone number"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
      offset: z
        .number()
        .min(0)
        .default(0)
        .describe("Number of results to skip (for pagination)"),
      status: z
        .string()
        .optional()
        .describe("Filter by status: ringing, in-progress, completed, failed, busy, no-answer"),
      direction: z
        .enum(["inbound", "outbound"])
        .optional()
        .describe("Filter by direction: 'inbound' or 'outbound'"),
      search: z
        .string()
        .optional()
        .describe("Search by phone number or keyword"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id, number_id, limit, offset, status, direction, search }) => {
      try {
        let result;
        if (number_id) {
          result = await api.listCallsForNumber(number_id, limit, offset);
        } else if (agent_id) {
          result = await api.listAgentCalls(agent_id, limit, offset);
        } else {
          result = await api.listCalls(limit, offset, { status, direction, search });
        }

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
    "get_call",
    "Get details and transcript for a specific call. Use list_calls to find call IDs. " +
      "Pass wait=true to block until an in-progress call finishes before returning.",
    {
      call_id: z.string().describe("The call ID"),
      wait: z
        .boolean()
        .default(false)
        .describe(
          "When true, long-polls until the call completes before returning. " +
            "Useful for checking back on a call you initiated earlier."
        ),
      timeout: z
        .number()
        .min(10)
        .max(300)
        .default(120)
        .describe("Max seconds to wait when wait=true. Defaults to 120."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ call_id, wait, timeout }) => {
      try {
        const result = await api.getCall(call_id, { wait, timeout });

        let transcript = "No transcript available.";
        if (result.transcripts && result.transcripts.length > 0) {
          transcript = result.transcripts
            .map((t) => {
              const parts: string[] = [];
              if (t.transcript) parts.push(`  Human: ${t.transcript}`);
              if (t.response) parts.push(`  Agent: ${t.response}`);
              return parts.join("\n");
            })
            .filter(Boolean)
            .join("\n");
          if (!transcript) transcript = "No transcript available.";
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
    "Initiate an outbound phone call.\n\n" +
      "USE THIS TOOL WHEN the user wants to place a webhook-driven call where your backend " +
      "handles the conversation logic.\n" +
      "DO NOT USE when the user wants an autonomous AI conversation — use make_conversation_call instead.\n\n" +
      "The agent must have a phone number attached and a webhook configured (set_webhook).",
    {
      agent_id: z
        .string()
        .describe("The agent ID (must have a phone number attached — use list_agents to check)"),
      to_number: z
        .string()
        .describe("Recipient phone number in E.164 format (e.g. +14155551234)"),
      initial_greeting: z
        .string()
        .optional()
        .describe("What the agent says when the call connects"),
      from_number_id: z
        .string()
        .optional()
        .describe("Specific phone number ID to call from (if agent has multiple numbers)"),
      voice: z
        .string()
        .optional()
        .describe("Voice ID override for this call (use list_voices to see options)"),
    },
    { openWorldHint: true },
    async ({ agent_id, to_number, initial_greeting, from_number_id, voice }) => {
      const phoneErr = validateE164(to_number);
      if (phoneErr) return err(new Error(phoneErr));

      try {
        const result = await api.makeCall(
          agent_id,
          to_number,
          initial_greeting,
          from_number_id,
          voice,
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
    "Place a phone call where the AI has an autonomous conversation about a given topic.\n\n" +
      "USE THIS TOOL WHEN the user wants an AI agent to call someone and have a conversation — " +
      "scheduling, surveys, follow-ups, etc. No webhook setup needed.\n" +
      "DO NOT USE when the user wants a webhook-driven call (use make_call instead).\n\n" +
      "The agent must have a phone number attached. Use list_agents to check.\n" +
      "By default this blocks until the call finishes and returns the full transcript. " +
      "Set wait=false for fire-and-forget.",
    {
      agent_id: z
        .string()
        .describe("The agent ID (must have a phone number attached)"),
      to_number: z
        .string()
        .describe("Recipient phone number in E.164 format (e.g. +14155551234)"),
      topic: z.string().describe(
        "The conversation topic or instructions. This becomes the AI's system prompt. " +
          "Be specific about what the AI should discuss, its personality, and any goals."
      ),
      initial_greeting: z
        .string()
        .optional()
        .describe("What the AI says when the call connects. If not set, the AI will generate one from the topic."),
      wait: z
        .boolean()
        .default(true)
        .describe("When true (default), blocks until the call ends and returns the full transcript."),
      max_wait_seconds: z
        .number()
        .min(10)
        .max(600)
        .default(300)
        .describe("Maximum seconds to wait for the call to complete. Defaults to 300 (5 minutes)."),
      from_number_id: z
        .string()
        .optional()
        .describe("Specific phone number ID to call from (if agent has multiple numbers)"),
      voice: z
        .string()
        .optional()
        .describe("Voice ID override for this call (use list_voices to see options)"),
    },
    { openWorldHint: true },
    async ({ agent_id, to_number, topic, initial_greeting, wait, max_wait_seconds, from_number_id, voice }) => {
      const phoneErr = validateE164(to_number);
      if (phoneErr) return err(new Error(phoneErr));

      try {
        const result = await api.makeConversationCall(
          agent_id,
          to_number,
          topic,
          initial_greeting,
          wait,
          max_wait_seconds,
          from_number_id,
          voice
        );

        if (wait && result.transcripts && result.transcripts.length > 0) {
          const transcript = result.transcripts
            .map((t) => {
              const parts: string[] = [];
              if (t.transcript) parts.push(`  Human: ${t.transcript}`);
              if (t.response) parts.push(`  Agent: ${t.response}`);
              return parts.join("\n");
            })
            .filter(Boolean)
            .join("\n");

          if (transcript) {
            return ok(
              [
                `Call completed!`,
                `  From: ${result.fromNumber}`,
                `  To: ${result.toNumber}`,
                `  Call ID: ${result.id}`,
                `  Status: ${result.status}`,
                result.endedAt ? `  Ended: ${result.endedAt}` : null,
                ``,
                `Transcript:`,
                transcript,
              ]
                .filter(Boolean)
                .join("\n")
            );
          }
        }

        return ok(
          [
            `Conversation call initiated!`,
            `  From: ${result.fromNumber}`,
            `  To: ${result.toNumber}`,
            `  Call ID: ${result.id}`,
            `  Status: ${result.status}`,
            ``,
            wait
              ? `Call ended but no transcript was recorded.`
              : `The AI will have an autonomous conversation about the topic you provided.\nUse get_call with the call ID to check the transcript once the call ends.`,
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
    { readOnlyHint: true, idempotentHint: true },
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
    "Create a new agent. An agent owns phone numbers and handles calls/SMS.\n\n" +
      "After creating, use buy_number or attach_number to give it a phone number.\n" +
      "Set voice_mode to 'hosted' with a system_prompt for autonomous AI voice calls, " +
      "or 'webhook' (default) to forward call transcripts to your webhook URL.\n" +
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
        .describe("Voice ID for the agent (use list_voices to see options). Defaults to 'Skylar - Friendly Guide'."),
      model_tier: z
        .enum(["turbo", "balanced", "max"])
        .optional()
        .describe(
          "Model quality/speed tier for hosted-mode agents. " +
            "'turbo' = fastest/cheapest, 'balanced' (default) = general use, 'max' = highest quality."
        ),
      transfer_number: z
        .string()
        .optional()
        .describe("Phone number to transfer calls to (E.164 format). Enables call transfer during conversations."),
      voicemail_message: z
        .string()
        .optional()
        .describe("Voicemail greeting text. When set, unanswered calls hear this message and can leave a voicemail."),
      voice_speed: z
        .number()
        .min(0.5)
        .max(2)
        .optional()
        .describe("Speech speed multiplier. 1.0 = normal, 0.5 = half speed, 2.0 = double."),
      interruption_sensitivity: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("How easily callers can interrupt (barge in). 0 = never, 1 = at first sound. Default 0.8."),
      enable_backchannel: z
        .boolean()
        .optional()
        .describe("Whether the agent interjects 'uh-huh'/'mhmm' while the caller speaks. Default true."),
      enable_messaging: z
        .boolean()
        .optional()
        .describe("Whether a hosted agent can send and read texts during a call. Default true."),
      stt_mode: z
        .enum(["fast", "accurate"])
        .optional()
        .describe("Speech-to-text mode: 'fast' (default) lowest latency, 'accurate' for exact names/numbers (~200ms slower)."),
      ambient_sound: z
        .enum(["none", "office", "coffee-shop", "outdoor"])
        .optional()
        .describe("Background ambience to mask synthetic silence between turns."),
      denoising_mode: z
        .enum(["noise-cancellation", "noise-and-background-speech-cancellation"])
        .optional()
        .describe("Audio denoising. The aggressive mode helps callers in cars/cafes (small surcharge)."),
      max_silence_ms: z
        .number()
        .min(10000)
        .max(3600000)
        .optional()
        .describe("Hang up after this many ms of caller silence. Default 600000 (10 min)."),
      language: z
        .string()
        .optional()
        .describe("BCP-47 locale for speech recognition and synthesis, e.g. 'en-US', 'es-ES', 'ja-JP'."),
    },
    async ({ name, description, voice_mode, system_prompt, begin_message, voice, model_tier, transfer_number, voicemail_message, voice_speed, interruption_sensitivity, enable_backchannel, enable_messaging, stt_mode, ambient_sound, denoising_mode, max_silence_ms, language }) => {
      if (transfer_number) {
        const phoneErr = validateE164(transfer_number);
        if (phoneErr) return err(new Error(phoneErr));
      }

      try {
        const result = await api.createAgent({
          name,
          description,
          voiceMode: voice_mode,
          systemPrompt: system_prompt,
          beginMessage: begin_message,
          voice,
          modelTier: model_tier,
          transferNumber: transfer_number,
          voicemailMessage: voicemail_message,
          voiceSpeed: voice_speed,
          interruptionSensitivity: interruption_sensitivity,
          enableBackchannel: enable_backchannel,
          enableMessaging: enable_messaging,
          sttMode: stt_mode,
          ambientSound: ambient_sound,
          denoisingMode: denoising_mode,
          maxSilenceMs: max_silence_ms,
          language,
        });
        return ok(
          `Agent created!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n  Model Tier: ${result.modelTier}\n\n${JSON.stringify(result, null, 2)}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "update_agent",
    "Update an agent's configuration — name, description, voice settings, system prompt, greeting, " +
      "call transfer, or voicemail. Only provided fields are updated.\n" +
      "Use list_voices to see available voice IDs. Switching voice_mode to 'hosted' requires a system_prompt.",
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
      model_tier: z
        .enum(["turbo", "balanced", "max"])
        .optional()
        .describe(
          "Model quality/speed tier for hosted-mode agents. " +
            "'turbo' = fastest/cheapest, 'balanced' = general use, 'max' = highest quality."
        ),
      transfer_number: z
        .string()
        .optional()
        .describe("Phone number to transfer calls to (E.164 format), or empty string to remove."),
      voicemail_message: z
        .string()
        .optional()
        .describe("Voicemail greeting text, or empty string to disable voicemail."),
      voice_speed: z
        .number()
        .min(0.5)
        .max(2)
        .optional()
        .describe("Speech speed multiplier. 1.0 = normal, 0.5 = half speed, 2.0 = double."),
      interruption_sensitivity: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("How easily callers can interrupt (barge in). 0 = never, 1 = at first sound. Default 0.8."),
      enable_backchannel: z
        .boolean()
        .optional()
        .describe("Whether the agent interjects 'uh-huh'/'mhmm' while the caller speaks. Default true."),
      enable_messaging: z
        .boolean()
        .optional()
        .describe("Whether a hosted agent can send and read texts during a call. Default true."),
      stt_mode: z
        .enum(["fast", "accurate"])
        .optional()
        .describe("Speech-to-text mode: 'fast' lowest latency, 'accurate' for exact names/numbers (~200ms slower)."),
      ambient_sound: z
        .enum(["none", "office", "coffee-shop", "outdoor"])
        .optional()
        .describe("Background ambience to mask synthetic silence between turns."),
      denoising_mode: z
        .enum(["noise-cancellation", "noise-and-background-speech-cancellation"])
        .optional()
        .describe("Audio denoising. The aggressive mode helps callers in cars/cafes (small surcharge)."),
      max_silence_ms: z
        .number()
        .min(10000)
        .max(3600000)
        .optional()
        .describe("Hang up after this many ms of caller silence. Default 600000 (10 min)."),
      language: z
        .string()
        .optional()
        .describe("BCP-47 locale for speech recognition and synthesis, e.g. 'en-US', 'es-ES', 'ja-JP'."),
    },
    { idempotentHint: true },
    async ({ agent_id, name, description, voice_mode, system_prompt, begin_message, voice, model_tier, transfer_number, voicemail_message, voice_speed, interruption_sensitivity, enable_backchannel, enable_messaging, stt_mode, ambient_sound, denoising_mode, max_silence_ms, language }) => {
      if (transfer_number) {
        const phoneErr = validateE164(transfer_number);
        if (phoneErr) return err(new Error(phoneErr));
      }

      try {
        const params: Parameters<typeof api.updateAgent>[1] = {};
        if (name !== undefined) params.name = name;
        if (description !== undefined) params.description = description;
        if (voice_mode !== undefined) params.voiceMode = voice_mode;
        if (system_prompt !== undefined) params.systemPrompt = system_prompt;
        if (begin_message !== undefined) params.beginMessage = begin_message;
        if (voice !== undefined) params.voice = voice;
        if (model_tier !== undefined) params.modelTier = model_tier;
        if (transfer_number !== undefined) params.transferNumber = transfer_number;
        if (voicemail_message !== undefined) params.voicemailMessage = voicemail_message;
        if (voice_speed !== undefined) params.voiceSpeed = voice_speed;
        if (interruption_sensitivity !== undefined) params.interruptionSensitivity = interruption_sensitivity;
        if (enable_backchannel !== undefined) params.enableBackchannel = enable_backchannel;
        if (enable_messaging !== undefined) params.enableMessaging = enable_messaging;
        if (stt_mode !== undefined) params.sttMode = stt_mode;
        if (ambient_sound !== undefined) params.ambientSound = ambient_sound;
        if (denoising_mode !== undefined) params.denoisingMode = denoising_mode;
        if (max_silence_ms !== undefined) params.maxSilenceMs = max_silence_ms;
        if (language !== undefined) params.language = language;

        const result = await api.updateAgent(agent_id, params);
        return ok(
          `Agent updated!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n  Model Tier: ${result.modelTier}\n\n${JSON.stringify(result, null, 2)}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_agent",
    "Delete an agent permanently. Phone numbers attached to it will be kept but unassigned.\n\n" +
      "DO NOT USE without confirming with the user — this cannot be undone.",
    {
      agent_id: z.string().describe("The agent ID to delete"),
    },
    { destructiveHint: true },
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
    { readOnlyHint: true, idempotentHint: true },
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
    { idempotentHint: true },
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
    "detach_number",
    "Detach a phone number from an agent. The number is kept in your account but becomes unassigned. " +
      "Use list_agents or get_agent to see which numbers are attached.",
    {
      agent_id: z.string().describe("The agent ID that currently owns the number"),
      number_id: z.string().describe("The phone number ID to detach"),
    },
    { idempotentHint: true },
    async ({ agent_id, number_id }) => {
      try {
        await api.detachNumber(agent_id, number_id);
        return ok(`Detached number ${number_id} from agent ${agent_id}`);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_voices",
    "List available voices for agents. Use the voice_id value when calling create_agent or update_agent.",
    {},
    { readOnlyHint: true, idempotentHint: true },
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
    "List SMS conversations. Optionally filter by agent_id to see conversations for a specific agent.\n\n" +
      "Each conversation is a thread between your number and an external contact. " +
      "Use get_conversation with the ID to read messages.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Filter to conversations for a specific agent"),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
      offset: z
        .number()
        .min(0)
        .default(0)
        .describe("Number of results to skip (for pagination)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id, limit, offset }) => {
      try {
        const result = agent_id
          ? await api.listAgentConversations(agent_id, limit, offset)
          : await api.listConversations(limit, offset);

        if (result.data.length === 0) {
          return ok("No conversations found.");
        }

        const formatted = result.data
          .map((c) => {
            const preview = c.lastMessagePreview
              ? ` "${c.lastMessagePreview.slice(0, 80)}${c.lastMessagePreview.length > 80 ? "…" : ""}"`
              : "";
            return `${c.participant} ↔ ${c.phoneNumber} (${c.messageCount} msgs, last: ${c.lastMessageAt || "never"})${preview} id=${c.id}`;
          })
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
    { readOnlyHint: true, idempotentHint: true },
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
            result.metadata ? `Metadata: ${JSON.stringify(result.metadata)}` : null,
            `\n${messages}`,
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
    "update_conversation",
    "Set metadata on a conversation. Use this to store custom state, tags, or context " +
      "that persists between messages. Pass null to clear metadata.",
    {
      conversation_id: z.string().describe("The conversation ID"),
      metadata: z
        .record(z.unknown())
        .nullable()
        .describe("JSON metadata object to store on the conversation, or null to clear"),
    },
    { idempotentHint: true },
    async ({ conversation_id, metadata }) => {
      try {
        const result = await api.updateConversation(conversation_id, metadata);
        return ok(
          `Conversation updated.\n  ID: ${result.id}\n  Metadata: ${JSON.stringify(result.metadata)}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Contacts
  // ============================================================

  server.tool(
    "list_contacts",
    "List saved contacts (your address book). Optionally filter with a search term that matches " +
      "name or phone number.",
    {
      search: z.string().optional().describe("Filter by name or phone number"),
      limit: z.number().min(1).max(100).default(50).describe("Max results to return"),
      offset: z.number().min(0).default(0).describe("Number of results to skip (for pagination)"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ search, limit, offset }) => {
      try {
        const result = await api.listContacts(limit, offset, search);
        if (result.data.length === 0) return ok("No contacts found.");
        const formatted = result.data
          .map((c) => `${c.name} — ${c.phoneNumber}${c.email ? ` <${c.email}>` : ""} id=${c.id}`)
          .join("\n");
        return ok(`${result.data.length} contact(s):\n\n${formatted}\n\nTotal: ${result.total}`);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "manage_contact",
    "Create, update, or delete a saved contact. Set `action` to choose the operation.\n\n" +
      "- create: requires phone_number and name\n" +
      "- update: requires contact_id; only the fields you pass are changed\n" +
      "- delete: requires contact_id (permanent — confirm with the user first)\n\n" +
      "Use list_contacts to find contact IDs.",
    {
      action: z
        .enum(["create", "update", "delete"])
        .describe("The operation to perform"),
      contact_id: z
        .string()
        .optional()
        .describe("Contact ID. Required for 'update' and 'delete'."),
      phone_number: z
        .string()
        .optional()
        .describe("Phone number in E.164 format (e.g. +14155551234). Required for 'create'."),
      name: z.string().optional().describe("Contact name. Required for 'create'."),
      email: z.string().email().optional().describe("Contact email address"),
      notes: z.string().optional().describe("Freeform notes about the contact"),
    },
    { destructiveHint: true },
    async ({ action, contact_id, phone_number, name, email, notes }) => {
      if (phone_number) {
        const phoneErr = validateE164(phone_number);
        if (phoneErr) return err(new Error(phoneErr));
      }
      try {
        if (action === "create") {
          if (!phone_number || !name) {
            return err(new Error("create requires both phone_number and name."));
          }
          const result = await api.createContact({ phoneNumber: phone_number, name, email, notes });
          return ok(`Contact created: ${result.name} (${result.phoneNumber}) id=${result.id}`);
        }

        if (action === "update") {
          if (!contact_id) return err(new Error("update requires contact_id."));
          const params: { phoneNumber?: string; name?: string; email?: string; notes?: string } = {};
          if (phone_number !== undefined) params.phoneNumber = phone_number;
          if (name !== undefined) params.name = name;
          if (email !== undefined) params.email = email;
          if (notes !== undefined) params.notes = notes;
          const result = await api.updateContact(contact_id, params);
          return ok(`Contact updated: ${result.name} (${result.phoneNumber}) id=${result.id}`);
        }

        // action === "delete"
        if (!contact_id) return err(new Error("delete requires contact_id."));
        await api.deleteContact(contact_id);
        return ok(`Contact ${contact_id} deleted.`);
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
    "Get account usage statistics. By default returns a summary with plan limits, quotas, and " +
      "message/call volume. Use breakdown='daily' or 'monthly' for time-series data.",
    {
      breakdown: z
        .enum(["summary", "daily", "monthly"])
        .default("summary")
        .describe("'summary' for plan limits and totals, 'daily' for per-day breakdown, 'monthly' for per-month breakdown"),
      days: z
        .number()
        .min(1)
        .max(365)
        .default(30)
        .describe("Number of days to look back (only used with breakdown='daily')"),
      months: z
        .number()
        .min(1)
        .max(24)
        .default(12)
        .describe("Number of months to look back (only used with breakdown='monthly')"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ breakdown, days, months }) => {
      try {
        if (breakdown === "daily") {
          const result = await api.getDailyUsage(days);
          if (result.data.length === 0) {
            return ok("No usage data for this period.");
          }
          const formatted = result.data
            .map(
              (d) => `${d.date}: ${d.messages} msgs, ${d.calls} calls, ${d.voiceMinutes} voice min`
            )
            .join("\n");
          return ok(`Daily usage (last ${days} days):\n\n${formatted}`);
        }

        if (breakdown === "monthly") {
          const result = await api.getMonthlyUsage(months);
          if (result.data.length === 0) {
            return ok("No usage data for this period.");
          }
          const formatted = result.data
            .map(
              (d) => `${d.month}: ${d.messages} msgs, ${d.calls} calls, ${d.voiceMinutes} voice min`
            )
            .join("\n");
          return ok(`Monthly usage (last ${months} months):\n\n${formatted}`);
        }

        // Default: summary
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
  // Webhooks (project-level and per-agent)
  //
  // Pass agent_id to scope to a specific agent's webhook.
  // Omit agent_id to manage the project-level default webhook.
  // Agent-level webhooks take priority over project-level.
  // ============================================================

  server.tool(
    "get_webhook",
    "Get the webhook configuration. Pass agent_id to get an agent-specific webhook, " +
      "or omit for the project-level default.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to get that agent's webhook. Omit for project-level webhook."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id }) => {
      try {
        const result = agent_id
          ? await api.getAgentWebhook(agent_id)
          : await api.getWebhook();
        if (!result) {
          return ok(
            agent_id
              ? "No agent-specific webhook configured. Events go to the project-level webhook."
              : "No webhook configured."
          );
        }
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "set_webhook",
    "Set a webhook URL to receive inbound messages and call events.\n\n" +
      "Pass agent_id to set a webhook for a specific agent (overrides project default). " +
      "Omit agent_id to set the project-level webhook for all agents.\n" +
      "The webhook secret is returned — use it to verify signatures.",
    {
      url: z
        .string()
        .url()
        .describe("The publicly accessible webhook URL (must be HTTPS in production)"),
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to set webhook for that agent only. Omit for project-level."),
      context_limit: z
        .number()
        .min(0)
        .max(50)
        .optional()
        .describe("Number of recent messages to include as conversation context (0-50)"),
      timeout: z
        .number()
        .optional()
        .describe("Webhook response timeout in seconds"),
    },
    { idempotentHint: true },
    async ({ url, agent_id, context_limit, timeout }) => {
      try {
        const result = agent_id
          ? await api.setAgentWebhook(agent_id, url, context_limit, timeout)
          : await api.setWebhook(url, context_limit, timeout);
        const scope = agent_id ? `Agent ${agent_id}` : "Project";
        return ok(
          `${scope} webhook set!\n  URL: ${result.url}\n  Secret: ${result.secret}\n  Status: ${result.status}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_webhook",
    "Remove a webhook. Pass agent_id to remove an agent's webhook (falls back to project default). " +
      "Omit agent_id to remove the project-level webhook.\n\n" +
      "DO NOT USE without confirming with the user.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to delete that agent's webhook. Omit for project-level."),
    },
    { destructiveHint: true },
    async ({ agent_id }) => {
      try {
        if (agent_id) {
          await api.deleteAgentWebhook(agent_id);
          return ok("Agent webhook deleted. Events will now go to the project-level webhook.");
        }
        await api.deleteWebhook();
        return ok("Project webhook deleted.");
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "test_webhook",
    "Send a test event to verify a webhook is working. Returns the HTTP status code and response time.\n\n" +
      "Pass agent_id to test that agent's webhook. Omit to test the project-level webhook.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to test that agent's webhook. Omit for project-level."),
    },
    { idempotentHint: true, openWorldHint: true },
    async ({ agent_id }) => {
      try {
        const result = agent_id
          ? await api.testAgentWebhook(agent_id)
          : await api.testWebhook();
        const scope = agent_id ? "Agent webhook" : "Webhook";
        if (result.success) {
          return ok(
            `${scope} test successful!\n  Status code: ${result.statusCode}\n  Response time: ${result.responseMs}ms`
          );
        }
        return ok(
          `${scope} test failed.\n  Error: ${result.error}\n  Status code: ${result.statusCode}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_webhook_deliveries",
    "View recent webhook delivery history. Shows which events were delivered, HTTP status codes, and timing.\n\n" +
      "Pass agent_id to see deliveries for that agent's webhook. Omit for project-level.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to see deliveries for that agent's webhook. Omit for project-level."),
      limit: z
        .number()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max results to return"),
      hours: z
        .number()
        .min(1)
        .optional()
        .describe("Only show deliveries from the last N hours"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id, limit, hours }) => {
      try {
        const result = agent_id
          ? await api.listAgentWebhookDeliveries(agent_id, limit, hours)
          : await api.listWebhookDeliveries(limit, hours);

        if (result.data.length === 0) {
          return ok("No webhook deliveries found.");
        }

        const formatted = result.data
          .map(
            (d) =>
              `[${d.deliveredAt}] ${d.event} → ${d.success ? "OK" : "FAILED"} (${d.statusCode ?? "N/A"}, ${d.responseMs ?? "N/A"}ms) id=${d.id}`
          )
          .join("\n");

        return ok(
          `${result.data.length} delivery(ies):\n\n${formatted}\n\nTotal: ${result.total}`
        );
      } catch (e) {
        return err(e);
      }
    }
  );
}
