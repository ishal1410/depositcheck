import { del, list } from '@vercel/blob';
import { handleSweep } from '../../../lib/sweep';

export const runtime = 'nodejs';
/** Hobby allows up to 60s; a sweep pages through the store and then deletes. */
export const maxDuration = 60;

/**
 * Scheduled cleanup of abandoned uploads. See lib/sweep.ts for why this exists.
 *
 * GET rather than POST because that is what Vercel Cron issues. It is safe as a
 * GET only because nothing can call it without the secret — Vercel Cron sends
 * `Authorization: Bearer $CRON_SECRET` automatically once that variable is set
 * on the project, and handleSweep compares it in constant time.
 *
 * Hobby caps cron at once per day, so an abandoned photo lives at most ~24h
 * rather than the one hour the age limit names. That is the plan's ceiling, not
 * a design choice: any external scheduler hitting this same URL hourly tightens
 * it with no code change.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  // Fail closed. An absent secret must never mean "no auth required".
  if (!secret) return Response.json({ error: 'not_configured' }, { status: 500 });

  return handleSweep(req, {
    secret,
    list: async (cursor) => {
      const page = await list({ cursor, limit: 1000 });
      return { blobs: page.blobs, cursor: page.hasMore ? page.cursor : undefined };
    },
    remove: async (urls) => {
      await del(urls);
    },
  });
}
