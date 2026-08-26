import { describe, expect, test } from 'vitest';
import { MAX_UPLOAD_BYTES as MAX, handleUpload } from '../lib/upload';
import { createRateLimiter } from '../lib/ratelimit';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function req(body: Uint8Array<ArrayBuffer>, contentLength?: string) {
  // Blob, not the raw Uint8Array: it is a valid BodyInit and still gives
  // req.body as a ReadableStream, which is what readCapped consumes.
  return new Request('https://x/api/upload', {
    method: 'POST',
    body: new Blob([body]),
    headers: { 'content-length': contentLength ?? String(body.length) },
  });
}

const store = async () => ({ url: 'https://blob.example/abc.jpg' });

describe('handleUpload', () => {
  test('stores a valid image and returns its public url', async () => {
    const res = await handleUpload(req(jpeg), { store });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://blob.example/abc.jpg' });
  });

  test('rejects a non-image on its bytes, whatever the content-type claims', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    const res = await handleUpload(req(html), { store });
    expect(res.status).toBe(415);
    expect((await res.json()).error).toBe('unsupported_type');
  });

  test('never calls storage when validation fails', async () => {
    let called = false;
    const spy = async () => { called = true; return { url: 'x' }; };
    await handleUpload(req(new TextEncoder().encode('nope')), { store: spy });
    expect(called).toBe(false);
  });

  test('rejects a declared length over the cap without reading the body', async () => {
    const res = await handleUpload(req(jpeg, String(MAX + 1)), { store });
    expect(res.status).toBe(413);
  });

  test('rejects a request with no content-length header', async () => {
    const res = await handleUpload(new Request('https://x/api/upload', { method: 'POST' }), { store });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('length_required');
  });

  test('rejects a declared length with no body behind it', async () => {
    // Passes the declared-size gate, then has nothing to read. Without the
    // null-body guard this reaches readCapped and throws.
    const res = await handleUpload(
      new Request('https://x/api/upload', { method: 'POST', headers: { 'content-length': '8' } }),
      { store },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('empty');
  });

  test('accepts a PNG', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await handleUpload(req(png), { store })).status).toBe(200);
  });

  test('accepts a WebP, the format Zillow and Redfin serve', async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
    expect((await handleUpload(req(webp), { store })).status).toBe(200);
  });

  test('passes the sniffed type to storage, not any client-supplied type', async () => {
    let seen = '';
    const spy = async (_b: Uint8Array, t: string) => { seen = t; return { url: 'u' }; };
    await handleUpload(req(jpeg), { store: spy as never });
    expect(seen).toBe('jpeg');
  });

  test('rejects a method other than POST', async () => {
    const res = await handleUpload(new Request('https://x/api/upload', { method: 'GET' }), { store });
    expect(res.status).toBe(405);
  });

  test('reports a storage failure as a server error, not as success', async () => {
    const boom = async () => { throw new Error('blob store down'); };
    const res = await handleUpload(req(jpeg), { store: boom });
    expect(res.status).toBe(502);
  });

  test('does not leak an internal error message to the client', async () => {
    const boom = async () => { throw new Error('BLOB_TOKEN=secret123 refused'); };
    const res = await handleUpload(req(jpeg), { store: boom });
    expect(JSON.stringify(await res.json())).not.toContain('secret123');
  });

  test('rate limits before the body is read or anything is stored', async () => {
    // The free blob tier locks the whole store for 30 days once exceeded, so an
    // unmetered upload endpoint is a denial-of-service against the app itself.
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    let stored = 0;
    const counted = async () => { stored += 1; return { url: 'https://blob.example/a.jpg' }; };
    const send = () =>
      handleUpload(
        new Request('https://x/api/upload', {
          method: 'POST',
          body: new Blob([jpeg]),
          headers: { 'content-length': String(jpeg.length), 'x-forwarded-for': '9.9.9.9' },
        }),
        { store: counted, limiter },
      );

    expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(stored).toBe(1);
  });

  test('separate clients get separate buckets', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const send = (ip: string) =>
      handleUpload(
        new Request('https://x/api/upload', {
          method: 'POST',
          body: new Blob([jpeg]),
          headers: { 'content-length': String(jpeg.length), 'x-forwarded-for': ip },
        }),
        { store, limiter },
      );

    expect((await send('1.1.1.1')).status).toBe(200);
    expect((await send('2.2.2.2')).status).toBe(200);
  });
});
