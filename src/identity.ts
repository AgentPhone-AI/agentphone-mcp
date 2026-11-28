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
 * a backend round trip each time. Every failure means "anonymous", never a
 * refused request: the server then behaves exactly as it did before identify
 * existed (voucher bound to the transport session).
 */

import { createHash } from "node:crypto";

/** How long one credential's resolved identity (or confirmed rejection) is reused. */
export const IDENTITY_TTL_MS = 10 * 60_000;

/** How long a lookup failure (backend unreachable, 5xx) suppresses retries. */
export const IDENTITY_FAIL_TTL_MS = 30_000;

/** Entries are swept once the cache grows past this many credentials. */
const MAX_ENTRIES = 10_000;

export type IdentityLookup = (credential: string) => Promise<string>;

export type MakeIdentifyOptions = {
  /** The request's credential, or "" when it has none ("" is never looked up). */
  credential: () => string;
  /**
   * Resolve a credential to its account id. A throw whose `status` is 401 or
   * 403 means the credential is invalid (cached as anonymous for the full
   * TTL); any other throw is a transient failure (cached for the short TTL).
   */
  lookup: IdentityLookup;
  /** Test hook: the clock. */
  now?: () => number;
};

type CacheEntry = { user: string | undefined; expires: number };

/**
 * Build the identify callback for wake.attach. Returns `{ user }` for a
 * resolved credential and undefined otherwise. Never throws: identify failing
 * would make Wakeshift refuse the request outright, which is worse than the
 * anonymous fallback.
 */
export function makeIdentify(opts: MakeIdentifyOptions): () => Promise<{ user: string } | undefined> {
  const now = opts.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  // One lookup per credential at a time: a burst of events/* requests for the
  // same credential shares the result instead of stampeding the backend.
  const inflight = new Map<string, Promise<{ user: string } | undefined>>();

  const sweep = (at: number) => {
    if (cache.size <= MAX_ENTRIES) return;
    for (const [k, v] of cache) if (v.expires <= at) cache.delete(k);
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
    if (hit && hit.expires > at) return hit.user === undefined ? undefined : { user: hit.user };

    const pending = inflight.get(key);
    if (pending) return pending;

    const run = (async () => {
      try {
        const user = await opts.lookup(credential);
        sweep(at);
        cache.set(key, { user, expires: at + IDENTITY_TTL_MS });
        return { user };
      } catch (err) {
        const status = (err as { status?: unknown })?.status;
        const rejected = status === 401 || status === 403;
        sweep(at);
        cache.set(key, {
          user: undefined,
          expires: at + (rejected ? IDENTITY_TTL_MS : IDENTITY_FAIL_TTL_MS),
        });
        return undefined;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, run);
    return run;
  };
}
