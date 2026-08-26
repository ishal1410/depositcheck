import { put } from '@vercel/blob';
import { handleUpload, type ImageType } from '../../../lib/upload';
import { createRateLimiter } from '../../../lib/ratelimit';
import { signImageUrl } from '../../../lib/uploadToken';

const EXTENSION: Record<ImageType, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Deliberately looser than the five-an-hour on /api/analyze. The scarce
 * resource is the search quota, not storage, and a stricter cap here would
 * block the re-upload a retry needs before the analyze limiter ever saw it.
 */
const limiter = createRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 });

/**
 * Store one uploaded photo and hand back a URL Google Lens can fetch.
 *
 * The blob must be publicly readable because Google's servers fetch it, not the
 * browser — so this endpoint publishes whatever it accepts. /api/analyze deletes
 * the blob as soon as the lookup returns, so a photo is normally public only for
 * the few seconds Lens needs to read it.
 *
 * KNOWN GAP: an upload that is never analyzed is never deleted — a client that
 * abandons the flow leaves a world-readable photo of someone's home behind. The
 * rate limit bounds how many, but does not clean them up; a scheduled sweep of
 * blobs older than an hour is the fix.
 */
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.UPLOAD_TOKEN_SECRET;
  if (!secret) return Response.json({ error: 'not_configured' }, { status: 500 });

  return handleUpload(req, {
    limiter,
    store: async (bytes, type) => {
      const blob = await put(`listing-${crypto.randomUUID()}.${EXTENSION[type]}`, Buffer.from(bytes), {
        access: 'public',
        contentType: `image/${type}`,
        // The name already carries a v4 UUID, so no extra suffix is needed to
        // make it unguessable.
        addRandomSuffix: false,
      });
      // The token is what /api/analyze checks before it deletes this object, so
      // a URL alone is never enough authority to destroy someone else's photo.
      return { url: blob.url, token: signImageUrl(blob.url, secret) };
    },
  });
}
