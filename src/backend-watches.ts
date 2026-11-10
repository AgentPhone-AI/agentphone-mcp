/**
 * Registering a watched number with the AgentPhone backend.
 *
 * When watch_messages subscribes (or renews) a Wakeshift watch on a number,
 * it also tells the backend to keep emitting message.received for that number,
 * by POSTing to /internal/watches. With the filter on (MCP_EVENTS_WATCHED_ONLY),
 * the backend only emits for numbers registered this way, instead of every
 * inbound message. Requests are signed with Standard Webhooks using the same
 * AGENTPHONE_EVENTS_SECRET this server verifies inbound events with.
 *
 * Best-effort by design: registration never blocks or fails watch_messages. A
 * failed or unconfigured call just means no wake for that number until the next
 * renewal, and the backend fails open (emits everything) until the filter is on.
 */

import { randomUUID } from "node:crypto";
import { sign } from "./backend-events.js";

export const WATCH_REGISTER_PATH = "/internal/watches";

/** How long the backend POST may take before we give up (best-effort). */
const REGISTER_TIMEOUT_MS = 4000;

export type RegisterWatchOutcome =
  | "watched" // 200, backend is now emitting for this number
  | "not_watched" // 200 but watched=false (e.g. ttl_seconds=0 drop)
  | "disabled" // 404: backend has no secret / filter not enabled — keep going
  | "rejected" // 401/422: signature or body problem
  | "error"; // network/timeout/5xx

export type WatchRegistrar = (numberId: string, ttlSeconds: number) => Promise<RegisterWatchOutcome>;

/**
 * Builds a registrar bound to one backend and signing key. The returned
 * function never throws: callers can fire it without a try/catch.
 */
export function makeWatchRegistrar(opts: { baseUrl: string; key: Buffer }): WatchRegistrar {
  const url = `${opts.baseUrl.replace(/\/$/, "")}${WATCH_REGISTER_PATH}`;
  return async (numberId: string, ttlSeconds: number): Promise<RegisterWatchOutcome> => {
    const body = JSON.stringify({ number_id: numberId, ttl_seconds: ttlSeconds });
    const id = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REGISTER_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": sign(opts.key, id, timestamp, body),
        },
        body,
        signal: controller.signal,
      });
      if (res.status === 404) return "disabled";
      if (res.status === 401 || res.status === 422) return "rejected";
      if (!res.ok) return "error";
      // 2xx: watched unless the backend says otherwise (e.g. a ttl_seconds=0 drop).
      let watched = true;
      try {
        const parsed = (await res.json()) as { watched?: unknown };
        if (typeof parsed?.watched === "boolean") watched = parsed.watched;
      } catch {
        // A 2xx without a JSON body still counts as registered.
      }
      return watched ? "watched" : "not_watched";
    } catch {
      // Network error, timeout, or abort: best-effort, so swallow it.
      return "error";
    } finally {
      clearTimeout(timer);
    }
  };
}
