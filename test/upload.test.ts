import { describe, expect, test } from 'vitest';
import { MAX_UPLOAD_BYTES, checkDeclaredSize, readCapped, sniffImage } from '../lib/upload';

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** RIFF....WEBP - the format Zillow and Redfin actually serve. */
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const bytesOf = (s: string) => new TextEncoder().encode(s);

describe('sniffImage', () => {
  test('identifies a JPEG from its magic bytes', () => {
    expect(sniffImage(jpeg)).toBe('jpeg');
  });

  test('identifies a PNG from its magic bytes', () => {
    expect(sniffImage(png)).toBe('png');
  });

  test('identifies a WebP from its magic bytes', () => {
    expect(sniffImage(webp)).toBe('webp');
  });

  test('rejects HTML even though it may arrive with an image content-type', () => {
    expect(sniffImage(bytesOf('<!doctype html><script>alert(1)</script>'))).toBeNull();
  });

  test('rejects SVG, which is a script vector rather than a raster image', () => {
    expect(sniffImage(bytesOf('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull();
  });

  test('rejects a GIF, which is not a listing photo format we accept', () => {
    expect(sniffImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
  });

  test('rejects an empty buffer', () => {
    expect(sniffImage(new Uint8Array([]))).toBeNull();
  });

  test('rejects a truncated header rather than reading past the end', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  test('rejects RIFF that is not WebP', () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]);
    expect(sniffImage(wav)).toBeNull();
  });
});

describe('checkDeclaredSize', () => {
  test('accepts a normal listing photo', () => {
    expect(checkDeclaredSize('250000')).toEqual({ ok: true });
  });

  test('rejects a declared length over the limit before any buffering', () => {
    expect(checkDeclaredSize(String(MAX_UPLOAD_BYTES + 1))).toMatchObject({ ok: false, reason: 'too_large' });
  });

  test('rejects a missing content-length rather than trusting it', () => {
    expect(checkDeclaredSize(null)).toMatchObject({ ok: false, reason: 'length_required' });
  });

  test('rejects a non-numeric content-length', () => {
    expect(checkDeclaredSize('abc')).toMatchObject({ ok: false, reason: 'length_required' });
  });

  test('rejects a negative content-length', () => {
    expect(checkDeclaredSize('-1')).toMatchObject({ ok: false, reason: 'length_required' });
  });

  test('rejects an empty body', () => {
    expect(checkDeclaredSize('0')).toMatchObject({ ok: false, reason: 'empty' });
  });
});

describe('readCapped', () => {
  function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(c) {
        for (const chunk of chunks) c.enqueue(chunk);
        c.close();
      },
    });
  }

  test('returns the joined bytes when under the cap', async () => {
    const r = await readCapped(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.bytes]).toEqual([1, 2, 3]);
  });

  test('stops when the real body exceeds the cap despite a small declared length', async () => {
    // The attack: Content-Length says 10, the body keeps coming.
    const big = new Uint8Array(1000);
    const r = await readCapped(streamOf(big, big, big), 1500);
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
  });

  test('does not buffer the whole oversized body before giving up', async () => {
    let produced = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        produced += 1;
        c.enqueue(new Uint8Array(1024));
        if (produced > 10_000) c.close();
      },
    });
    const r = await readCapped(endless, 4096);
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(produced).toBeLessThan(50);
  });

  test('rejects an empty stream', async () => {
    const r = await readCapped(streamOf(), 10);
    expect(r).toMatchObject({ ok: false, reason: 'empty' });
  });
});
