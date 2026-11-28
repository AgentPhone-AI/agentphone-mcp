/**
 * Caller identity for Wakeshift (attach's `identify`).
 *
 * Wakeshift binds a subscribe voucher to who received it. Without identify
 * every caller is anonymous, so a voucher binds to the Mcp-Session-Id it was
 * handed out in — and ChatGPT redeems from a later session, where redemption
 * is always refused ("this voucher can't subscribe...": seen live, 2026-11-27).
 * With identify, the voucher binds to the caller's AgentPhone account, and any
 * later session presenting a credential for the same account may redeem it
 * (within the voucher's four hours). Native subscriptions and
 * list_subscriptions get a user the same way.
 *
 * The account comes from the backend (GET /v1/me) because OAuth access tokens
 * rotate while the account stays the same: the token itself is not a stable
 * identity. Lookups are cached per credential so events/* requests don't add
 * a backend round trip each time.
 *
 * Outcomes map onto the SDK's two identify signals, which behave differently:
 *
 * - No credential, one the backend REJECTS (401/403), or a backend that does
 *   not serve /v1/me at all (404): resolve undefined. To Wakeshift that
 *   caller is anonymous, the pre-identify behavior, so either side can
 *   deploy or roll back first without subscribes starting to fail.
 * - The lookup FAILS (timeout, 5xx, network): throw. The SDK then refuses
 *   Wakeshift's part of that one request: a tool's subscribe fails visibly
 *   (watch_messages reports the error; its backend lookups were failing too),
 *   and an open events/stream gets the retryable path instead of being
 *   revoked. Resolving undefined here instead would silently hand out a
 *   session-bound voucher the client can never redeem, and would terminate
 *   live streams as "revoked" on the next 5-minute recheck.
 *
 * Both non-success outcomes are cached only briefly, so one stray 401 against
 * a just-rotated token cannot strand it, and a backend blip is retried soon.
 */

import { createHash } from "node:crypto";

/** How long one credential's resolved account is reused. */
export const IDENTITY_TTL_MS = 10 * 60_000;

/**
 * How long a non-success (rejected credential, or failed lookup) is held
 * before the next request triggers a fresh lookup. Short on purpose: it only
 * exists to stop a burst from hammering the backend.
 */
export const IDENTITY_FAIL_TTL_MS = 30_000;

/** Entries are swept once the cache grows past this many credentials. */
const MAX_ENTRIES = 10_000;

export type IdentityLookup = (credential: string) => Promise<string>;

export type MakeIdentifyOptions = {
  /** The request's credential, or "" when it has none ("" is never looked up). */
  credential: () => string;
  /**
   * Resolve a credential to its account id. A throw whose `status` is 401 or
   * 403 means the backend rejected the credential, and 404 means it doesn't
   * serve /v1/me yet (deploy order): both leave the caller anonymous. Any
   * other throw is a transient failure and is rethrown to the SDK.
   */
  lookup: IdentityLookup;
  /** Test hook: the clock. */
  now?: () => number;
};

type CacheEntry =
  | { kind: "user"; user: string; expires: number }
  | { kind: "anonymous"; expires: number }
  | { kind: "failed"; error: unknown; expires: number };

/**
 * Build the identify callback for wake.attach: `{ user }` for a resolved
 * credential, undefined for an anonymous one, a throw for a lookup that
 * failed (see the header for what each does).
 */
export function makeIdentify(opts: MakeIdentifyOptions): () => Promise<{ user: string } | undefined> {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  // One lookup per credential at a time: a burst of events/* requests for the
  // same credential shares one outcome instead of stampeding the backend.
  const inflight = new Map<string, Promise<{ user: string } | undefined>>();

  const sweep = (at: number) => {
    if (cache.size < MAX_ENTRIES) return;
    for (const [k, v] of cache) if (v.expires <= at) cache.delete(k);
    // Still at the cap (that many live credentials, or a flood of junk
    // bearers): evict oldest-inserted entries so the map is truly bounded.
    while (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  return async () => {
    let credential = "";
    try {
      credential = opts.credential() || "";
    } catch {
      return undefined;
    }
    if (!credential) return undefined;
    const key = createHash("sha256").update(credential).digest("hex");
    const at = now();
    const hit = cache.get(key);
    if (hit && hit.expires > at) {
      if (hit.kind === "user") return { user: hit.user };
      if (hit.kind === "anonymous") return undefined;
      throw hit.error;
    }

    const pending = inflight.get(key);
    if (pending) return pending;

    // Registered in `inflight` before the lookup starts (the .then body runs
    // on a microtask): a lookup that throws synchronously would otherwise run
    // its cleanup first and leave a settled promise in `inflight` forever.
    const run = Promise.resolve().then(async () => {
      try {
        const user = await opts.lookup(credential);
        sweep(at);
        cache.set(key, { kind: "user", user, expires: at + IDENTITY_TTL_MS });
        return { user };
      } catch (err) {
        const status = (err as { status?: unknown })?.status;
        // 404: the backend doesn't serve /v1/me (deploy order, a rollback,
        // or a misrouted base URL). Anonymous keeps every subscribe working
        // as it did pre-identify; the log keeps a misroute from being silent.
        if (status === 404) {
          console.error("identity: GET /v1/me returned 404; callers stay anonymous until the backend serves it.");
        }
        const rejected = status === 401 || status === 403 || status === 404;
        sweep(at);
        cache.set(
          key,
          rejected
            ? { kind: "anonymous", expires: at + IDENTITY_FAIL_TTL_MS }
            : { kind: "failed", error: err, expires: at + IDENTITY_FAIL_TTL_MS }
        );
        if (rejected) return undefined;
        throw err;
      } finally {
        inflight.delete(key);
      }
    });
    inflight.set(key, run);
    return run;
  };
}
