/**
 * Wakeshift events: wake the agent that asked when something happens, instead
 * of having it poll.
 *
 * message.received — a message arrived on one of the account's numbers.
 * Subscribed by watch_messages, which keeps the conversation subscribed (one
 * wake per message) until the subscription expires or is ended. The AgentPhone
 * backend reports each inbound message to POST /internal/events/message-received
 * (see docs/backend-events.md), and that route emits the event. Nothing polls.
 *
 * Wakeshift is on only on the HTTP transport with both WAKESHIFT_KEY and
 * AGENTPHONE_EVENTS_SECRET set; otherwise watch_messages isn't offered, nothing
 * is sent to Wakeshift, and every tool behaves as it did before.
 */

import { createHash } from "node:crypto";
import { Wakeshift, encodeArgValue } from "@wakeshift/sdk";
import { z } from "zod";

export const wake = new Wakeshift();

type NumberArgs = { number: string };

/** A watch ends after this long with no message delivered and no renewal (calling watch_messages again). */
export const WATCH_TTL = "24h";

export const messageReceived = wake.defineEvent("message.received", {
  description: "A message arrived on one of your AgentPhone numbers",
  args: z.object({ number: z.string() }),
  payload: z.object({
    number_id: z.string(),
    message_id: z.string(),
    from: z.string().nullable(),
    received_at: z.string(),
  }),
});

/** The event's routing value for a number ID (IDs may be case-sensitive). */
export function numberArg(numberId: string): NumberArgs {
  return { number: encodeArgValue(numberId) };
}

/**
 * Subscribe the calling conversation to every message on a number. Calling it
 * again renews the subscription. The tool must already have checked that the
 * caller can read the number.
 */
export function watchNumber(numberId: string) {
  return wake.currentCall().subscribe(messageReceived, numberArg(numberId), { ttl: WATCH_TTL });
}

export type MessageReceived = {
  number_id: string;
  message_id: string;
  from: string | null;
  received_at: string;
};

/**
 * The emit id for one message: a hash of the number and message IDs, so it
 * has a fixed length (Wakeshift takes at most 200 characters) and two
 * different messages never share one, however long their IDs are.
 */
export function messageEventId(numberId: string, messageId: string): string {
  return "msg-" + createHash("sha256").update(`${numberId}\n${messageId}`).digest("hex");
}

/**
 * Emits one message.received. The id comes from the message, so a retried
 * report of the same message wakes once.
 */
export function emitMessageReceived(m: MessageReceived) {
  return messageReceived.emit(numberArg(m.number_id), m, { id: messageEventId(m.number_id, m.message_id) });
}

/** Tools that subscribe, for attach's `wrap`. */
export const WAKESHIFT_WRAP = {
  watch_messages: [messageReceived],
};

/**
 * Output schemas of the tools registered only when Wakeshift is on. Kept apart
 * from OUTPUT_SCHEMAS, which must match the tools registered without it.
 */
export const WAKESHIFT_OUTPUT_SCHEMAS: Record<string, z.ZodTypeAny> = {
  watch_messages: z
    .object({
      watching: z
        .array(
          z.object({
            number_id: z.string().describe("A number being watched."),
            phone_number: z.string().describe("Its phone number, in E.164 form."),
          })
        )
        .describe("Every number this call is watching."),
    })
    .describe("The numbers now being watched for inbound messages."),
};
