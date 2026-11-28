/**
 * AgentPhone MCP Tool Registrations
 *
 * MCP tools with ToolAnnotations, input validation, and actionable errors.
 */

import { z } from "zod";
import { AgentPhoneAPI, ApiError, withSubAccount } from "./api.js";
import { watchNumber, WATCH_TTL, WATCH_TTL_SECONDS } from "./wakeshift.js";
import type { WatchRegistrar } from "./backend-watches.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
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

/**
 * Webhook signing secrets only exist to verify signatures on the receiving
 * server. Tool output lands in model context, chat transcripts and client logs,
 * so a signing secret is never returned through a tool: it is always masked to
 * its conventional type prefix, and the full value lives only in the dashboard.
 */
function maskSecret(secret: string): string {
  if (!secret) return secret;
  // Preserve only the conventional, non-secret type prefix. Never expose
  // arbitrary secret bytes or its length, including for short secrets.
  const prefix = secret.startsWith("whsec_") && secret.length > 6 ? "whsec_" : "";
  return `${prefix}•••••• (hidden; retrieve it from the AgentPhone dashboard)`;
}

// A successful tool result. `structuredContent` is the machine-readable form of
// the same result, validated against the tool's output schema by the MCP SDK;
// it mirrors the text so clients can read fields directly. Error results go
// through err() and carry no structured content (the SDK exempts them).
function ok(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return structuredContent !== undefined
    ? { content: [{ type: "text", text }], structuredContent }
    : { content: [{ type: "text", text }] };
}

