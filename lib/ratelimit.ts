const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/**
 * The rate-limit bucket for a request.
 *
 * On Vercel these headers are trustworthy: the docs state Vercel overwrites
 * `X-Forwarded-For` and does not forward external IPs, "to prevent IP spoofing".
 * `x-vercel-forwarded-for` is preferred because it survives a proxy placed in
 * front of Vercel, where `x-forwarded-for` can be replaced.
 *
 * Off Vercel — local dev, another host — these are ordinary client-supplied
 * headers and can be forged. A forged value only ever buys the attacker their
 * own bucket, and anything unparseable collapses into one shared "unknown"
 * bucket, so a flood of junk values cannot mint unlimited fresh quotas.
 */
export function clientKey(req: Request): string {
  const raw =
    req.headers.get('x-vercel-forwarded-for') ??
    req.headers.get('x-forwarded-for') ??
    req.headers.get('x-real-ip');
  const first = raw?.split(',')[0]?.trim() ?? '';
  if (IPV4.test(first) || (first.includes(':') && IPV6.test(first))) return first;
  return 'unknown';
}

export type RateResult =
  | { ok: true; remaining: number }
  | { ok: false; retryAfterSec: number };

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

/**
 * Ceiling on tracked keys. Without it the limiter is itself a memory-exhaustion
 * vector: an attacker rotating source addresses allocates one entry per request.
 */
export const MAX_TRACKED_KEYS = 10_000;

export interface RateLimiter {
  (key: string, now?: number): RateResult;
  /** Entries currently tracked. Exposed so the eviction behaviour is testable. */
  size(): number;
}

/**
 * Fixed-window limiter held in process memory.
 *
 * ponytail: known ceiling — serverless runs many isolated instances, so each
 * one enforces its own window and a cold start resets the count. This bounds
 * abuse rather than eliminating it, which is the right trade for a free-tier
 * app whose failure mode is a blocked blob store rather than a breach. Upgrade
 * path if it ever matters: swap the Map for Upstash Redis (free tier) and keep
 * this signature.
 *
 * A factory, not a shared singleton, so tests never leak counts into each other.
 */
export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, { count: number; windowStart: number }>();

  const limiter = (key: string, now: number = Date.now()): RateResult => {
    // Evicting on write keeps this O(1) amortised without a background timer,
    // which serverless would not reliably run anyway.
    if (hits.size >= MAX_TRACKED_KEYS) {
      for (const [k, v] of hits) {
        if (now - v.windowStart >= opts.windowMs) hits.delete(k);
      }
      // Still full: every entry is live, so drop the oldest-inserted. Map
      // iteration is insertion-ordered, so the first key is the oldest.
      while (hits.size >= MAX_TRACKED_KEYS) {
        const oldest = hits.keys().next();
        if (oldest.done) break;
        hits.delete(oldest.value);
      }
    }

    const entry = hits.get(key);
    if (!entry || now - entry.windowStart >= opts.windowMs) {
      hits.set(key, { count: 1, windowStart: now });
      return { ok: true, remaining: opts.limit - 1 };
    }

    if (entry.count >= opts.limit) {
      const elapsed = now - entry.windowStart;
      return { ok: false, retryAfterSec: Math.ceil((opts.windowMs - elapsed) / 1000) };
    }

    entry.count += 1;
    return { ok: true, remaining: opts.limit - entry.count };
  };

  limiter.size = () => hits.size;
  return limiter;
}
