import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Proof that an image URL was issued by our own upload endpoint.
 *
 * The hostname check in `analyze.ts` establishes that a URL points at our blob
 * store, not that the caller is entitled to act on it — and analyze deletes the
 * object it is given. Signing the object's path closes that gap: knowing a URL
 * is no longer sufficient authority to destroy it, only having been handed one.
 *
 * The path is signed rather than the whole URL so that a host or protocol
 * change cannot silently invalidate every outstanding token.
 */
function pathOf(imageUrl: string): string | null {
  try {
    return new URL(imageUrl).pathname;
  } catch {
    return null;
  }
}

export function signImageUrl(imageUrl: string, secret: string): string {
  const path = pathOf(imageUrl);
  if (path === null) throw new Error('cannot sign a malformed url');
  return createHmac('sha256', secret).update(path).digest('hex');
}

/** Constant-time comparison, so a wrong token leaks nothing about the right one. */
export function verifyImageUrl(imageUrl: string, token: unknown, secret: string): boolean {
  if (typeof token !== 'string' || token.length === 0) return false;
  const path = pathOf(imageUrl);
  if (path === null) return false;

  const expected = Buffer.from(createHmac('sha256', secret).update(path).digest('hex'), 'utf8');
  const actual = Buffer.from(token, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a rejection.
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
