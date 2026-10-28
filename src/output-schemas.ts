/**
 * Output schemas for the MCP tools.
 *
 * Each tool returns a human-readable text block AND a `structuredContent`
 * object so clients can interpret the result's fields directly. These schemas
 * describe that structured object — including a `.describe()` on every field so
 * an agent can interpret the result without guessing — and are advertised on
 * tools/list.
 *
 * Shapes mirror the AgentPhone REST responses in api.ts. Fields a tool always
 * returns are marked required; the rest stay optional, and each object is
 * `.passthrough()`, for two reasons:
 *   1. The structured payload is a faithful superset of the real result, so
 *      backend additions never break validation.
 *   2. Some tools have more than one success shape (e.g. buy_number's
 *      confirmation prompt vs. the purchased number, or get_usage's summary vs.
 *      time-series), and a permissive schema covers each without inventing a
 *      shape the server does not actually return.
 *
 * The MCP SDK validates `structuredContent` against the matching schema on
 * every successful call (error results are exempt), so these must stay aligned
 * with what the handlers return.
 */

import { z } from "zod";

// --- Reusable field groups (all optional; names/types mirror api.ts) ---

const numberFields = {
  id: z.string().optional().describe("The phone number's unique ID (use as number_id elsewhere)."),
  phoneNumber: z.string().optional().describe("The number in E.164 format, e.g. +14155550123."),
  country: z.string().optional().describe("ISO country code the number belongs to."),
  status: z.string().optional().describe("Provisioning/service status of the number."),
  agentId: z.string().nullable().optional().describe("ID of the agent this number is assigned to, or null if unassigned."),
  createdAt: z.string().optional().describe("When the number was provisioned (ISO 8601)."),
};

const agentNumber = z
  .object({
    id: z.string().optional().describe("The phone number's ID."),
    phoneNumber: z.string().optional().describe("The number in E.164 format."),
    status: z.string().optional().describe("Service status of the number."),
  })
  .passthrough()
  .describe("A phone number attached to the agent.");

const agentFields = {
  id: z.string().describe("The agent's unique ID (use as agent_id elsewhere)."),
  name: z.string().optional().describe("Human-readable agent name."),
  description: z.string().nullable().optional().describe("Free-text note about the agent's purpose."),
  voiceMode: z.string().optional().describe("'webhook' (your backend drives calls) or 'hosted' (built-in AI)."),
  systemPrompt: z.string().nullable().optional().describe("Instructions for the hosted AI on calls, or null."),
  beginMessage: z.string().nullable().optional().describe("Opening line the hosted AI speaks, or null."),
  voice: z.string().optional().describe("Voice ID the agent speaks with."),
  modelTier: z.string().optional().describe("Model quality/speed tier: turbo, balanced, max, or realtime."),
  transferNumber: z.string().nullable().optional().describe("E.164 number calls transfer to, or null if disabled."),
  voicemailMessage: z.string().nullable().optional().describe("Voicemail greeting text, or null if disabled."),
  sttMode: z.string().optional().describe("Speech-to-text mode: fast or accurate."),
  ambientSound: z.string().optional().describe("Background ambience played on calls."),
  denoisingMode: z.string().optional().describe("Audio denoising mode applied to calls."),
  maxSilenceMs: z.number().optional().describe("Milliseconds of caller silence before the call ends."),
  enableMessaging: z.boolean().optional().describe("Whether the hosted agent can send/read texts mid-call."),
  enableBackchannel: z.boolean().optional().describe("Whether the agent interjects 'mhmm' while the caller speaks."),
  interruptionSensitivity: z.number().optional().describe("How readily the agent lets a caller interrupt (0-1)."),
  voiceSpeed: z.number().optional().describe("Speech rate multiplier (1 = normal)."),
  language: z.string().optional().describe("BCP-47 locale for speech, e.g. en-US."),
  createdAt: z.string().optional().describe("When the agent was created (ISO 8601)."),
  numbers: z.array(agentNumber).optional().describe("Phone numbers attached to this agent."),
};
const agentObject = z.object(agentFields).passthrough().describe("An AgentPhone agent and its configuration.");

