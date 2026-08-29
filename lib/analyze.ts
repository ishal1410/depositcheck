import { readCapped } from './upload';
import { streetCandidates } from './address';
import { classify, type Match } from './verdict';
import type { LensResult } from './lens';
import { clientKey, type RateLimiter } from './ratelimit';

/**
 * 8 KB. The body is two short strings; anything larger is not a listing
 * address. Small enough that the cap itself is never a memory concern.
 */
export const MAX_BODY_BYTES = 8 * 1024;

/**
 * A street address that does not fit in 200 characters is not one. The cap is
 * an input guard, not a formatting opinion: `streetCandidates` builds a regex
 * per token, so an unbounded string is a CPU sink at the trust boundary.
 */
export const MAX_ADDRESS_CHARS = 200;

export interface AnalyzeDeps {
  lookup: (imageUrl: string) => Promise<LensResult>;
  /** Host of our own blob store. Only images we stored may be looked up. */
  allowedImageHost: string;
  /** Best-effort removal of the stored photo once we are done with it. */
  discard?: (imageUrl: string) => Promise<void>;
  limiter?: RateLimiter;
  /**
   * Proves this URL was handed out by our own upload endpoint to whoever is
   * calling. Without it the hostname check is the only gate, and a bare URL is
   * enough authority to have someone else's photo deleted.
   */
  verifyToken?: (imageUrl: string, token: unknown) => boolean;
  /**
   * Is the stored photo still there?
   *
   * Fails closed: anything other than a confirmed hit counts as gone, so a
   * transient storage blip costs the caller a re-upload rather than buying them
   * a fabricated answer.
   */
  exists?: (imageUrl: string) => Promise<boolean>;
}

/**
 * Is this a URL we ourselves issued?
 *
 * An open URL parameter here would make the endpoint a public reverse-image
 * search proxy paid for out of a 250-search monthly quota, and — if the fetch
 * were ever moved server-side — an SSRF hole pointed at cloud metadata.
 */
function isOurBlob(raw: unknown, allowedHost: string): raw is string {
  if (typeof raw !== 'string') return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // Exact host match, not endsWith: "blob.example.evil.com" ends with the
  // allowed host and is controlled by someone else entirely.
  return url.protocol === 'https:' && url.hostname === allowedHost;
}

/** Accept an image URL we issued plus a claimed address, and return a verdict. */
export async function handleAnalyze(req: Request, deps: AnalyzeDeps): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }
  if (!req.body) return Response.json({ error: 'bad_request' }, { status: 400 });

  const read = await readCapped(req.body, MAX_BODY_BYTES);
  if (!read.ok) {
    return read.reason === 'too_large'
      ? Response.json({ error: 'too_large' }, { status: 413 })
      : Response.json({ error: 'bad_request' }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }

  const { imageUrl, address, token } = parsed as {
    imageUrl?: unknown;
    address?: unknown;
    token?: unknown;
  };

  if (!isOurBlob(imageUrl, deps.allowedImageHost)) {
    return Response.json({ error: 'invalid_image_url' }, { status: 400 });
  }
  if (typeof address !== 'string') {
    return Response.json({ error: 'bad_request' }, { status: 400 });
  }
  if (address.length > MAX_ADDRESS_CHARS) {
    return Response.json({ error: 'address_too_long' }, { status: 400 });
  }

  // Possession of the URL is not authority to act on it. Checked before the
  // limiter so a forged URL never reaches the discard in the finally below.
  if (deps.verifyToken && !deps.verifyToken(imageUrl, token)) {
    return Response.json({ error: 'invalid_token' }, { status: 403 });
  }

  /*
   * A URL we issued is not the same thing as a photo that is still there, and
   * the gap between those two is a fabricated verdict.
   *
   * Every exit path below deletes the blob, while the token signs only the path
   * and never expires — so the same imageUrl and token replay cleanly once the
   * object is gone. MEASURED, not assumed: SerpApi answers a 404 image URL with
   * "Google Lens hasn't returned any results for this query" on an HTTP 200,
   * which lens.ts correctly reads as a genuine "found nowhere". The replay
   * therefore buys a confident "this photo does not appear elsewhere online"
   * about a photo that was never searched, and spends a search to do it.
   *
   * Checked here rather than patched into the 429 path alone, because the same
   * replay exists after any exit that discards: rate limit, unreadable address,
   * or a completed check.
   */
  if (deps.exists && !(await deps.exists(imageUrl))) {
    return Response.json({ error: 'invalid_image_url' }, { status: 400 });
  }

  // From here the photo is ours to clean up on every exit, including the early
  // returns below. Leaving it behind on a refused request would strand a
  // world-readable picture of someone's home that nothing else ever deletes.
  try {
    // Ahead of both the limiter and the search. An address with no street
    // number cannot be compared against anything, and that is knowable without
    // the network — while the search below is metered and paid for. classify()
    // keeps the same guard as the invariant for any other caller; this one only
    // stops us buying an answer we already have. Inside the try so the finally
    // still discards the photo.
    if (streetCandidates(address).length === 0) {
      return Response.json({
        verdict: 'UNVERIFIED',
        sourceCount: 0,
        addressHits: 0,
        reason: 'unreadable_address',
        matches: [],
      });
    }

    // Limited here rather than at the top: a malformed request costs nothing,
    // and the resource actually worth protecting is the search quota below.
    if (deps.limiter) {
      const gate = deps.limiter(clientKey(req));
      if (!gate.ok) {
        return Response.json(
          { error: 'rate_limited' },
          { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
        );
      }
    }

    const result = await deps.lookup(imageUrl);

    if (!result.ok) {
      // No verdict field, deliberately. "We could not check" and "we checked and
      // found nothing" are opposite answers and must not share a shape. The
      // reason code only — `message` may quote the upstream request line.
      return Response.json({ error: result.reason }, { status: 502 });
    }

    const { verdict, sourceCount, addressHits, reason, contradictingAddress } = classify(
      result.matches,
      { address },
    );
    return Response.json({
      verdict,
      sourceCount,
      addressHits,
      // Carried through so the UI can say "we could not read that address"
      // instead of "not enough copies" while listing the copies it found.
      ...(reason ? { reason } : {}),
      // The address the photo was actually found to belong to. This is the
      // evidence behind an accusation, so it has to reach the person deciding
      // whether to wire money.
      ...(contradictingAddress ? { contradictingAddress } : {}),
      // Re-projected rather than passed through: these rows are third-party data
      // heading for a UI, and every field is optional at the source.
      matches: result.matches.map((m: Match) => ({
        title: typeof m?.title === 'string' ? m.title : '',
        source: typeof m?.source === 'string' ? m.source : '',
        link: typeof m?.link === 'string' ? m.link : '',
      })),
    });
  } finally {
    // A storage failure here is ours, not the user's: it must never discard an
    // answer they already spent a search on.
    if (deps.discard) {
      await deps.discard(imageUrl).catch(() => {});
    }
  }
}
