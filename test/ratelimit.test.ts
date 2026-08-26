import { describe, expect, test } from 'vitest';
import { MAX_TRACKED_KEYS, clientKey, createRateLimiter } from '../lib/ratelimit';

describe('createRateLimiter', () => {
  test('allows requests up to the limit', () => {
    const limit = createRateLimiter({ limit: 3, windowMs: 60_000 });
    expect(limit('ip-a', 0).ok).toBe(true);
    expect(limit('ip-a', 1).ok).toBe(true);
    expect(limit('ip-a', 2).ok).toBe(true);
  });

  test('blocks the request that exceeds the limit', () => {
    const limit = createRateLimiter({ limit: 2, windowMs: 60_000 });
    limit('ip-a', 0);
    limit('ip-a', 1);
    expect(limit('ip-a', 2).ok).toBe(false);
  });

  test('reports how long to wait, rounded up to whole seconds', () => {
    const limit = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limit('ip-a', 0);
    const r = limit('ip-a', 1_500);
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.retryAfterSec).toBe(59);
  });

  test('allows again once the window has passed', () => {
    const limit = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limit('ip-a', 0);
    expect(limit('ip-a', 30_000).ok).toBe(false);
    expect(limit('ip-a', 60_001).ok).toBe(true);
  });

  test('counts each key separately', () => {
    const limit = createRateLimiter({ limit: 1, windowMs: 60_000 });
    limit('ip-a', 0);
    expect(limit('ip-b', 0).ok).toBe(true);
    expect(limit('ip-a', 0).ok).toBe(false);
  });

  test('does not grow without bound when every request has a new key', () => {
    // Otherwise the limiter is itself a memory-exhaustion vector: an attacker
    // rotating source addresses would allocate one entry per request forever.
    const limit = createRateLimiter({ limit: 5, windowMs: 60_000 });
    for (let i = 0; i < MAX_TRACKED_KEYS * 3; i++) limit(`ip-${i}`, i);
    expect(limit.size()).toBeLessThanOrEqual(MAX_TRACKED_KEYS);
  });

  test('resets an expired key rather than accumulating its old count', () => {
    // Eviction is lazy (only under key pressure), so an idle entry lingers in
    // the map. What must not linger is its count.
    const limit = createRateLimiter({ limit: 2, windowMs: 1_000 });
    limit('ip-a', 0);
    limit('ip-a', 100);
    expect(limit('ip-a', 200).ok).toBe(false);
    const afterWindow = limit('ip-a', 5_000);
    expect(afterWindow).toMatchObject({ ok: true, remaining: 1 });
  });

  test('reclaims expired entries once the key ceiling is reached', () => {
    const limit = createRateLimiter({ limit: 5, windowMs: 1_000 });
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) limit(`old-${i}`, 0);
    expect(limit.size()).toBe(MAX_TRACKED_KEYS);
    limit('fresh', 10_000);
    expect(limit.size()).toBe(1);
  });
});

describe('clientKey', () => {
  const withHeaders = (h: Record<string, string>) =>
    new Request('https://x/api/upload', { method: 'POST', headers: h });

  test('uses the Vercel-set forwarded-for address', () => {
    expect(clientKey(withHeaders({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  test('prefers x-vercel-forwarded-for, which survives a proxy in front', () => {
    const req = withHeaders({
      'x-vercel-forwarded-for': '203.0.113.7',
      'x-forwarded-for': '198.51.100.1',
    });
    expect(clientKey(req)).toBe('203.0.113.7');
  });

  test('takes only the first address when a list is present', () => {
    expect(clientKey(withHeaders({ 'x-forwarded-for': '203.0.113.7, 198.51.100.1' }))).toBe('203.0.113.7');
  });

  test('ignores a value that is not an IP address', () => {
    // Off Vercel these headers are fully client-controlled. A junk value must
    // not become its own bucket, or every request invents a fresh quota.
    expect(clientKey(withHeaders({ 'x-forwarded-for': 'not-an-ip' }))).toBe('unknown');
  });

  test('falls back to a single shared bucket when no address is present', () => {
    // Shared, deliberately: one throttled bucket is safer than unlimited.
    expect(clientKey(withHeaders({}))).toBe('unknown');
  });

  test('accepts an IPv6 address', () => {
    expect(clientKey(withHeaders({ 'x-forwarded-for': '2001:db8::1' }))).toBe('2001:db8::1');
  });
});