const callFields = {
  id: z.string().describe("The call's unique ID (use as call_id in get_call)."),
  fromNumber: z.string().optional().describe("Caller number in E.164 format."),
  toNumber: z.string().optional().describe("Callee number in E.164 format."),
  direction: z.string().optional().describe("'inbound' or 'outbound'."),
  status: z.string().optional().describe("Call status, e.g. ringing, in-progress, completed, failed."),
  startedAt: z.string().optional().describe("When the call started (ISO 8601)."),
  endedAt: z.string().nullable().optional().describe("When the call ended (ISO 8601), or null if still active."),
  agentId: z.string().nullable().optional().describe("ID of the agent that handled the call, or null."),
  phoneNumberId: z.string().optional().describe("ID of the phone number used for the call."),
  retellCallId: z.string().nullable().optional().describe("Provider-side call ID, or null."),
};
const transcriptEntry = z
  .object({
    id: z.string().optional().describe("Transcript turn ID."),
    transcript: z.string().optional().describe("What the human said on this turn."),
    response: z.string().nullable().optional().describe("What the agent said in response, or null."),
    createdAt: z.string().optional().describe("Timestamp of this turn (ISO 8601)."),
  })
  .passthrough()
  .describe("One human/agent turn of the call transcript.");
const callObject = z
  .object({ ...callFields, transcripts: z.array(transcriptEntry).optional().describe("Ordered transcript turns, when available.") })
  .passthrough()
  .describe("A phone call and, when available, its transcript.");

const conversationFields = {
  id: z.string().describe("The conversation's unique ID (use as conversation_id)."),
  agentId: z.string().nullable().optional().describe("ID of the agent on this thread, or null."),
  phoneNumberId: z.string().optional().describe("ID of your phone number in this thread."),
  phoneNumber: z.string().optional().describe("Your number in E.164 format."),
  participant: z.string().optional().describe("The external contact's number in E.164 format."),
  lastMessageAt: z.string().nullable().optional().describe("Time of the most recent message (ISO 8601), or null."),
  lastMessagePreview: z.string().optional().describe("Short preview of the latest message."),
  messageCount: z.number().optional().describe("Total messages in the conversation."),
  metadata: z.record(z.string(), z.unknown()).nullable().optional().describe("Custom state stored on the conversation, or null."),
  createdAt: z.string().optional().describe("When the conversation started (ISO 8601)."),
};

const contactFields = {
  id: z.string().optional().describe("The contact's unique ID (use as contact_id)."),
  phoneNumber: z.string().optional().describe("Contact's number in E.164 format."),
  name: z.string().optional().describe("Contact's name."),
  email: z.string().nullable().optional().describe("Contact's email, or null."),
  notes: z.string().nullable().optional().describe("Free-text notes about the contact, or null."),
  createdAt: z.string().optional().describe("When the contact was created (ISO 8601)."),
  updatedAt: z.string().optional().describe("When the contact was last updated (ISO 8601)."),
};

const webhookFields = {
  id: z.string().optional().describe("The webhook's unique ID."),
  url: z.string().optional().describe("Endpoint events are POSTed to."),
  secret: z.string().optional().describe("Signing secret for verifying payloads. Masked unless reveal_secret=true."),
  status: z.string().optional().describe("Webhook status, e.g. active."),
  contextLimit: z.number().optional().describe("Recent messages included with each event as context."),
  createdAt: z.string().optional().describe("When the webhook was configured (ISO 8601)."),
};

const deliveryEntry = z
  .object({
    id: z.string().optional().describe("Delivery attempt ID."),
    event: z.string().optional().describe("Event type that was delivered."),
    statusCode: z.number().nullable().optional().describe("HTTP status your endpoint returned, or null."),
    success: z.boolean().optional().describe("Whether the delivery succeeded."),
    deliveredAt: z.string().optional().describe("When the delivery was attempted (ISO 8601)."),
    responseMs: z.number().nullable().optional().describe("Your endpoint's response time in ms, or null."),
  })
  .passthrough()
  .describe("One webhook delivery attempt.");

const voiceEntry = z
  .object({
    voice_id: z.string().optional().describe("Voice ID to set on an agent's voice field."),
    voice_name: z.string().optional().describe("Human-readable voice name."),
    provider: z.string().optional().describe("Voice provider."),
    gender: z.string().optional().describe("Perceived voice gender."),
    accent: z.string().optional().describe("Voice accent."),
    preview_audio_url: z.string().nullable().optional().describe("URL to a sample clip, or null."),
  })
  .passthrough()
  .describe("A voice available for agents.");

