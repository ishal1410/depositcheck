import { del } from '@vercel/blob';
import { handleAnalyze } from '../../../lib/analyze';
import { fetchExactMatches } from '../../../lib/lens';
import { createRateLimiter } from '../../../lib/ratelimit';
import { verifyImageUrl } from '../../../lib/uploadToken';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Five checks an hour per address.
 *
 * ponytail: known ceiling — the account holds 250 searches a month, so a
 * determined single caller can still drain it in a couple of days. That is
 * accepted: exhaustion surfaces as a `quota` error, which the analyze handler
 * reports as a failure and never as a verdict, so the worst case is an app
 * that says "could not check" rather than one that answers wrongly.
 */
const limiter = createRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 });

export async function POST(req: Request): Promise<Response> {
  const apiKey = process.env.SERPAPI_KEY;
  const allowedImageHost = process.env.BLOB_PUBLIC_HOST;
  const secret = process.env.UPLOAD_TOKEN_SECRET;

  // Failing closed on purpose. An absent host would otherwise mean "no host is
  // allowed" only by accident, and a future refactor of the check could quietly
  // turn it into "every host is allowed" — which is the quota-theft hole.
  if (!apiKey || !allowedImageHost || !secret) {
    return Response.json({ error: 'not_configured' }, { status: 500 });
  }

  return handleAnalyze(req, {
    allowedImageHost,
    verifyToken: (imageUrl, token) => verifyImageUrl(imageUrl, token, secret),
    lookup: (imageUrl) => fetchExactMatches(imageUrl, apiKey),
    discard: async (imageUrl) => {
      await del(imageUrl);
    },
    limiter,
  });
}