function err(error: unknown): ToolResult {
  if (error instanceof ApiError) {
    const base = error.detail;
    let hint = "";
    switch (error.status) {
      case 0:
        // A timeout on a non-GET is an ambiguous mutation: the server may or may
        // not have applied it, so never advise a blind retry (it could duplicate
        // a send, charge or create). Reads are safe to retry.
        hint =
          error.method !== "GET"
            ? " The request timed out, so the outcome is UNKNOWN — the action may or may not have" +
              " taken effect. Do NOT blindly retry, which could duplicate it. Check the current" +
              " state first (e.g. the matching list_* or get_* tool), then retry only if it did" +
              " not apply."
            : " Request timed out — retry, or pass a longer timeout if the tool supports one.";
        break;
      case 401:
        hint = " The supplied credential was rejected. Check the bearer token (HTTP) or AGENTPHONE_API_KEY (stdio).";
        break;
      case 404:
        hint = notFoundHint(error.path);
        break;
      case 429:
        hint = error.retryAfter
          ? ` Rate limited — wait ${error.retryAfter} (per Retry-After) before trying again.`
          : " Rate limited — wait a moment and try again.";
        break;
    }
    return { content: [{ type: "text", text: base + hint }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

// Where to look up a valid ID after a 404, chosen from the most specific
// resource in the path. A path like /v1/agents/A/numbers/N names two IDs, and
// the one most likely missing is the last: matching "/agents/" first used to
// send a bad number_id, or an agent with no webhook of its own, to list_agents.
// Routes that sit under an ID-taking collection but carry no ID themselves; a
// 404 there isn't a bad ID, so no lookup hint applies.
const FIXED_ROUTES = new Set(["/v1/agents/voices", "/v1/contacts/capabilities"]);

function notFoundHint(path: string): string {
  const p = path.split("?")[0];
  if (FIXED_ROUTES.has(p)) return "";
  if (/^\/v1\/agents\/[^/]+\/webhook(\/|$)/.test(p))
    return " Use get_webhook with this agent_id to check whether the agent has its own webhook, and list_agents to confirm the agent ID.";
  if (/^\/v1\/webhooks(\/|$)/.test(p))
    return " Use get_webhook to check whether a webhook is configured.";
  if (/^\/v1\/agents\/[^/]+\/numbers\/[^/]+$/.test(p))
    return " Use get_agent to see which numbers are attached to this agent, and list_numbers for valid number IDs.";
  // attach_number sends the number ID in the body, so either ID may be the bad one.
  if (/^\/v1\/agents\/[^/]+\/numbers$/.test(p))
    return " Use list_agents to confirm the agent ID, and list_numbers for valid number IDs.";
  if (p.startsWith("/v1/messages/"))
    return " Use get_messages or get_conversation_messages to find a valid message ID.";
  if (p.startsWith("/v1/contacts/"))
    return " Use list_contacts to see valid contact IDs.";
  if (p.startsWith("/v1/agents/")) return " Use list_agents to see valid agent IDs.";
  if (p.startsWith("/v1/numbers/")) return " Use list_numbers to see valid number IDs.";
  if (p.startsWith("/v1/calls/")) return " Use list_calls to see recent call IDs.";
  if (p.startsWith("/v1/conversations/"))
    return " Use list_conversations to see valid conversation IDs.";
  return "";
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


// Per-action user authorization. Outbound actions that contact other people
// (place a call, send a message) require confirm=true; without it the tool returns
// a preview of exactly what will happen so the user can approve it first. Mirrors
// buy_number's two-step pattern.
function confirmField() {
  return {
    confirm: z
      .boolean()
      .default(false)
      .describe(
        "Must be true to actually place the call / send the message. When false (the default), the " +
          "tool returns a preview and does nothing — every outbound call and message is individually " +
          "authorized by the user. Get the user's explicit go-ahead, then call again with the same " +
          "arguments plus confirm=true."
      ),
  };
}

function confirmationPreview(summary: string): ToolResult {
  return ok(
    `${summary}\n\nThis acts on the user's behalf and contacts someone. Confirm with the user first, then ` +
      "call again with the SAME arguments plus confirm=true.",
    { confirmationRequired: true }
  );
}


// Shared cursor-pagination inputs for message history. `cursor` is the primary
// way to reach older pages (it survives identical timestamps); before/after are
// optional time filters, and the backend ignores them when a cursor is present.
function cursorInputs() {
  return {
    before: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Optional time filter: only messages before this ISO 8601 timestamp. Ignored when cursor is set."),
    after: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("Optional time filter: only messages after this ISO 8601 timestamp. Ignored when cursor is set."),
    cursor: z
      .string()
      .min(1)
      .optional()
      .describe("Opaque nextCursor from a previous page; the reliable way to fetch the next page. Takes precedence over before/after."),
  };
}

// Continuation footer for a cursor-paged message result. The backend returns a
// nextCursor whenever hasMore is true; the no-cursor branch is a defensive
// fallback, not the normal path.
function pageFooter(
  result: { hasMore: boolean; nextCursor?: string | null },
  continueHint: string
): string {
  if (!result.hasMore) return "";
  return result.nextCursor
    ? `\n\nMore available. ${continueHint} cursor=${JSON.stringify(result.nextCursor)} to fetch the next page.`
    : "\n\nMore results exist, but the API did not return a next cursor. Narrow the range with before/after; note that time filters can omit messages that share a page boundary.";
}

// Optional per-call controls shared by make_call and make_conversation_call,
// forwarded to POST /v1/calls. Each is omitted from the request when unset so the
// backend default stands.
function callControlInputs() {
  return {
    disable_recording: z
      .boolean()
      .optional()
      .describe("Set true to disable call recording for this call. If omitted, the account/agent default applies."),
    variables: z
      .record(z.string(), z.string())
      .optional()
      .describe("Dynamic string variables made available to the call (e.g. {\"customerName\":\"Sam\"})."),
    model_tier: z
      .enum(["turbo", "balanced", "max", "realtime"])
      .optional()
      .describe("Override the model quality/speed tier for just this call. If omitted, the agent's tier is used."),
    call_screening_identity: z
      .string()
      .optional()
      .describe("Identity to present if the callee's carrier screens the call (e.g. your business name)."),
    call_screening_purpose: z
      .string()
      .optional()
      .describe("Stated purpose to present to call screening (e.g. 'appointment reminder')."),
  };
}

// Map the snake_case tool inputs to the API client's CallControls shape, leaving
// unset fields undefined so they are not forwarded.
function buildCallControls(args: {
  disable_recording?: boolean;
  variables?: Record<string, string>;
  model_tier?: string;
  call_screening_identity?: string;
  call_screening_purpose?: string;
}) {
  return {
    disableRecording: args.disable_recording,
    variables: args.variables,
    modelTier: args.model_tier,
    callScreeningIdentity: args.call_screening_identity,
    callScreeningPurpose: args.call_screening_purpose,
  };
}

// Every tool except list_sub_accounts accepts an optional sub_account_id. When
// set, the call acts on that sub-account instead of the authenticated account:
// each API request carries X-Sub-Account-Id, and the backend checks the caller
// is the sub-account's parent (403 otherwise). Added here, in one place, so no
// tool can be registered without it.
const SUB_ACCOUNT_EXEMPT = new Set(["list_sub_accounts"]);

function subAccountField() {
  return {
    sub_account_id: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Act on this sub-account instead of the main account. Use an ID from list_sub_accounts. " +
          "Omit to act on the main account. IDs returned while acting on a sub-account (agents, " +
          "numbers, calls, conversations) belong to it, so pass the same sub_account_id when using them."
      ),
  };
}

export function withSubAccountOption(server: ToolRegistrar): ToolRegistrar {
  return {
    tool(
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      annotationsOrHandler: Record<string, unknown> | ((args: any) => Promise<ToolResult>),
      maybeHandler?: (args: any) => Promise<ToolResult>
    ): void {
      const hasAnnotations = typeof annotationsOrHandler !== "function";
      const handler = (hasAnnotations ? maybeHandler : annotationsOrHandler) as (args: any) => Promise<ToolResult>;
      if (SUB_ACCOUNT_EXEMPT.has(name)) {
        if (hasAnnotations) server.tool(name, description, schema, annotationsOrHandler, handler);
        else server.tool(name, description, schema, handler);
        return;
      }
      const scoped = async (args: any) => {
        const { sub_account_id, ...rest } = args ?? {};
        const result = await withSubAccount(sub_account_id, () => handler(rest));
        // Confirmation previews tell the agent to retry "with the SAME
        // arguments plus confirm=true", but the handler never saw
        // sub_account_id, so its suggested arguments omit it — and a retry
        // without it acts on the PARENT account (for buy_number, a purchase on
        // the wrong tenant). Re-attach the scope to the preview here.
        const structured = result?.structuredContent as Record<string, unknown> | undefined;
        if (sub_account_id && !result?.isError && structured?.confirmationRequired === true) {
          const texts = result.content ?? [];
          const last = texts[texts.length - 1];
          if (last?.type === "text") {
            last.text += `\n\nThis preview is scoped to sub-account ${sub_account_id}: the confirming call MUST include sub_account_id="${sub_account_id}" too, or it will act on the main account.`;
          }
          result.structuredContent = { ...structured, sub_account_id };
        }
        return result;
      };
      const scopedSchema = { ...schema, ...subAccountField() };
      if (hasAnnotations) server.tool(name, description, scopedSchema, annotationsOrHandler, scoped);
      else server.tool(name, description, scopedSchema, scoped);
    },
  } as ToolRegistrar;
}

/**
 * watchMessages: offer watch_messages, and have send_message's result point to
 * it. Only when Wakeshift is on and the AgentPhone backend pushes inbound
 * messages (HTTP transport); see index.ts.
 */
export function registerTools(
  registrar: ToolRegistrar,
  api: AgentPhoneAPI,
  opts: { watchMessages?: boolean; registerWatch?: WatchRegistrar } = {}
): void {
  const server = withSubAccountOption(registrar);

  // ============================================================
  // Account Overview
  // ============================================================

  server.tool(
    "account_overview",
    "Get a complete snapshot of your AgentPhone account: agents, phone numbers, webhook status, " +
      "and usage limits.",
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

        // When every section fails, don't return a success-looking empty
        // overview — surface it as an error so it isn't mistaken for an empty
        // account. (Partial failures are still reported inline below.)
        if (results.every((r) => r.status === "rejected")) {
          const reason = (results[0] as PromiseRejectedResult).reason;
          // Preserve the original error so err() keeps its ApiError status hints
          // (401 credential, 429 rate limit, timeout), rather than flattening it.
          return reason instanceof ApiError
            ? err(reason)
            : err(
                new Error(
                  "Account overview failed: every lookup errored (agents, numbers, webhook, usage). " +
                    (reason instanceof Error ? reason.message : String(reason))
                )
              );
        }

        const agents = results[0].status === "fulfilled" ? results[0].value : null;
        const numbers = results[1].status === "fulfilled" ? results[1].value : null;
        const webhook = results[2].status === "fulfilled" ? results[2].value : null;
        const usage = results[3].status === "fulfilled" ? results[3].value : null;

        // Per-section load status, so a partially-failed overview is explicit in
        // structured output (not silently missing data).
        const sectionStatus = {
          agents: results[0].status === "fulfilled" ? "ok" : "failed",
          numbers: results[1].status === "fulfilled" ? "ok" : "failed",
          webhook: results[2].status === "fulfilled" ? "ok" : "failed",
          usage: results[3].status === "fulfilled" ? "ok" : "failed",
        };

        // The overview loads only the first page (100) of agents and numbers.
        // Report whether that page is complete so a large account is never
        // silently truncated; list_agents / list_numbers page through the rest.
        const OVERVIEW_PAGE = 100;
        const sectionTruncation = (
          section: { data: unknown[]; total?: number } | null
        ) =>
          section
            ? {
                returned: section.data.length,
                total: section.total ?? section.data.length,
                hasMore: (section.total ?? section.data.length) > section.data.length,
              }
            : null;
        const truncation = {
          agents: sectionTruncation(agents),
          numbers: sectionTruncation(numbers),
        };

        const sections: string[] = [];

        sections.push(`=== Account Overview ===`);
        if (usage) {
          sections.push(
            `Phone Numbers: ${usage.numbers.used}/${usage.numbers.limit} used (${usage.numbers.remaining} remaining)`
          );
        } else {
          sections.push(`Usage: failed to load.`);
        }
        sections.push(``);

        if (agents) {
          if (agents.data.length > 0) {
            const t = truncation.agents;
            const header = t && t.hasMore
              ? `--- Agents (showing ${t.returned} of ${t.total}; use list_agents with offset for the rest) ---`
              : `--- Agents (${agents.data.length}) ---`;
            sections.push(header);
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
            const t = truncation.numbers;
            const header = t && t.hasMore
              ? `--- Phone Numbers (showing ${t.returned} of ${t.total}; use list_numbers with offset for the rest) ---`
              : `--- Phone Numbers (${numbers.data.length}) ---`;
            sections.push(header);
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

        return ok(sections.join("\n"), {
          sectionStatus,
          truncation,
          usage: usage?.numbers,
          agents: agents?.data,
          numbers: numbers?.data,
          webhook: webhook
            ? { url: webhook.url, status: webhook.status }
            : results[2].status === "fulfilled"
              ? null
              : undefined,
          recentActivity: usage
            ? {
                messagesLast30d: usage.stats.messagesLast30d,
                callsLast30d: usage.stats.callsLast30d,
              }
            : undefined,
        });
      } catch (e) {
        return err(e);
      }
    }
  );

  // ============================================================
  // Sub-accounts
  // ============================================================

  server.tool(
    "list_sub_accounts",
    "List the sub-accounts under your account. A sub-account has its own agents, numbers, " +
      "conversations, and calls, separate from the main account. To work in one, pass its ID as " +
      "sub_account_id to any other tool (e.g. account_overview, list_numbers, send_message). " +
      "Returns each sub-account's ID and name.",
    {
      limit: z
        .number().int().min(1).max(100)
        .default(50)
        .describe("How many sub-accounts to return in one page."),
      offset: z
        .number().int().min(0)
        .default(0)
        .describe("How many sub-accounts to skip before this page, for paging through a long list."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ limit, offset }) => {
      try {
        const result = await api.listSubAccounts(limit, offset);
        const hasMore = offset + result.data.length < result.total;
        const structured = { ...result, hasMore };
        const footer = hasMore
          ? `\n\nShowing ${offset + 1}-${offset + result.data.length} of ${result.total}. Call list_sub_accounts again with offset=${offset + result.data.length} for the next page.`
          : result.total === 0
            ? "\n\nThis account has no sub-accounts."
            : "";
        return ok(`${JSON.stringify(structured, null, 2)}${footer}`, structured);
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
    "List all phone numbers in your account. Returns each number with its ID, status, " +
      "country, and the agent it is assigned to (if any).",
    {
      limit: z
        .number().int().min(1).max(100)
        .default(20)
        .describe("How many numbers to return in one page."),
      offset: z
        .number().int().min(0)
        .default(0)
        .describe("How many numbers to skip before this page, for paging through a long list."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ limit, offset }) => {
      try {
        const result = await api.listNumbers(limit, offset);
        return ok(JSON.stringify(result, null, 2), result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "buy_number",
    "Purchase a new phone number. This is a paid purchase that charges the account's balance, " +
      "and requires confirm=true to actually go through. Returns the purchased number's details: " +
      "its phone number, ID, country, and status.",
    {
      country: z
        .string()
        .length(2)
        .default("US")
        .describe("The country to buy the number in, as an ISO country code (for example US or CA)."),
      area_code: z
        .string()
        .length(3)
        .optional()
        .describe(
          "A preferred area code so the number is local to a specific region (e.g. 415 for San " +
            "Francisco). Omit to accept any available area code."
        ),
      agent_id: z
        .string()
        .optional()
        .describe(
          "ID of an agent to attach the new number to right away (from list_agents or create_agent). " +
            "Omit to leave the number unassigned."
        ),
      confirm: z
        .boolean()
        .default(false)
        .describe("Must be true to complete the purchase. When false, no number is bought."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    async ({ country, area_code, agent_id, confirm }) => {
      const countryErr = validateCountry(country);
      if (countryErr) return err(new Error(countryErr));
      if (area_code) {
        const areaErr = validateAreaCode(area_code);
        if (areaErr) return err(new Error(areaErr));
      }
      if (!confirm) {
        const params = [
          `country="${country}"`,
          area_code ? `area_code="${area_code}"` : null,
          agent_id ? `agent_id="${agent_id}"` : null,
          `confirm=true`,
        ].filter(Boolean).join(", ");
        return ok(
          `This will purchase a new ${country} phone number${area_code ? ` in area code ${area_code}` : ""}` +
            `${agent_id ? ` and attach it to agent ${agent_id}` : ""}, charging the account's balance. ` +
            `Confirm with the user, then call buy_number again with the SAME arguments plus confirm=true: ${params}`,
          { confirmationRequired: true }
        );
      }

      try {
        const result = await api.buyNumber(country, agent_id, area_code);
        return ok(
          `Purchased number ${result.phoneNumber} (${result.country})\n\n${JSON.stringify(result, null, 2)}`,
          result
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
    "Send an SMS, iMessage, or WhatsApp message from one of your agent's phone numbers, or react to " +
      "an existing message.\n" +
      "Each message is individually authorized by the user: this returns a preview and sends nothing " +
      "unless confirm=true, so confirm the recipient(s) and content with the user before sending.\n" +
      "The tool has two modes, so which inputs are required depends on the mode:\n" +
      "- Send: give a destination and a sender (agent_id, from_number, or number_id), plus body " +
      "and/or media. The destination is either to_number (a single recipient or existing group) or " +
      "recipients (members of a NEW iMessage group) — exactly one. The agent must have a phone number " +
      "attached; number_id or from_number picks which one when it has several.\n" +
      "- React: set reaction and react_to_message_id (iMessage only) to tapback or emoji-react to " +
      "a message. Pass no send fields; those are rejected.\n" +
      "Channel: omit channel to auto-pick SMS/iMessage; set channel=whatsapp to force WhatsApp, which " +
      "also unlocks the interactive fields (buttons, list, cta, template — one per message, and a " +
      "template is needed to start a new WhatsApp conversation).\n" +
      "iMessage extras (ignored on SMS): reply_to_message_id threads a reply, and send_style adds an " +
      "expressive effect.\n" +
      "Returns the sent message (id, status, channel, from/to numbers), or the applied reaction.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("The agent ID to send a message from (must have a phone number attached). Optional with from_number or number_id; omit for reactions."),
      to_number: z
        .string()
        .optional()
        .describe("Recipient: a phone number in E.164 format (e.g. +14155551234), a US short code, or a group ID (grp_...) to post into an EXISTING iMessage group chat. Give either to_number or recipients, not both. Not needed for a reaction."),
      recipients: z
        .array(z.string())
        .optional()
        .describe("Create a NEW iMessage group and send to these members (phone numbers in any format, or other identifiers). Use instead of to_number. The server normalizes and de-duplicates them and requires 2–32 distinct members. Cannot be combined with channel=whatsapp."),
      channel: z
        .enum(["whatsapp"])
        .optional()
        .describe("Force delivery over WhatsApp. Omit to let the server pick SMS/iMessage automatically. Required to use the WhatsApp interactive fields (buttons, list, cta, template)."),
      body: z
        .string()
        .optional()
        .default("")
        .describe("The message text to send (may be empty when sending media only)"),
      media_url: z
        .string()
        .url()
        .optional()
        .describe("Link (URL) to a single image or media file to attach to the message."),
      media_urls: z
        .array(z.string().url())
        .optional()
        .describe("Multiple media links (URLs) to attach, delivered as an image carousel on iMessage."),
      number_id: z
        .string()
        .optional()
        .describe(
          "ID of the specific number to send from (from list_numbers). Use when the agent has more " +
            "than one number; omit for reactions."
        ),
      from_number: z
        .string()
        .optional()
        .describe("Exact number to send a message from in E.164 format (alternative to number_id). Omit for reactions."),
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
        .describe("An expressive screen or bubble effect played when the message arrives (iMessage only; ignored on SMS)."),
      buttons: z
        .array(z.string())
        .optional()
        .describe("WhatsApp only (channel=whatsapp). Up to a few quick-reply button labels shown under the message. Mutually exclusive with list, cta, and template."),
      list: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("WhatsApp only (channel=whatsapp). An interactive list message object. Mutually exclusive with buttons, cta, and template."),
      cta: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("WhatsApp only (channel=whatsapp). A call-to-action (e.g. URL button) object. Mutually exclusive with buttons, list, and template."),
      template: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("WhatsApp only (channel=whatsapp). A pre-approved template message object, required to open a new WhatsApp conversation outside the 24h customer-service window. Mutually exclusive with buttons, list, and cta."),
      react_to_message_id: z
        .string()
        .optional()
        .describe("iMessage only. ID of a message to react to. Set together with `reaction`."),
      reaction: z
        .string()
        .optional()
        .describe("iMessage only. Tapback or single emoji applied to react_to_message_id: one of love, like, dislike, laugh, emphasize, question, or a single emoji (e.g. '🔥'). When set, this reacts instead of sending a message."),
      ...confirmField(),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    async ({ agent_id, to_number, recipients, channel, body, media_url, media_urls, number_id, from_number, reply_to_message_id, send_style, buttons, list, cta, template, react_to_message_id, reaction, confirm }) => {
      // Reaction mode: react to an existing message instead of sending one.
      // A reaction and a message in the same call used to run the reaction and
      // drop the message without a word. Refuse the combination instead.
      if (react_to_message_id && !reaction) {
        return err(new Error("react_to_message_id requires reaction (the tapback or emoji to apply)."));
      }
      if (reaction) {
        if (!react_to_message_id) {
          return err(new Error("reaction requires react_to_message_id (the message to react to)."));
        }
        const conflicting = [
          to_number ? "to_number" : null,
          recipients?.length ? "recipients" : null,
          channel ? "channel" : null,
          body ? "body" : null,
          media_url ? "media_url" : null,
          media_urls?.length ? "media_urls" : null,
          reply_to_message_id ? "reply_to_message_id" : null,
          send_style ? "send_style" : null,
          buttons?.length ? "buttons" : null,
          list ? "list" : null,
          cta ? "cta" : null,
          template ? "template" : null,
          agent_id ? "agent_id" : null,
          number_id ? "number_id" : null,
          from_number ? "from_number" : null,
        ].filter((f): f is string => f !== null);
        if (conflicting.length) {
          return err(
            new Error(
              `A reaction cannot be combined with ${conflicting.join(", ")}. A reaction is applied to ` +
                "react_to_message_id and sends no message. This connector cannot select a sender " +
                "for reactions. Omit sender fields and make separate calls to react and send."
            )
          );
        }
        if (!confirm) {
          return confirmationPreview(
            `This will send a "${reaction}" reaction to message ${react_to_message_id} in the user's conversation.`
          );
        }
        try {
          const r = await api.sendReaction(react_to_message_id, reaction);
          return ok(`Reaction '${r.reaction_type}' sent to message ${r.message_id} (${r.channel}).`, r);
        } catch (e) {
          return err(e);
        }
      }

      if (!agent_id && !from_number && !number_id) {
        return err(new Error("Provide agent_id, from_number, or number_id to identify the sender."));
      }

      // Destination: exactly one of to_number (single/existing target) or
      // recipients (create a new iMessage group). Normalize a blank to_number to
      // undefined so "" + recipients can't slip both destinations onto the wire.
      const toNumber = to_number?.trim() ? to_number.trim() : undefined;
      const hasRecipients = Boolean(recipients?.length);
      if (toNumber && hasRecipients) {
        return err(new Error("Give either to_number or recipients, not both. Use to_number for a single recipient or existing group; use recipients to create a new group."));
      }
      if (!toNumber && !hasRecipients) {
        return err(new Error("Provide to_number (a recipient or existing group) or recipients (members of a new group) when sending a message."));
      }
      // Only enforce E.164 when to_number is clearly a phone number (leading +).
      // Short codes, group IDs (grp_...), emails, and other destination identifiers
      // are passed through for the server to normalize and route.
      if (toNumber?.startsWith("+")) {
        const phoneErr = validateE164(toNumber);
        if (phoneErr) return err(new Error(phoneErr));
      }
      if (from_number) {
        const fromErr = validateE164(from_number);
        if (fromErr) return err(new Error(fromErr));
      }
      // WhatsApp cannot target an iMessage group id.
      if (channel === "whatsapp" && toNumber?.startsWith("grp_")) {
        return err(new Error("channel=whatsapp cannot target an iMessage group id (grp_...). Send WhatsApp to a single phone number."));
      }
      if (hasRecipients) {
        // Let the API own de-duplication (it accepts national, formatted, email and
        // opaque identifiers, dedupes, then requires 2–32 distinct). Guard only the
        // raw bounds that the API itself can't satisfy: fewer than 2 raw entries can
        // never yield 2 distinct members, and more than 128 is rejected outright.
        if (recipients!.length < 2) {
          return err(new Error("recipients needs at least 2 entries (a group has 2–32 distinct members after de-duplication)."));
        }
        if (recipients!.length > 128) {
          return err(new Error("recipients accepts at most 128 raw entries (the server de-duplicates them to 2–32 distinct members)."));
        }
        if (recipients!.some((r: string) => typeof r !== "string" || r.trim() === "")) {
          return err(new Error("recipients must not contain empty values."));
        }
        // A new iMessage group and a forced WhatsApp channel are contradictory.
        if (channel === "whatsapp") {
          return err(new Error("recipients creates a new iMessage group and cannot be combined with channel=whatsapp. Send WhatsApp messages to a single to_number."));
        }
      }

      // WhatsApp interactive content: requires channel=whatsapp, and at most one
      // interactive shape per message.
      const interactive = [
        buttons?.length ? "buttons" : null,
        list ? "list" : null,
        cta ? "cta" : null,
        template ? "template" : null,
      ].filter((f): f is string => f !== null);
      if (interactive.length > 1) {
        return err(new Error(`Use only one of buttons, list, cta, or template per message (got ${interactive.join(", ")}).`));
      }
      if (interactive.length === 1 && channel !== "whatsapp") {
        return err(new Error(`${interactive[0]} is a WhatsApp interactive field and requires channel=whatsapp.`));
      }

      if (!confirm) {
        // Show the complete destination and payload so the user approves exactly
        // what will be sent — all recipients, the full body, every media URL, and
        // any interactive content.
        const dest = hasRecipients
          ? `a new group of ${recipients!.length} recipient(s): ${recipients!.join(", ")}`
          : toNumber;
        const channelLabel = channel === "whatsapp" ? "WhatsApp" : "SMS/iMessage";
        const media = [media_url, ...(media_urls ?? [])].filter(Boolean);
        const content = [
          body ? `body: "${body}"` : null,
          media.length ? `media: ${media.join(", ")}` : null,
          interactive.length ? `${interactive[0]}: ${JSON.stringify((buttons ?? list ?? cta ?? template))}` : null,
        ].filter(Boolean).join("\n  ") || "(empty message)";
        return confirmationPreview(
          `This will send a ${channelLabel} message to ${dest}:\n  ${content}`
        );
      }

      try {
        const result = await api.sendMessage({
          agentId: agent_id,
          toNumber,
          recipients,
          channel,
          body,
          mediaUrl: media_url,
          mediaUrls: media_urls,
          numberId: number_id,
          fromNumber: from_number,
          replyToMessageId: reply_to_message_id,
          sendStyle: send_style,
          buttons,
          list,
          cta,
          template,
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
        // Only where watch_messages is offered. An agent that has just sent a
        // text is the one waiting for a reply, so this is where it learns it
        // doesn't have to poll. Text only: structuredContent stays the API result.
        if (opts.watchMessages) {
          lines.push(
            number_id
              ? `To wait for their reply without polling, call watch_messages with this number (number_ids: ["${number_id}"]).`
              : `To wait for their reply without polling, call watch_messages with the ID of the number this was sent from (${result.from_number}; list_numbers gives its ID).`
          );
        }
        return ok(lines.join("\n"), result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "check_capabilities",
    "Check which messaging channels a phone number can receive before you send: iMessage, SMS, and " +
      "RCS. Use this to pick a channel or decide whether a number is reachable. Returns the per-channel " +
      "flags and when they were last checked.",
    {
      phone_number: z
        .string()
        .describe("The phone number to check, in E.164 format (e.g. +14155551234)."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ phone_number }) => {
      const phoneErr = validateE164(phone_number);
      if (phoneErr) return err(new Error(phoneErr));
      try {
        const result = await api.getContactCapabilities(phone_number);
        const c = result.capabilities ?? {};
        const yes = (v: unknown) => (v === true ? "yes" : v === false ? "no" : "unknown");
        return ok(
          `Capabilities for ${result.phoneNumber}:\n` +
            `  iMessage: ${yes(c.imessage)}\n  SMS: ${yes(c.sms)}\n  RCS: ${yes(c.rcs)}\n` +
            `  Checked: ${result.checkedAt}`,
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "check_readiness",
    "Check whether a phone number is ready to send a message or place a call BEFORE you try, so you " +
      "can fix predictable failures first. Verifies the number is active, assigned to an agent, and " +
      "capable of the channel you intend, plus the account's A2P/10DLC registration (for US SMS). " +
      "Optionally checks a recipient's reachability. Returns a ready flag with specific blockers, " +
      "warnings, and next steps.\n\n" +
      "Note: credit balance and concurrency limits are enforced by the server at send time and cannot " +
      "be pre-checked here, so a ready result does not guarantee against an insufficient-credit or " +
      "busy error.",
    {
      number_id: z
        .string()
        .describe("The number to check, from list_numbers."),
      channel: z
        .enum(["sms", "imessage", "whatsapp", "voice"])
        .optional()
        .describe("The action you intend, so readiness reflects the right capability. Omit for a general check (active + assigned)."),
      to_number: z
        .string()
        .optional()
        .describe("Optional recipient (E.164) to also check for reachability on the intended channel."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ number_id, channel, to_number }) => {
      if (to_number !== undefined) {
        const toErr = validateE164(to_number);
        if (toErr) return err(new Error(toErr));
      }
      let number;
      try {
        number = await api.getNumber(number_id);
      } catch (e) {
        return err(e); // 404 → err() points at list_numbers
      }

      // SMS readiness (outboundSms state + account A2P/10DLC) is relevant for every
      // messaging path: an explicit SMS check, a general check, AND an iMessage
      // check (iMessage falls back to SMS when the recipient can't receive it).
      // WhatsApp and voice don't use SMS. A registration gap is only a HARD blocker
      // for an explicit channel=sms intent (below); otherwise it's a warning.
      // The contact-capabilities endpoint reports iMessage/SMS/RCS, so a recipient
      // reachability check only makes sense for those messaging channels.
      const messagingChannel = channel === "sms" || channel === "imessage" || channel === undefined;
      const smsRelevant = messagingChannel;
      const wantRecipient = to_number !== undefined && messagingChannel;

      // Best-effort lookups: a failure degrades to a warning, not a failed check.
      const [regResult, capResult] = await Promise.allSettled([
        smsRelevant ? api.getRegisterStatus() : Promise.resolve(null),
        wantRecipient ? api.getContactCapabilities(to_number!) : Promise.resolve(null),
      ]);
      const register = regResult.status === "fulfilled" ? regResult.value : null;
      const registerFailed = smsRelevant && regResult.status === "rejected";
      const recipient = capResult.status === "fulfilled" ? capResult.value : null;
      const recipientFailed = wantRecipient && capResult.status === "rejected";

      const blockers: string[] = [];
      const warnings: string[] = [];
      const nextSteps: string[] = [];

      if (number.status !== "active") {
        blockers.push(`The number is ${number.status}, not active.`);
        nextSteps.push("Wait for the number to become active, or contact support.");
      }
      if (!number.agentId) {
        blockers.push("The number is not assigned to an agent.");
        nextSteps.push("Attach the number to an agent with attach_number before sending or calling.");
      }
      if (channel === "whatsapp" && !number.whatsappEnabled) {
        blockers.push("WhatsApp is not enabled on this number.");
        nextSteps.push("Send WhatsApp from a WhatsApp-enabled number, or enable it on this one.");
      }
      if (channel === "voice" && !number.inboundCallsEnabled) {
        warnings.push("Inbound calls are disabled on this number (outbound calling is unaffected).");
      }

      if (smsRelevant) {
        if (number.outboundSms === "registration_required") {
          if (channel === "sms") {
            blockers.push("Outbound SMS requires A2P 10DLC registration on this number.");
          } else {
            warnings.push("Outbound SMS on this number requires A2P 10DLC registration; a general send may use iMessage, but US SMS will fail.");
          }
          nextSteps.push("Register the brand/campaign for 10DLC (see /register) before sending US SMS.");
        } else if (number.outboundSms === "activating") {
          warnings.push("Outbound SMS is still activating on this number; US SMS may fail until it reports 'enabled'.");
        }

        // Account-level A2P compliance. Match the exact successful statuses so a
        // negative status like "inactive" or "not_approved" still warns.
        const COMPLIANT = new Set(["approved", "active", "registered", "verified", "completed"]);
        if (register) {
          if (!COMPLIANT.has(String(register.campaign_status).toLowerCase())) {
            const detail = register.issue?.message || register.stage || register.campaign_status;
            warnings.push(`A2P registration is not approved (${detail}). US SMS may fail until it is.`);
            nextSteps.push("Complete A2P/10DLC registration (see /register).");
          }
        } else if (registerFailed) {
          warnings.push("Could not read A2P registration status; US SMS compliance is unverified.");
        }
      }

      // Recipient reachability (messaging channels only). send_message delivers over
      // SMS/iMessage, so base reachability on those two — not RCS, which the tool
      // can't send.
      if (recipient) {
        const c = recipient.capabilities ?? {};
        if (channel === "imessage" && c.imessage === false) {
          warnings.push(`${to_number} cannot receive iMessage; it would fall back to SMS.`);
        }
        if (c.sms === false && c.imessage !== true) {
          warnings.push(`${to_number} does not appear reachable by SMS or iMessage.`);
        }
      } else if (recipientFailed) {
        warnings.push(`Could not check reachability for ${to_number}.`);
      }

      const ready = blockers.length === 0;
      const structured: Record<string, unknown> = {
        numberId: number.id,
        phoneNumber: number.phoneNumber,
        ready,
        status: number.status,
        assigned: Boolean(number.agentId),
        channels: {
          outboundSms: number.outboundSms,
          whatsapp: number.whatsappEnabled,
          inboundCalls: number.inboundCallsEnabled,
        },
        compliance: register
          ? { campaignStatus: register.campaign_status, stage: register.stage, issue: register.issue }
          : null,
        blockers,
        warnings,
        nextSteps,
        notChecked: ["creditBalance", "concurrency"],
      };
      if (recipient) {
        structured.recipient = { phoneNumber: recipient.phoneNumber, capabilities: recipient.capabilities };
      }

      const lines = [
        `Readiness for ${number.phoneNumber} (${number.id})${channel ? ` — ${channel}` : ""}: ${ready ? "READY" : "NOT READY"}`,
        blockers.length ? `\nBlockers:\n${blockers.map((b) => `  - ${b}`).join("\n")}` : null,
        warnings.length ? `\nWarnings:\n${warnings.map((w) => `  - ${w}`).join("\n")}` : null,
        nextSteps.length ? `\nNext steps:\n${nextSteps.map((s) => `  - ${s}`).join("\n")}` : null,
        `\nNot pre-checkable (enforced at send): credit balance and concurrency limits.`,
      ].filter(Boolean);
      return ok(lines.join("\n"), structured);
    }
  );

  // How many numbers one watch_messages call may watch.
  const MAX_WATCHED_NUMBERS = 50;
  // Registered only when Wakeshift is on and the backend pushes messages:
  // otherwise nothing would ever arrive.
  if (opts.watchMessages) {
    server.tool(
      "watch_messages",
      "Watch one or more of your numbers for inbound messages (SMS, iMessage, or WhatsApp), " +
        "identified by their number IDs. Use it to wait for a reply instead of calling " +
        "get_messages repeatedly. " +
        "To watch several numbers, pass them all in one call " +
        `rather than calling once per number. A watch lasts until ${WATCH_TTL} pass with no new ` +
        "message on that number; calling again for the same number extends it. Returns once the " +
        "watches are set up; when a message arrives, read it with get_messages.",
      {
        number_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_WATCHED_NUMBERS)
          .describe("The IDs of the numbers to watch, from list_numbers: one or several."),
      },
      // Not read-only: it creates or renews the conversation's subscriptions.
      { readOnlyHint: false, idempotentHint: true },
      async ({ number_ids }) => {
        const ids = [...new Set(number_ids as string[])];
        try {
          // Confirms the caller can see every number before subscribing to any.
          const numbers = await Promise.all(ids.map((id) => api.getNumber(id)));
          // One call, so every subscription belongs to the same conversation.
          for (const id of ids) {
            const sub = await watchNumber(id);
            if (sub.state === "unavailable") {
              return err(new Error(`This client can't be notified of new messages (${sub.reason}). Use get_messages to check for new messages.`));
            }
            // Best-effort: register (or renew) the watch with the backend so it
            // keeps emitting message.received for this number. Detached, not
            // awaited: a slow or down backend (each call up to the registrar's
            // timeout) must never delay Wakeshift setup or the tool response,
            // even for a 50-number call. 404 ("disabled") is expected until the
            // filter is turned on; anything other than watched/disabled means
            // this number may go unwoken until the next renewal.
            if (opts.registerWatch) {
              void opts
                .registerWatch(id, WATCH_TTL_SECONDS)
                .then((outcome) => {
                  if (outcome !== "watched" && outcome !== "disabled") {
                    console.error(`watch_messages: backend watch registration for ${id} returned "${outcome}"; messages may not wake the agent until it is renewed.`);
                  }
                })
                .catch(() => {});
            }
          }
          const watching = ids.map((id, i) => ({ number_id: id, phone_number: numbers[i].phoneNumber }));
          // Wakeshift appends its confirmation (how the conversation is woken,
          // or the authorization line a native client subscribes with) AFTER
          // this handler returns. When producing it times out, the SDK still
          // ships this success text, with native clients' line dropped and
          // woken clients' subscriptions rolled back. The handler cannot see
          // either outcome, so every success carries the recovery hint.
          return ok(
            `Watching ${watching.length} number(s) for inbound messages:\n` +
              watching.map((w) => `  ${w.phone_number} (id=${w.number_id})`).join("\n") +
              "\n\nWakeshift confirms each watch with a note after this message (how this conversation will be woken, " +
              "or an authorization line your client subscribes with). If no such note follows, the watch did NOT take " +
              "effect: call watch_messages again, or poll with get_messages.",
            { watching }
          );
        } catch (e) {
          return err(e);
        }
      }
    );
  }

  server.tool(
    "get_messages",
    "Get SMS messages for a specific phone number, identified by its number ID. Returns a list of " +
      "individual messages — each with its timestamp, sender, recipient, and text — rather than " +
      "grouped conversation threads. Results are newest first. To page through older history, pass " +
      "the nextCursor from one response as cursor on the next; before/after are optional time filters only.",
    {
      number_id: z.string().describe("The ID of the number whose messages you want, from list_numbers."),
      limit: z
        .number().int().min(1).max(200)
        .default(50)
        .describe("How many messages to return in one page."),
      ...cursorInputs(),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ number_id, limit, before, after, cursor }) => {
      try {
        const result = await api.getMessages(number_id, limit, { before, after, cursor });
        if (result.data.length === 0) {
          const empty = cursor
            ? "No more messages on this page."
            : before || after
              ? "No messages found for this number in the requested time range."
              : "No messages found for this number.";
          return ok(empty, result);
        }

        const formatted = result.data
          .map((m) => `[${m.receivedAt}] ${m.from ?? "unknown"} → ${m.to ?? "unknown"}: ${m.body}`)
          .join("\n");

        const footer = pageFooter(result, `Call get_messages again with the same number_id and`);
        return ok(`${result.data.length} message(s):\n\n${formatted}${footer}`, result);
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
    "List recent calls. Choose ONE scope: the whole account (default), a single agent_id, or a single number_id.\n\n" +
      "The status, direction, and search filters are only supported on the account-wide list. They cannot be " +
      "combined with agent_id or number_id, and passing them together is rejected rather than silently ignored. " +
      "The response reports the scope and the filters actually applied.\n" +
      "Returns call summaries including each call's ID, direction, participants, and status.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Show only calls handled by this agent (ID from list_agents)."),
      number_id: z
        .string()
        .optional()
        .describe("Show only calls on this phone number (ID from list_numbers)."),
      limit: z
        .number().int().min(1).max(100)
        .default(20)
        .describe("How many calls to return in one page."),
      offset: z
        .number().int().min(0)
        .default(0)
        .describe("How many calls to skip before this page, for paging."),
      status: z
        .string()
        .min(1)
        .optional()
        .describe("Keep only calls in this state, e.g. ringing, in-progress, completed, failed, busy, or no-answer."),
      direction: z
        .enum(["inbound", "outbound"])
        .optional()
        .describe("Keep only inbound calls, or only outbound calls."),
      search: z
        .string()
        .min(1)
        .optional()
        .describe("Match calls by phone number or keyword."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id, number_id, limit, offset, status, direction, search }) => {
      try {
        // Reject ambiguous or unsupported combinations up front, with a precise
        // correction, instead of silently dropping filters or picking a winner.
        if (agent_id && number_id) {
          return err(
            new Error(
              "Pass either agent_id or number_id, not both. Choose one scope, or omit both to list the whole account."
            )
          );
        }
        const requested: string[] = [];
        if (status !== undefined) requested.push("status");
        if (direction !== undefined) requested.push("direction");
        if (search !== undefined) requested.push("search");
        const scopeId = number_id ? "number_id" : agent_id ? "agent_id" : null;
        if (scopeId && requested.length > 0) {
          return err(
            new Error(
              `The ${requested.join(", ")} filter${requested.length > 1 ? "s are" : " is"} not supported when scoping by ${scopeId}. ` +
                `Drop ${scopeId} to filter the account-wide list, or drop ${requested.join("/")} to list calls for this ${scopeId === "number_id" ? "number" : "agent"}.`
            )
          );
        }

        let result;
        let scope: string;
        let appliedFilters: Record<string, string>;
        if (number_id) {
          result = await api.listCallsForNumber(number_id, limit, offset);
          scope = `number_id=${number_id}`;
          appliedFilters = {};
        } else if (agent_id) {
          result = await api.listAgentCalls(agent_id, limit, offset);
          scope = `agent_id=${agent_id}`;
          appliedFilters = {};
        } else {
          result = await api.listCalls(limit, offset, { status, direction, search });
          scope = "account";
          appliedFilters = {
            ...(status !== undefined ? { status } : {}),
            ...(direction !== undefined ? { direction } : {}),
            ...(search !== undefined ? { search } : {}),
          };
        }

        const filterText =
          Object.keys(appliedFilters).length > 0
            ? Object.entries(appliedFilters).map(([k, v]) => `${k}=${v}`).join(", ")
            : "none";
        // Echo the effective scope/filters so clients never have to infer them
        // from the tool description.
        const structured = { ...result, scope, appliedFilters };

        if (result.data.length === 0) {
          return ok(`No calls found. (scope: ${scope}; filters: ${filterText})`, structured);
        }

        const formatted = result.data
          .map(
            (c) =>
              `[${c.startedAt}] ${c.direction} ${c.fromNumber} → ${c.toNumber} (${c.status}) id=${c.id}`
          )
          .join("\n");

        return ok(
          `${result.data.length} call(s) (scope: ${scope}; filters: ${filterText}):\n\n${formatted}\n\nTotal: ${result.total}\n\nUse get_call with the id= value to fetch transcript.`,
          structured
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_call",
    "Get details and transcript for a specific call, identified by its call ID. Returns the call's " +
      "direction, participants, status, timestamps, and transcript so far, as of now. A call that is " +
      "still in progress returns its current state; call get_call again to see later updates.",
    {
      call_id: z
        .string()
        .describe("The ID of the call to fetch, from list_calls or from a make_call / make_conversation_call response."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ call_id }) => {
      try {
        const result = await api.getCall(call_id);
        // Policy: the connector never surfaces a call recording link (README:
        // "No audio is exposed"). Keep it out of the structured output too; a
        // boolean recordingAvailable flag is metadata, not the recording.
        const { recordingUrl: _recordingUrl, ...safeResult } = result;

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
            result.endReason ? `End reason: ${result.endReason}` : null,
            result.failureReason ? `Failure reason: ${result.failureReason}` : null,
            result.recordingAvailable != null ? `Recording available: ${result.recordingAvailable}` : null,
            `\nTranscript:\n${transcript}`,
          ]
            .filter(Boolean)
            .join("\n"),
          safeResult
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "end_call",
    "End an in-progress call immediately, identified by its call ID. Use this to hang up a call you " +
      "started (or any active call in your account). Ending a call that has already finished is a no-op, " +
      "so it is safe to retry. Returns the call's resulting status.",
    {
      call_id: z
        .string()
        .describe("The ID of the call to end, from list_calls or a make_call / make_conversation_call response."),
    },
    // Ends a live call (irreversible for that call) and affects the external
    // phone session, but repeating on an already-ended call is a no-op.
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: true },
    async ({ call_id }) => {
      try {
        const result = await api.endCall(call_id);
        const status = result.status ? ` Status: ${result.status}.` : "";
        return ok(`Call ${call_id} ended.${status}`, result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "make_call",
    "Initiate an outbound, webhook-driven phone call where your backend handles the " +
      "conversation logic.\n\n" +
      "Each call is individually authorized by the user: this returns a preview and places no call " +
      "unless confirm=true, so confirm the destination with the user before dialing.\n" +
      "The agent must have a phone number attached and a webhook configured. " +
      "The greeting is sent to the API exactly as you provide it. You are responsible for any AI " +
      "self-identification required for your use case or jurisdiction. " +
      "Returns the new call's ID, status, and the numbers it connects.",
    {
      agent_id: z
        .string()
        .describe("The agent placing the call (ID from list_agents). The agent must have a phone number attached and a webhook configured."),
      to_number: z
        .string()
        .describe("The phone number to call, written in full international form with a country code, like +14155551234."),
      initial_greeting: z
        .string()
        .optional()
        .describe(
          "What the agent says when the call connects, sent to the API as-is. If omitted, your webhook " +
            "drives what the agent says. Ignored when wait_for_speaker is true."
        ),
      wait_for_speaker: z
        .boolean()
        .default(false)
        .describe(
          "When true, the call connects silently and the agent waits for the person to speak first " +
            "instead of opening with a greeting (no initial_greeting is sent). Default false."
        ),
      from_number_id: z
        .string()
        .optional()
        .describe("ID of the specific number to call from (from list_numbers), when the agent has more than one."),
      voice: z
        .string()
        .optional()
        .describe("A voice ID (from list_voices) to override the agent's default voice for just this call."),
      ...callControlInputs(),
      ...confirmField(),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    async ({ agent_id, to_number, initial_greeting, wait_for_speaker, from_number_id, voice, confirm, ...controls }) => {
      const phoneErr = validateE164(to_number);
      if (phoneErr) return err(new Error(phoneErr));

      if (!confirm) {
        return confirmationPreview(
          `This will place an outbound call to ${to_number}` +
            `${from_number_id ? ` from number ${from_number_id}` : agent_id ? ` using agent ${agent_id}` : ""}. ` +
            (wait_for_speaker || initial_greeting === ""
              ? "The call waits silently for the person to speak first."
              : initial_greeting ? `The call opens with: "${initial_greeting}"` : "Your webhook drives what the agent says.")
        );
      }

      try {
        const result = await api.makeCall(
          agent_id,
          to_number,
          wait_for_speaker ? "" : initial_greeting,
          from_number_id,
          voice,
          buildCallControls(controls),
        );
        return ok(
          `Call initiated!\n  From: ${result.fromNumber}\n  To: ${result.toNumber}\n  Call ID: ${result.id}\n  Status: ${result.status}`,
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "make_conversation_call",
    "Place a phone call where the AI has an autonomous conversation about a given topic — " +
      "scheduling, surveys, follow-ups, etc. No webhook setup needed.\n\n" +
      "Each call is individually authorized by the user: this returns a preview and places no call " +
      "unless confirm=true. Confirm the destination and topic with the user before dialing.\n" +
      "The agent must have a phone number attached.\n" +
      "The topic and greeting are sent to the API as you provide them. You are responsible for any AI " +
      "self-identification required for your use case or jurisdiction.\n" +
      "This returns immediately with the call's ID and initial status. The call then runs on its own; " +
      "use get_call with the call ID to fetch the transcript once it has progressed.",
    {
      agent_id: z
        .string()
        .describe("The agent that will place the call (ID from list_agents). It must have a phone number attached."),
      to_number: z
        .string()
        .describe("The phone number to call, written in full international form with a country code, like +14155551234."),
      topic: z.string().min(1).describe(
        "The conversation goal for the assistant to pursue, sent to the API as the call objective. " +
          "Be specific about what to discuss and any goals."
      ),
      initial_greeting: z
        .string()
        .optional()
        .describe("The greeting sent to the API when the call connects, used as-is. If omitted, the assistant opens on its own. Ignored when wait_for_speaker is true."),
      wait_for_speaker: z
        .boolean()
        .default(false)
        .describe(
          "When true, the call connects silently and the assistant waits for the person to speak first " +
            "instead of opening with a greeting. Default false."
        ),
      from_number_id: z
        .string()
        .optional()
        .describe("ID of the specific number to call from (from list_numbers), when the agent has more than one."),
      voice: z
        .string()
        .optional()
        .describe("A voice ID (from list_voices) to override the agent's default voice for this call."),
      ...callControlInputs(),
      ...confirmField(),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false },
    async ({ agent_id, to_number, topic, initial_greeting, wait_for_speaker, from_number_id, voice, confirm, ...controls }) => {
      const phoneErr = validateE164(to_number);
      if (phoneErr) return err(new Error(phoneErr));

      if (!confirm) {
        return confirmationPreview(
          `This will place an autonomous AI phone call to ${to_number}` +
            `${from_number_id ? ` from number ${from_number_id}` : agent_id ? ` using agent ${agent_id}` : ""}, ` +
            `where the assistant will hold a conversation about: "${topic}".` +
            (wait_for_speaker || initial_greeting === "" ? " The call waits silently for the person to speak first." : "")
        );
      }

      try {
        const result = await api.makeConversationCall(
          agent_id,
          to_number,
          topic,
          wait_for_speaker ? "" : initial_greeting,
          from_number_id,
          voice,
          buildCallControls(controls),
        );

        return ok(
          [
            `Conversation call initiated!`,
            `  From: ${result.fromNumber}`,
            `  To: ${result.toNumber}`,
            `  Call ID: ${result.id}`,
            `  Status: ${result.status}`,
            ``,
            `The AI will have an autonomous conversation about the topic you provided.\nUse get_call with the call ID to check the transcript once the call ends.`,
          ].join("\n"),
          result
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
    "List agents in your account, one page at a time. An agent is required before you can make " +
      "calls — it owns phone numbers and handles voice/SMS. Returns each agent's ID, name, voice " +
      "configuration, and attached phone numbers. Use offset to page through accounts with more " +
      "agents than fit in one page; the response reports total and whether more remain.",
    {
      limit: z
        .number().int().min(1).max(100)
        .default(20)
        .describe("How many agents to return in one page."),
      offset: z
        .number().int().min(0)
        .default(0)
        .describe("How many agents to skip before this page, for paging through a long list."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ limit, offset }) => {
      try {
        const result = await api.listAgents(limit, offset);
        // The agents endpoint returns total but no hasMore; derive it so clients
        // get an explicit truncation/continuation signal.
        const hasMore = offset + result.data.length < result.total;
        const structured = { ...result, hasMore };
        const footer = hasMore
          ? `\n\nShowing ${offset + 1}-${offset + result.data.length} of ${result.total}. Call list_agents again with offset=${offset + result.data.length} for the next page.`
          : "";
        return ok(`${JSON.stringify(structured, null, 2)}${footer}`, structured);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "create_agent",
    "Create a new agent. An agent owns phone numbers and handles calls/SMS.\n\n" +
      "A newly created agent has no phone number until one is attached.\n" +
      "Set voice_mode to 'hosted' with a system_prompt for autonomous AI voice calls, " +
      "or 'webhook' (default) to forward call transcripts to your webhook URL.\n" +
      "Returns the created agent, including its new ID and full configuration.",
    {
      name: z
        .string()
        .describe("A label for the agent, shown in listings and account views (e.g. 'Customer Support' or 'Sales Bot')."),
      description: z
        .string()
        .optional()
        .describe("A short note describing what this agent is for (e.g. 'handles billing questions'). For your reference; it does not change how the agent behaves."),
      voice_mode: z
        .enum(["webhook", "hosted"])
        .optional()
        .describe("How calls are handled: forward transcripts to your webhook (the default), or use the built-in hosted AI driven by system_prompt."),
      system_prompt: z
        .string()
        .optional()
        .describe("Required when voice_mode is 'hosted'. The AI's personality and instructions for voice calls."),
      begin_message: z
        .string()
        .optional()
        .describe("What the AI says first when a call connects (hosted mode only). If omitted, the AI opens on its own based on the system prompt."),
      voice: z
        .string()
        .optional()
        .describe("A voice ID from list_voices (use that tool to get valid IDs). If omitted, the server applies its default voice."),
      model_tier: z
        .enum(["turbo", "balanced", "max", "realtime"])
        .optional()
        .describe(
          "Model quality/speed tier for hosted-mode agents. " +
            "'turbo' = fastest/cheapest, 'balanced' (default) = general use, 'max' = highest quality, 'realtime' = speech-to-speech, lowest latency."
        ),
      transfer_number: z
        .string()
        .optional()
        .describe("Phone number to transfer calls to (E.164 format). Enables call transfer during conversations."),
      voicemail_message: z
        .string()
        .optional()
        .describe("Message the agent leaves when an outbound call reaches the callee's voicemail. When set, the agent leaves this message instead of simply hanging up."),
      call_screening_identity: z
        .string()
        .optional()
        .describe("Default identity to present if a callee's carrier screens the agent's outbound calls (e.g. your business name). Per-call make_call can override it."),
      call_screening_purpose: z
        .string()
        .optional()
        .describe("Default stated purpose to present to call screening (e.g. 'appointment reminder')."),
      voice_speed: z
        .number().min(0.5).max(2)
        .optional()
        .describe("How fast the agent speaks, as a multiplier of normal pace (1 is normal, below 1 is slower, above 1 is faster). If omitted, the agent uses its default speed."),
      interruption_sensitivity: z
        .number().min(0).max(1)
        .optional()
        .describe("How readily the agent lets a caller interrupt it — lower values make it harder to cut off, higher values stop it at the first sound."),
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
        .describe("Optional background ambience for call audio."),
      denoising_mode: z
        .enum(["noise-cancellation", "noise-and-background-speech-cancellation"])
        .optional()
        .describe("Audio denoising. The aggressive mode helps callers in cars/cafes (small surcharge)."),
      max_silence_ms: z
        .number().int().min(10000).max(3600000)
        .optional()
        .describe("How long the agent waits through continuous caller silence before ending the call. Omit to use the server default (about 10 minutes)."),
      language: z
        .string()
        .optional()
        .describe("BCP-47 locale for speech recognition and synthesis, e.g. 'en-US', 'es-ES', 'ja-JP'."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    async ({ name, description, voice_mode, system_prompt, begin_message, voice, model_tier, transfer_number, voicemail_message, call_screening_identity, call_screening_purpose, voice_speed, interruption_sensitivity, enable_backchannel, enable_messaging, stt_mode, ambient_sound, denoising_mode, max_silence_ms, language }) => {
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
          callScreeningIdentity: call_screening_identity,
          callScreeningPurpose: call_screening_purpose,
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
          `Agent created!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n  Model Tier: ${result.modelTier}\n\n${JSON.stringify(result, null, 2)}`,
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "update_agent",
    "Update an agent's configuration — name, description, voice settings, instructions, greeting, " +
      "call transfer, or voicemail. Only provided fields are updated; omitted fields keep their " +
      "current value.\n" +
      "Switching voice_mode to 'hosted' requires a system_prompt.\n" +
      "Returns the agent's full configuration after the update.",
    {
      agent_id: z.string().describe("The ID of the agent to update, from list_agents."),
      name: z.string().optional().describe("A new label for the agent, shown in listings and account views."),
      description: z.string().optional().describe("A short note describing what this agent is for; for your reference only."),
      voice_mode: z
        .enum(["webhook", "hosted"])
        .optional()
        .describe("Whether calls are handled by your webhook (transcripts forwarded to your URL) or by the built-in hosted AI (driven by system_prompt)."),
      system_prompt: z
        .string()
        .optional()
        .describe("The AI's personality and instructions. Required when voice_mode is 'hosted'."),
      begin_message: z
        .string()
        .optional()
        .describe("What the AI says when a call connects (hosted mode only). If omitted, the current greeting is left unchanged."),
      voice: z
        .string()
        .optional()
        .describe("A voice ID from list_voices to set for the agent."),
      model_tier: z
        .enum(["turbo", "balanced", "max", "realtime"])
        .optional()
        .describe(
          "Model quality/speed tier for hosted-mode agents. " +
            "'turbo' = fastest/cheapest, 'balanced' = general use, 'max' = highest quality, 'realtime' = speech-to-speech, lowest latency."
        ),
      transfer_number: z
        .string()
        .optional()
        .describe("Phone number to transfer calls to (E.164 format), or empty string to remove."),
      voicemail_message: z
        .string()
        .optional()
        .describe("Message the agent leaves when an outbound call reaches the callee's voicemail, or empty string to clear it."),
      call_screening_identity: z
        .string()
        .optional()
        .describe("Default identity to present if a callee's carrier screens the agent's outbound calls (e.g. your business name), or empty string to clear it."),
      call_screening_purpose: z
        .string()
        .optional()
        .describe("Default stated purpose to present to call screening (e.g. 'appointment reminder'), or empty string to clear it."),
      voice_speed: z
        .number().min(0.5).max(2)
        .optional()
        .describe("How fast the agent speaks, as a multiplier of normal pace (1 is normal, below 1 is slower, above 1 is faster). If omitted, the current speed is unchanged."),
      interruption_sensitivity: z
        .number().min(0).max(1)
        .optional()
        .describe("How readily the agent lets a caller interrupt it — lower values make it harder to cut off, higher values stop it at the first sound."),
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
        .describe("Optional background ambience for call audio."),
      denoising_mode: z
        .enum(["noise-cancellation", "noise-and-background-speech-cancellation"])
        .optional()
        .describe("Audio denoising. The aggressive mode helps callers in cars/cafes (small surcharge)."),
      max_silence_ms: z
        .number().int().min(10000).max(3600000)
        .optional()
        .describe("How long the agent waits through continuous caller silence before ending the call. Omit to keep the agent's current timeout."),
      language: z
        .string()
        .optional()
        .describe("BCP-47 locale for speech recognition and synthesis, e.g. 'en-US', 'es-ES', 'ja-JP'."),
    },
    { idempotentHint: true },
    async ({ agent_id, name, description, voice_mode, system_prompt, begin_message, voice, model_tier, transfer_number, voicemail_message, call_screening_identity, call_screening_purpose, voice_speed, interruption_sensitivity, enable_backchannel, enable_messaging, stt_mode, ambient_sound, denoising_mode, max_silence_ms, language }) => {
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
        if (voicemail_message !== undefined) params.voicemailMessage = voicemail_message;
        if (voice !== undefined) params.voice = voice;
        if (model_tier !== undefined) params.modelTier = model_tier;
        if (transfer_number !== undefined) params.transferNumber = transfer_number;
        if (call_screening_identity !== undefined) params.callScreeningIdentity = call_screening_identity;
        if (call_screening_purpose !== undefined) params.callScreeningPurpose = call_screening_purpose;
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
          `Agent updated!\n  ID: ${result.id}\n  Name: ${result.name}\n  Voice Mode: ${result.voiceMode}\n  Voice: ${result.voice}\n  Model Tier: ${result.modelTier}\n\n${JSON.stringify(result, null, 2)}`,
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_agent",
    "Delete an agent permanently. Phone numbers attached to it are kept but unassigned. " +
      "This cannot be undone. Returns the deleted agent's name and ID as confirmation.",
    {
      agent_id: z.string().describe("The ID of the agent to delete, from list_agents."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    async ({ agent_id }) => {
      try {
        const result = await api.deleteAgent(agent_id);
        return ok(`Deleted agent '${result.name}' (${result.id})`, result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_agent",
    "Get one agent's full configuration. Returns its voice settings, system prompt, model tier, " +
      "transfer and voicemail setup, and the phone numbers attached to it.",
    {
      agent_id: z.string().describe("The ID of the agent to fetch, from list_agents."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id }) => {
      try {
        const result = await api.getAgent(agent_id);
        return ok(JSON.stringify(result, null, 2), result);
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "attach_number",
    "Attach a phone number to an agent so the agent handles calls/SMS on that number. " +
      "Takes an agent ID and a phone number ID. Returns the attached number and the agent it now belongs to.",
    {
      agent_id: z.string().describe("The ID of the agent that should own the number, from list_agents."),
      number_id: z.string().describe("The ID of the number to attach, from list_numbers."),
    },
    { idempotentHint: true },
    async ({ agent_id, number_id }) => {
      try {
        const result = await api.attachNumber(agent_id, number_id);
        return ok(
          `Attached number ${result.number.phoneNumber} to agent ${result.agentId}`,
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "detach_number",
    "Detach a phone number from an agent. The number is kept in your account but becomes " +
      "unassigned, and the agent stops handling calls and texts on it.",
    {
      agent_id: z.string().describe("The ID of the agent that currently owns the number, from list_agents."),
      number_id: z.string().describe("The ID of the number to detach, from list_numbers."),
    },
    { idempotentHint: true },
    async ({ agent_id, number_id }) => {
      try {
        await api.detachNumber(agent_id, number_id);
        // Explicitly return { success: true } so structuredContent satisfies the output schema
        return ok(`Detached number ${number_id} from agent ${agent_id}`, { success: true });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_voices",
    "List the voices available for agents. Returns each voice's ID (used in an agent's voice " +
      "field), name, provider, gender, and accent.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      try {
        const result = await api.listVoices();
        if (result.data.length === 0) {
          return ok("No voices available.", result);
        }

        const formatted = result.data
          .map((v) => {
            // Providers may omit gender/accent (null); show only what's present.
            const meta = [v.provider, v.gender, v.accent].filter(Boolean).join(", ");
            return `${v.voice_id} — ${v.voice_name}${meta ? ` (${meta})` : ""}`;
          })
          .join("\n");

        return ok(
          `${result.data.length} voice(s) available:\n\n${formatted}`,
          result
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
      "Each conversation is a thread between your number and an external contact, with its ID, " +
      "participant, message count, and last-message preview.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Show only conversations handled by this agent (ID from list_agents)."),
      limit: z
        .number().int().min(1).max(100)
        .default(20)
        .describe("How many conversations to return in one page."),
      offset: z
        .number().int().min(0)
        .default(0)
        .describe("How many conversations to skip before this page, for paging."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id, limit, offset }) => {
      try {
        const result = agent_id
          ? await api.listAgentConversations(agent_id, limit, offset)
          : await api.listConversations(limit, offset);

        if (result.data.length === 0) {
          return ok("No conversations found.", result);
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
          `${result.data.length} conversation(s):\n\n${formatted}\n\nTotal: ${result.total}`,
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_conversation",
    "Get one SMS conversation with its message history (up to message_limit most recent messages), " +
      "identified by its conversation ID. Returns the contact, your phone number, the message count, " +
      "any stored metadata, and the messages.",
    {
      conversation_id: z.string().describe("The ID of the conversation to fetch, from list_conversations."),
      message_limit: z
        .number().int().min(1).max(100)
        .default(50)
        .describe("How many of the most recent messages to include."),
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
            .join("\n"),
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "get_conversation_messages",
    "Page through a conversation's full message history, identified by its conversation ID. Unlike " +
      "get_conversation (which returns the conversation detail with only a bounded tail of recent " +
      "messages), this reaches arbitrarily far back: pass the nextCursor from one response as cursor " +
      "on the next. Results are newest first; before/after are optional time filters only.",
    {
      conversation_id: z.string().describe("The ID of the conversation whose messages you want, from list_conversations."),
      limit: z
        .number().int().min(1).max(200)
        .default(50)
        .describe("How many messages to return in one page."),
      ...cursorInputs(),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ conversation_id, limit, before, after, cursor }) => {
      try {
        const result = await api.getConversationMessages(conversation_id, limit, { before, after, cursor });
        if (result.data.length === 0) {
          const empty = cursor
            ? "No more messages on this page."
            : before || after
              ? "No messages in the requested time range."
              : "No messages in this conversation.";
          return ok(empty, result);
        }

        const formatted = result.data
          .map((m) => `[${m.receivedAt}] ${m.direction} ${m.fromNumber} → ${m.toNumber}: ${m.body}`)
          .join("\n");

        const footer = pageFooter(result, `Call get_conversation_messages again with the same conversation_id and`);
        return ok(`${result.data.length} message(s):\n\n${formatted}${footer}`, result);
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
      conversation_id: z.string().describe("The ID of the conversation to update, from list_conversations."),
      metadata: z
        .record(z.string(), z.unknown())
        .nullable()
        .describe("A JSON object of custom state to store on the conversation (tags, context, and so on), or null to clear what's stored."),
    },
    { idempotentHint: true },
    async ({ conversation_id, metadata }) => {
      try {
        const result = await api.updateConversation(conversation_id, metadata);
        return ok(
          `Conversation updated.\n  ID: ${result.id}\n  Metadata: ${JSON.stringify(result.metadata)}`,
          result
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
    "List saved contacts (your address book). Returns each contact's name, phone number, email, " +
      "and ID. Optionally filter with a search term that matches name or phone number.",
    {
      search: z.string().optional().describe("Match contacts by name or phone number."),
      limit: z.number().int().min(1).max(200).default(50).describe("How many contacts to return in one page."),
      offset: z.number().int().min(0).default(0).describe("How many contacts to skip before this page, for paging."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ search, limit, offset }) => {
      try {
        const result = await api.listContacts(limit, offset, search);
        if (result.data.length === 0) return ok("No contacts found.", result);
        const formatted = result.data
          .map((c) => `${c.name} — ${c.phoneNumber}${c.email ? ` <${c.email}>` : ""} id=${c.id}`)
          .join("\n");
        return ok(`${result.data.length} contact(s):\n\n${formatted}\n\nTotal: ${result.total}`, result);
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
      "- delete: requires contact_id, and confirm=true — permanent and cannot be undone. Without " +
      "confirm the tool deletes nothing and returns a preview of what would be removed, so the user " +
      "can approve first.\n\n" +
      "create and update return the saved contact (id, name, phone number, email, notes); delete " +
      "returns a success flag.",
    {
      action: z
        .enum(["create", "update", "delete"])
        .describe("Which operation to run: create a new contact, update an existing one, or delete one (delete is permanent and needs confirm=true)."),
      contact_id: z
        .string()
        .optional()
        .describe("ID of the contact to act on, from list_contacts. Required for 'update' and 'delete'."),
      phone_number: z
        .string()
        .optional()
        .describe("The contact's phone number in full international form with country code (e.g. +14155551234). Required for 'create'."),
      name: z.string().optional().describe("Contact name. Required for 'create'."),
      email: z.string().email().optional().describe("An email address to save with the contact."),
      notes: z.string().optional().describe("Freeform notes to store with the contact, for your reference."),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "Required for action='delete': must be true to actually delete. When false (the default), " +
            "a delete only previews what would be removed and deletes nothing. Ignored for create and " +
            "update. Get the user's explicit go-ahead, then call again with the same arguments plus confirm=true."
        ),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
    async ({ action, contact_id, phone_number, name, email, notes, confirm }) => {
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
          return ok(`Contact created: ${result.name} (${result.phoneNumber}) id=${result.id}`, result);
        }

        if (action === "update") {
          if (!contact_id) return err(new Error("update requires contact_id."));
          const params: { phoneNumber?: string; name?: string; email?: string; notes?: string } = {};
          if (phone_number !== undefined) params.phoneNumber = phone_number;
          if (name !== undefined) params.name = name;
          if (email !== undefined) params.email = email;
          if (notes !== undefined) params.notes = notes;
          const result = await api.updateContact(contact_id, params);
          return ok(`Contact updated: ${result.name} (${result.phoneNumber}) id=${result.id}`, result);
        }

        // action === "delete" — permanent, so gated behind an explicit confirm.
        if (!contact_id) return err(new Error("delete requires contact_id."));
        if (!confirm) {
          return ok(
            `This will PERMANENTLY delete contact ${contact_id} (its saved name, phone number, email, ` +
              "and notes). This cannot be undone.\n\nConfirm with the user first, then call manage_contact " +
              "again with action='delete', the SAME contact_id, plus confirm=true. Use list_contacts to review it beforehand.",
            { confirmationRequired: true }
          );
        }
        await api.deleteContact(contact_id);
        // Explicitly return { success: true } so structuredContent satisfies the
        // output schema even when the API answers a DELETE with an empty body.
        return ok(`Contact ${contact_id} deleted.`, { success: true });
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
    "Get account usage statistics. By default returns a summary with number usage plus " +
      "message, call, and webhook volume. Use breakdown='daily' or 'monthly' for time-series data.",
    {
      breakdown: z
        .enum(["summary", "daily", "monthly"])
        .default("summary")
        .describe("What to return: an overall summary of number usage and totals, a day-by-day series, or a month-by-month series."),
      days: z
        .number().int().min(1).max(365)
        .default(30)
        .describe("How far back the daily series reaches, in days. Ignored unless breakdown='daily'."),
      months: z
        .number().int().min(1).max(24)
        .default(12)
        .describe("How far back the monthly series reaches, in months. Ignored unless breakdown='monthly'."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ breakdown, days, months }) => {
      try {
        if (breakdown === "daily") {
          const result = await api.getDailyUsage(days);
          if (result.data.length === 0) {
            return ok("No usage data for this period.", result);
          }
          const formatted = result.data
            .map(
              (d) => `${d.date}: ${d.messages} msgs, ${d.calls} calls, ${d.webhooks} webhooks`
            )
            .join("\n");
          return ok(`Daily usage (last ${days} days):\n\n${formatted}`, result);
        }

        if (breakdown === "monthly") {
          const result = await api.getMonthlyUsage(months);
          if (result.data.length === 0) {
            return ok("No usage data for this period.", result);
          }
          const formatted = result.data
            .map(
              (d) => `${d.month}: ${d.messages} msgs, ${d.calls} calls, ${d.webhooks} webhooks`
            )
            .join("\n");
          return ok(`Monthly usage (last ${months} months):\n\n${formatted}`, result);
        }

        // Default: summary
        const result = await api.getUsage();
        const lines = [
          `Phone Numbers: ${result.numbers.used}/${result.numbers.limit} (${result.numbers.remaining} remaining)`,
          ``,
          `Messages:`,
          `  Total: ${result.stats.totalMessages}`,
          `  Last 24h: ${result.stats.messagesLast24h}`,
          `  Last 7d: ${result.stats.messagesLast7d}`,
          `  Last 30d: ${result.stats.messagesLast30d}`,
          `  Billed SMS segments (30d): ${result.stats.smsSegmentsLast30d}`,
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
          `Messaging and voice are billed per use from your credit balance (no plan limits).`,
        ];
        return ok(lines.join("\n"), result);
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
    "Get the webhook configuration — its URL and status. The signing secret is never returned " +
      "(it would land in model context, transcripts and logs); retrieve it from the AgentPhone " +
      "dashboard. Pass agent_id to get an agent-specific webhook, or omit for the project-level default.",
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
              : "No webhook configured.",
            { configured: false }
          );
        }
        // The signing secret never leaves through a tool; always masked.
        const shown = { ...result, secret: maskSecret(result.secret) };
        return ok(JSON.stringify(shown, null, 2), shown);
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
      "The signing secret is never returned here (it would land in model context, transcripts " +
      "and logs); retrieve it from the AgentPhone dashboard to verify webhook signatures.",
    {
      url: z
        .string()
        .url()
        .describe("Where AgentPhone should POST inbound messages and call events. Use a public HTTPS endpoint in production."),
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to set webhook for that agent only. Omit for project-level."),
      context_limit: z
        .number().int().min(0).max(50)
        .optional()
        .describe("How many recent messages to include with each webhook as conversation context. If omitted, the server's default context size is used."),
      timeout: z
        .number()
        .optional()
        .describe("How many seconds to wait for your endpoint to respond before giving up. If omitted, the server uses its default timeout."),
    },
    { idempotentHint: true },
    async ({ url, agent_id, context_limit, timeout }) => {
      try {
        const result = agent_id
          ? await api.setAgentWebhook(agent_id, url, context_limit, timeout)
          : await api.setWebhook(url, context_limit, timeout);
        const scope = agent_id ? `Agent ${agent_id}` : "Project";
        // The signing secret never leaves through a tool; always masked.
        const secret = maskSecret(result.secret);
        return ok(
          `${scope} webhook set!\n  URL: ${result.url}\n  Secret: ${secret}\n  Status: ${result.status}`,
          { ...result, secret }
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "delete_webhook",
    "Remove a webhook. Deleting an agent's webhook makes that agent fall back to the project-level " +
      "webhook; deleting the project-level webhook stops events for agents using that default until " +
      "you set one again (agents with their own webhook are unaffected). Pass agent_id to remove an " +
      "agent's webhook, or omit it to remove the project-level webhook.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to delete that agent's webhook. Omit for project-level."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: true },
    async ({ agent_id }) => {
      try {
        if (agent_id) {
          await api.deleteAgentWebhook(agent_id);
          return ok("Agent webhook deleted. Events will now go to the project-level webhook.", { success: true });
        }
        await api.deleteWebhook();
        return ok("Project webhook deleted.", { success: true });
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "test_webhook",
    "Send a test event to a configured webhook and report whether your endpoint accepted it. " +
      "Returns success, the HTTP status your endpoint returned, and any error message.\n\n" +
      "Pass agent_id to test that agent's webhook. Omit to test the project-level webhook. Each " +
      "call dispatches a real event to your endpoint, so it is not a no-op to repeat.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to test that agent's webhook. Omit for project-level."),
    },
    // Not idempotent: each call sends a fresh external event to the endpoint.
    { openWorldHint: true },
    async ({ agent_id }) => {
      try {
        const result = agent_id
          ? await api.testAgentWebhook(agent_id)
          : await api.testWebhook();
        const scope = agent_id ? "Agent webhook" : "Webhook";
        // The deployed endpoints return httpStatus/errorMessage; fall back to the
        // older statusCode/error names so either shape formats correctly.
        const httpStatus = result.httpStatus ?? result.statusCode ?? null;
        const errorMessage = result.errorMessage ?? result.error ?? null;
        const normalized = { success: result.success, httpStatus, errorMessage };
        if (result.success) {
          return ok(`${scope} test succeeded.\n  HTTP status: ${httpStatus ?? "n/a"}`, normalized);
        }
        return ok(
          `${scope} test failed.\n  HTTP status: ${httpStatus ?? "n/a"}\n  Error: ${errorMessage ?? "none reported"}`,
          normalized
        );
      } catch (e) {
        return err(e);
      }
    }
  );

  server.tool(
    "list_webhook_deliveries",
    "View recent webhook delivery history. Shows which events were delivered, HTTP status codes, and timing.\n\n" +
      "Pass agent_id to see deliveries for that agent's webhook. Omit for project-level. " +
      "The hours time filter is supported only for project-level history.",
    {
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID to see deliveries for that agent's webhook. Omit for project-level."),
      limit: z
        .number().int().min(1).max(100)
        .default(20)
        .describe("How many of the most recent deliveries to return. If omitted, the 20 most recent are returned."),
      hours: z
        .number().int().min(1)
        .optional()
        .describe("Project-level history only: include deliveries from the last N hours. Cannot be combined with agent_id. If omitted, deliveries are returned regardless of age."),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ agent_id, limit, hours }) => {
      if (agent_id && hours !== undefined) {
        return err(new Error("hours is supported only for project-level webhook history. Omit agent_id to use hours, or omit hours to list recent deliveries for this agent."));
      }
      try {
        const result = agent_id
          ? await api.listAgentWebhookDeliveries(agent_id, limit)
          : await api.listWebhookDeliveries(limit, hours);

        if (result.data.length === 0) {
          return ok("No webhook deliveries found.", result);
        }

        const formatted = result.data
          .map(
            (d) =>
              `[${d.lastAttemptAt ?? d.createdAt}] ${d.eventType ?? "unknown"} → ${d.status} (${d.httpStatus ?? "N/A"}) id=${d.id}`
          )
          .join("\n");

        const total = "total" in result ? `\n\nTotal: ${result.total}` : "";
        return ok(
          `${result.data.length} delivery(ies):\n\n${formatted}${total}`,
          result
        );
      } catch (e) {
        return err(e);
      }
    }
  );
}