const messageEntry = z
  .object({
    id: z.string().optional().describe("Message ID."),
    from: z.string().optional().describe("Sender number (get_messages shape)."),
    to: z.string().optional().describe("Recipient number (get_messages shape)."),
    fromNumber: z.string().optional().describe("Sender number (conversation shape)."),
    toNumber: z.string().optional().describe("Recipient number (conversation shape)."),
    body: z.string().optional().describe("Message text."),
    direction: z.string().optional().describe("'inbound' or 'outbound'."),
    receivedAt: z.string().optional().describe("When the message was sent/received (ISO 8601)."),
  })
  .passthrough()
  .describe("A single SMS/iMessage.");

const usageNumbers = z
  .object({
    used: z.number().optional().describe("Phone numbers currently provisioned."),
    limit: z.number().optional().describe("Maximum numbers allowed."),
    remaining: z.number().optional().describe("Numbers still available to provision."),
  })
  .passthrough()
  .describe("Phone-number usage against the account limit.");

// Pagination metadata shared by list results.
const listMeta = {
  hasMore: z.boolean().optional().describe("Whether more results exist beyond this page."),
  total: z.number().optional().describe("Total matching records across all pages."),
};

// --- Per-tool output schemas ---

export const OUTPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  account_overview: z
    .object({
      usage: usageNumbers.nullable().optional().describe("Phone-number usage; omitted if the lookup failed."),
      agents: z.array(agentObject).nullable().optional().describe("The account's agents (omitted if the lookup failed)."),
      numbers: z.array(z.object(numberFields).passthrough().describe("A phone number in the account.")).nullable().optional().describe("The account's phone numbers (omitted if the lookup failed)."),
      webhook: z
        .object({
          url: z.string().optional().describe("Project webhook URL."),
          status: z.string().optional().describe("Project webhook status."),
        })
        .passthrough()
        .nullable()
        .optional()
        .describe("Project-level webhook summary; null if none is configured, omitted if the lookup failed."),
      recentActivity: z
        .object({
          messagesLast30d: z.number().optional().describe("Messages in the last 30 days."),
          callsLast30d: z.number().optional().describe("Calls in the last 30 days."),
        })
        .passthrough()
        .optional()
        .describe("Recent 30-day activity totals."),
    })
    .passthrough()
    .describe("Snapshot of the account: usage, agents, numbers, webhook, and recent activity."),

  list_numbers: z
    .object({
      data: z.array(z.object(numberFields).passthrough().describe("A phone number in the account.")).describe("The phone numbers on this page."),
      ...listMeta,
    })
    .passthrough()
    .describe("A page of the account's phone numbers."),

  buy_number: z
    .object({
      ...numberFields,
      confirmationRequired: z.boolean().optional().describe("True when the call only previewed the purchase; re-call with confirm=true to buy."),
    })
    .passthrough()
    .describe("The purchased phone number, or a confirmation-required notice when confirm was false."),

  send_message: z
    .object({
      id: z.string().describe("The sent message's ID (or the reaction's ID)."),
      status: z.string().optional().describe("Delivery status of the message."),
      channel: z.string().nullable().optional().describe("Channel used: sms or imessage, or null."),
      from_number: z.string().optional().describe("Number the message was sent from."),
      to_number: z.string().optional().describe("Recipient number."),
      media_urls: z.array(z.string()).optional().describe("Media attachments sent."),
      reply_to_message_id: z.string().nullable().optional().describe("Message this was threaded under, or null."),
      reply_parent_unresolved: z.boolean().nullable().optional().describe("True if the reply parent could not be threaded."),
      reaction_type: z.string().optional().describe("Reaction applied (reaction mode only)."),
      message_id: z.string().optional().describe("Message the reaction was applied to (reaction mode only)."),
    })
    .passthrough()
    .describe("The sent message, or the applied reaction when reacting."),

  get_messages: z
    .object({
      data: z.array(messageEntry).describe("Messages for the number, newest first."),
      ...listMeta,
    })
    .passthrough()
    .describe("Messages for a specific phone number."),

  list_calls: z
    .object({ data: z.array(callObject).describe("Calls on this page."), ...listMeta })
    .passthrough()
    .describe("A page of calls."),

  get_call: callObject,

  make_call: callObject.describe("The initiated outbound call."),

  make_conversation_call: callObject.describe("The call, with transcript turns when available."),

  list_agents: z
    .object({ data: z.array(agentObject).describe("Agents on this page."), ...listMeta })
    .passthrough()
    .describe("A page of agents."),

  create_agent: agentObject.describe("The newly created agent."),

  update_agent: agentObject.describe("The updated agent."),

  delete_agent: z
    .object({
      success: z.boolean().describe("Whether the delete succeeded."),
      id: z.string().describe("ID of the deleted agent."),
      name: z.string().describe("Name of the deleted agent."),
    })
    .passthrough()
    .describe("Confirmation of the deleted agent."),

  get_agent: agentObject.describe("The requested agent and its full configuration."),

  attach_number: z
    .object({
      agentId: z.string().describe("ID of the agent the number was attached to."),
      number: agentNumber.describe("The attached phone number."),
    })
    .passthrough()
    .describe("The attachment result: the number and the agent it now belongs to."),

  detach_number: z
    .object({ success: z.boolean().describe("Whether the detach succeeded.") })
    .passthrough()
    .describe("Confirmation that the number was detached."),

  list_voices: z
    .object({ data: z.array(voiceEntry).describe("Available voices.") })
    .passthrough()
    .describe("Voices available for agents."),

  list_conversations: z
    .object({
      data: z.array(z.object(conversationFields).passthrough().describe("An SMS conversation thread.")).describe("Conversations on this page."),
      ...listMeta,
    })
    .passthrough()
    .describe("A page of SMS conversations."),

  get_conversation: z
    .object({
      ...conversationFields,
      messages: z.array(messageEntry).optional().describe("The conversation's messages, up to message_limit."),
    })
    .passthrough()
    .describe("One SMS conversation with its message history."),

  update_conversation: z.object(conversationFields).passthrough().describe("The conversation after its metadata was updated."),

  list_contacts: z
    .object({
      data: z.array(z.object(contactFields).passthrough().describe("A saved contact.")).describe("Contacts on this page."),
      ...listMeta,
    })
    .passthrough()
    .describe("A page of saved contacts."),

  manage_contact: z
    .object({
      ...contactFields,
      success: z.boolean().optional().describe("Present on delete: whether it succeeded."),
    })
    .passthrough()
    .describe("The saved contact (create/update), or a success flag (delete)."),

  get_usage: z
    .object({
      numbers: usageNumbers.optional().describe("Phone-number usage (summary mode)."),
      stats: z.record(z.string(), z.number()).optional().describe("Message/call/webhook totals (summary mode)."),
      periodStart: z.string().optional().describe("Start of the summary period (ISO 8601)."),
      periodEnd: z.string().optional().describe("End of the summary period (ISO 8601)."),
      breakdown: z.string().optional().describe("Which breakdown was returned."),
      data: z
        .array(
          z
            .object({
              date: z.string().optional().describe("Day of the bucket (daily mode)."),
              month: z.string().optional().describe("Month of the bucket (monthly mode)."),
              messages: z.number().optional().describe("Messages in the bucket."),
              calls: z.number().optional().describe("Calls in the bucket."),
              webhooks: z.number().optional().describe("Webhook deliveries in the bucket."),
            })
            .passthrough()
            .describe("One time-series bucket.")
        )
        .optional()
        .describe("Per-day or per-month series (time-series modes)."),
      days: z.number().optional().describe("Days covered (daily mode)."),
      months: z.number().optional().describe("Months covered (monthly mode)."),
    })
    .passthrough()
    .describe("Account usage: a summary, or a daily/monthly time series."),

  get_webhook: z
    .object({
      ...webhookFields,
      configured: z.boolean().optional().describe("False when no webhook is configured."),
    })
    .passthrough()
    .describe("The webhook configuration (secret masked unless reveal_secret=true)."),

  set_webhook: z.object(webhookFields).passthrough().describe("The saved webhook (secret masked unless reveal_secret=true)."),

  delete_webhook: z
    .object({ success: z.boolean().describe("Whether the delete succeeded.") })
    .passthrough()
    .describe("Confirmation that the webhook was removed."),

  test_webhook: z
    .object({
      success: z.boolean().describe("Whether the test event was delivered."),
      statusCode: z.number().nullable().describe("HTTP status your endpoint returned, or null."),
      responseMs: z.number().nullable().describe("Your endpoint's response time in ms, or null."),
      error: z.string().nullable().describe("Error message if the test failed, or null."),
    })
    .passthrough()
    .describe("The result of sending a test event to the webhook."),

  list_webhook_deliveries: z
    .object({ data: z.array(deliveryEntry).describe("Recent delivery attempts."), ...listMeta })
    .passthrough()
    .describe("A page of webhook delivery history."),
};
