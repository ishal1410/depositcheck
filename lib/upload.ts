import { clientKey, type RateLimiter } from './ratelimit';

export type ImageType = 'jpeg' | 'png' | 'webp';

/**
 * 4 MB, set by the deploy target rather than by taste.
 *
 * Vercel caps a function's request body at 4.5 MB and rejects anything larger
 * with its own 413 before this handler is ever invoked — so a higher limit here
 * would be a promise the platform breaks, and it would break it with a non-JSON
 * error body the client cannot parse. The remaining ~0.5 MB is headroom for
 * request headers. Listing photos measured off real CDNs run 25 KB to ~2 MB and
 * fit comfortably; a phone camera original may not, and client-side downscaling
 * before upload is the fix when that starts to bite.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export type SizeCheck =
  | { ok: true }
  | { ok: false; reason: 'too_large' | 'length_required' | 'empty' };

/**
 * Decide on the declared Content-Length, before the body is read.
 *
 * Checking after buffering is too late — the bytes are already in memory, which
 * is the thing the limit exists to prevent. A missing or unparseable length is
 * refused rather than assumed small: the header is client-supplied, so the only
 * safe default is to require it. The body must still be counted while streaming,
 * since a client can declare one length and send another.
 */
export function checkDeclaredSize(contentLength: string | null): SizeCheck {
  if (contentLength === null) return { ok: false, reason: 'length_required' };
  if (!/^\d+$/.test(contentLength.trim())) return { ok: false, reason: 'length_required' };
  const declared = Number(contentLength);
  if (!Number.isSafeInteger(declared)) return { ok: false, reason: 'length_required' };
  if (declared === 0) return { ok: false, reason: 'empty' };
  if (declared > MAX_UPLOAD_BYTES) return { ok: false, reason: 'too_large' };
  return { ok: true };
}

export type ReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'too_large' | 'empty' };

/**
 * Read a request body, giving up as soon as it passes `limit`.
 *
 * Content-Length is a claim, not a fact: a client can declare 10 bytes and
 * stream megabytes. `checkDeclaredSize` is the cheap gate that rejects obvious
 * abuse without reading anything; this is the one that actually holds, because
 * it counts bytes as they arrive and cancels the stream mid-flight rather than
 * buffering the whole body and measuring afterwards.
 */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<ReadResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return { ok: false, reason: 'empty' };

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return { ok: true, bytes };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((b, i) => bytes[i] === b);
}

/**
 * Identify an image by its leading bytes, or null if it is not one we accept.
 *
 * Content-Type is attacker-controlled, so it is never consulted: an HTML or SVG
 * payload sent as image/jpeg must be rejected on its bytes. SVG is excluded
 * deliberately even though it is an image — it can carry script, and no listing
 * site serves photos as SVG. WebP is included because Zillow and Redfin both
 * serve it, so omitting it would reject the most common real input.
 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, PNG_SIGNATURE)) return 'png';
  // "RIFF" then a 4-byte length then "WEBP"; RIFF alone is also WAV and AVI.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'webp';
  }
  return null;
}

export interface UploadDeps {
  /**
   * `token` proves to /api/analyze that this URL came from here. Optional so
   * tests and any future store can omit it; the analyze side decides whether a
   * missing token is acceptable.
   */
  store: (bytes: Uint8Array, type: ImageType) => Promise<{ url: string; token?: string }>;
  limiter?: RateLimiter;
}

/**
 * Accept one uploaded photo and return a URL Google Lens can fetch.
 *
 * Ordered cheapest-rejection-first: method, then the caller's quota, then the
 * declared length (no body read), then the streamed body against the same cap,
 * then the magic bytes. Storage is only ever reached by bytes that passed all
 * five, so a malformed or oversized upload never becomes a stored object or a
 * public URL.
 */
export async function handleUpload(req: Request, deps: UploadDeps): Promise<Response> {
  if (req.method !== 'POST') {
    return Response.json({ error: 'method_not_allowed' }, { status: 405 });
  }

  // Ahead of the body read, unlike analyze: here the body IS the payload, and
  // metering after reading it would already have spent the memory the limit
  // exists to protect.
  if (deps.limiter) {
    const gate = deps.limiter(clientKey(req));
    if (!gate.ok) {
      return Response.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
      );
    }
  }

  const declared = checkDeclaredSize(req.headers.get('content-length'));
  if (!declared.ok) {
    return Response.json(
      { error: declared.reason },
      { status: declared.reason === 'too_large' ? 413 : 400 },
    );
  }



  if (!req.body) return Response.json({ error: 'empty' }, { status: 400 });

  const read = await readCapped(req.body, MAX_UPLOAD_BYTES);
  if (!read.ok) {
    return Response.json({ error: read.reason }, { status: read.reason === 'too_large' ? 413 : 400 });
  }

  const type = sniffImage(read.bytes);
  if (!type) return Response.json({ error: 'unsupported_type' }, { status: 415 });

  try {
    const { url, token } = await deps.store(read.bytes, type);
    return Response.json({ url, ...(token ? { token } : {}) });
  } catch (e) {
    // The cause may carry storage credentials or internal hostnames, so the
    // client is told only that storage failed — and the detail goes to the log,
    // which is the only place an operator can tell an expired blob token apart
    // from a dead network. Swallowing it left them a bare 502 and nothing else.
    console.error('upload: blob store failed', e);
    return Response.json({ error: 'storage_unavailable' }, { status: 502 });
  }
}
