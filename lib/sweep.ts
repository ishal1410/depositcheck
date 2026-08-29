import { timingSafeEqual } from 'node:crypto';

/**
 * Delete listing photos the analyze flow never got to.
 *
 * /api/upload is a public, unauthenticated write endpoint that publishes what
 * it accepts, because Google's servers — not the browser — fetch the image.
 * analyze deletes the object on every exit path, so a completed check leaves
 * nothing behind. A client that abandons the flow does: a world-readable
 * photograph of someone's home, at a URL nothing will ever revisit.
 *
 * That gap is two problems, not one. The photos are other people's homes. And
 * an unauthenticated public write endpoint whose objects live forever is free
 * image hosting for anyone who finds it, attached to the owner's account.
 *
 * An hour is far longer than the flow needs — a Lens lookup is capped at twenty
 * seconds — and short enough that an abandoned photo is not a lasting exposure.
 */
export const MAX_BLOB_AGE_MS = 60 * 60 * 1000;

/**
 * Ceiling on pages walked in one run. A paging bug that never cleared the
 * cursor would otherwise spin until the function timed out, every day, forever.
 */
export const MAX_PAGES = 50;

export interface StoredBlob {
  url: string;
  /** ISO-8601 from the storage API. */
  uploadedAt: string | Date;
}

export interface SweepDeps {
  /** Shared secret the scheduler presents. */
  secret: string;
  list: (cursor?: string) => Promise<{ blobs: StoredBlob[]; cursor?: string }>;
  remove: (urls: string[]) => Promise<void>;
  now?: () => number;
  maxAgeMs?: number;
}

/**
 * Constant-time, and length-checked first because timingSafeEqual throws on a
 * length mismatch rather than returning false.
 */
function authorised(header: string | null, secret: string): boolean {
  if (!header || secret.length === 0) return false;
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  const actual = Buffer.from(header, 'utf8');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export async function handleSweep(req: Request, deps: SweepDeps): Promise<Response> {
  // This endpoint deletes things. It is the one route on the app that must not
  // be callable by whoever happens to find the path.
  if (!authorised(req.headers.get('authorization'), deps.secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const now = (deps.now ?? Date.now)();
  const cutoff = now - (deps.maxAgeMs ?? MAX_BLOB_AGE_MS);

  let cursor: string | undefined;
  let scanned = 0;
  let deleted = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await deps.list(cursor);
    scanned += res.blobs.length;

    const stale = res.blobs
      .filter((b) => {
        // An unparseable timestamp yields NaN, and every comparison against NaN
        // is false — so a malformed record is kept rather than destroyed. That
        // is the safe direction for a delete: a stale photo survives one more
        // day, but a live one is never removed because its date would not read.
        return new Date(b.uploadedAt).getTime() < cutoff;
      })
      .map((b) => b.url);

    if (stale.length > 0) {
      await deps.remove(stale);
      deleted += stale.length;
    }

    cursor = res.cursor;
    if (!cursor) break;
  }

  return Response.json({ scanned, deleted });
}
