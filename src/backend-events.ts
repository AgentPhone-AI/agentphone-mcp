/**
 * Events pushed by the AgentPhone backend.
 *
 * POST /internal/events/message-received lets the backend tell this server the
 * moment a message arrives, so it emits Wakeshift's message.received without
 * polling. Requests are signed with Standard Webhooks
 * (https://www.standardwebhooks.com/) using AGENTPHONE_EVENTS_SECRET.
 * See docs/backend-events.md.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const MESSAGE_RECEIVED_PATH = "/internal/events/message-received";

/** The largest body accepted; a message.received notification is a few hundred bytes. */
export const MAX_EVENT_BODY_BYTES = 16 * 1024;

/** How far a request's timestamp may be from this server's clock. */
const TOLERANCE_SECONDS = 5 * 60;

export const messageReceivedBody = z.object({
  number_id: z.string().min(1).max(200),
  message_id: z.string().min(1).max(200),
  from: z.string().max(200).nullable(),
  received_at: z.string().min(1).max(64),
});
export type MessageReceivedBody = z.infer<typeof messageReceivedBody>;

/**
 * The HMAC key of a Standard Webhooks secret: the base64 after `whsec_`.
 * Throws on a secret that isn't one, so a misconfiguration fails at startup.
 */
export function signingKey(secret: string): Buffer {
  const match = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret.trim());
  const key = match ? Buffer.from(match[1], "base64") : Buffer.alloc(0);
  if (key.length < 24) {
    throw new Error("AGENTPHONE_EVENTS_SECRET must be a Standard Webhooks secret: whsec_ followed by at least 24 bytes of base64.");
  }
  return key;
}

/** The value of a webhook-signature header for this request (for senders and tests). */
export function sign(key: Buffer, id: string, timestamp: number, body: string): string {
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
}

/** Whether the request carries a valid, current Standard Webhooks signature. */
export function verify(
  key: Buffer,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  now = Math.floor(Date.now() / 1000)
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(sign(key, id, Number(timestamp), body));
  // The header may list several space-separated signatures (during a secret rotation).
  return signature.split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

export type PushResult = { status: number; body?: Record<string, unknown> };

/**
 * Handles one request to MESSAGE_RECEIVED_PATH: verifies it, validates the
 * body, and calls emit. Kept apart from the HTTP framework so it can be tested.
 */
export async function handleMessageReceived(
  key: Buffer,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  rawBody: string,
  emit: (body: MessageReceivedBody) => Promise<unknown>
): Promise<PushResult> {
  if (!verify(key, headers, rawBody)) {
    return { status: 401, body: { error: "invalid_signature" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  const result = messageReceivedBody.safeParse(parsed);
  if (!result.success) {
    return {
      status: 400,
      body: { error: "invalid_body", fields: [...new Set(result.error.issues.map((i) => i.path.join(".")))] },
    };
  }
  try {
    await emit(result.data);
  } catch (err) {
    // Wakeshift unreachable or refused: ask the sender to retry. Retries are
    // safe because the emit's id comes from the message ID.
    console.error("message.received push: emit failed:", err instanceof Error ? err.name : typeof err);
    return { status: 502, body: { error: "emit_failed" } };
  }
  return { status: 204 };
}
