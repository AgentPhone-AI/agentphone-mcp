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
 * A backend watch expires on a wall clock, but the Wakeshift subscription it
 * backs is an idle timeout that slides on every delivered message — so a busy
 * number can stay subscribed in Wakeshift long after its backend watch would
 * expire, and (with the filter on) silently stop being emitted for. This wraps
 * a registrar to re-register a number's watch when a message is delivered for
 * it, sliding its expiry the same way, so the two clocks stay together.
 *
 * Throttled to at most once per number per `minIntervalMs` (far under the TTL)
 * so a high-traffic number doesn't POST on every message. Best-effort and
 * synchronous to the caller: it never throws and never blocks the emit path.
 */
export function makeWatchRefresher(
  register: WatchRegistrar,
  ttlSeconds: number,
  minIntervalMs = 60 * 60 * 1000
): (numberId: string) => void {
  const lastSlid = new Map<string, number>();
  return (numberId: string): void => {
    const now = Date.now();
    const prev = lastSlid.get(numberId);
    if (prev !== undefined && now - prev < minIntervalMs) return;
    lastSlid.set(numberId, now);
    // Drop entries that can't still be backing a live watch, so the map stays
    // bounded by the numbers watched within one TTL rather than growing forever.
    if (lastSlid.size > 10000) {
      const cutoff = now - ttlSeconds * 1000;
      for (const [id, at] of lastSlid) if (at < cutoff) lastSlid.delete(id);
    }
    // register never throws, but swallow a rejection defensively so a caller's
    // registrar can't leak an unhandled rejection from this fire-and-forget.
    register(numberId, ttlSeconds).catch(() => {});
  };
}

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
      try {
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
      } finally {
        // Drain the body on the paths that returned without reading it (the
        // 404 path is hit on every call until the filter is on), so the
        // connection can be reused instead of the socket staying busy.
        if (res.body && !res.bodyUsed) {
          try {
            await res.body.cancel();
          } catch {
            // Already consumed or closed: nothing to release.
          }
        }
      }
    } catch (err) {
      // Network error, timeout, or abort: best-effort, so don't propagate, but
      // leave a trace (name only) so suppressed wakes are diagnosable.
      console.error("watch registration failed:", err instanceof Error ? err.name : typeof err);
      return "error";
    } finally {
      clearTimeout(timer);
    }
  };
}
