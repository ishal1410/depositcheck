import { describe, expect, test } from 'vitest';
import { handleAnalyze, type AnalyzeDeps } from '../lib/analyze';
import type { LensResult } from '../lib/lens';
import type { Match } from '../lib/verdict';
import { createRateLimiter } from '../lib/ratelimit';

const BLOB_HOST = 'blob.example';
const IMAGE = `https://${BLOB_HOST}/listing-abc.jpg`;

/** The real 76-match Austin fixture, thinned to the shape classify() reads. */
function syndicated(address: string): Match[] {
  return [
    { title: `${address} - Apartments in Austin`, source: 'Zillow' },
    { title: 'Apartments For Rent in 78727 - 791 Rentals', source: 'Trulia' },
    { title: 'Lenox Grand Apartments', source: 'HotPads' },
    { title: 'River Crossing Atx - Townhome', source: 'Redfin' },
  ];
}

function ok(matches: Match[]): AnalyzeDeps['lookup'] {
  return async () => ({ ok: true, matches }) satisfies LensResult;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://x/api/analyze', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

const deps = (over: Partial<AnalyzeDeps> = {}): AnalyzeDeps => ({
  lookup: ok(syndicated('13505 Burnet Rd')),
  allowedImageHost: BLOB_HOST,
  ...over,
});

describe('handleAnalyze', () => {
  test('corroborates when the claimed address appears in the matches', async () => {
    const res = await handleAnalyze(post({ imageUrl: IMAGE, address: '13505 Burnet Rd' }), deps());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verdict).toBe('CORROBORATED');
    expect(body.addressHits).toBeGreaterThan(0);
    expect(body.sourceCount).toBe(4);
    expect(body.matches).toHaveLength(4);
  });

  // ADR-0001: absence of the claimed address no longer accuses, so this seam is
  // checked with the shape that does — one competing address, two sources.
  test('contradicts and names the address the photo really belongs to', async () => {
    const oneOtherProperty = [
      { title: '5210 Martin Ave, Austin, TX 78751 | Zillow', source: 'Zillow' },
      { title: '5210 Martin Ave, Austin, TX 78751 - HotPads', source: 'HotPads' },
    ];
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: '456 Oak Ave' }),
      deps({ lookup: ok(oneOtherProperty) }),
    );
    const body = await res.json();
    expect(body.verdict).toBe('CONTRADICTED');
    expect(body.addressHits).toBe(0);
    // The competing address must survive the trip to the client: it is the
    // evidence, and a warning the user cannot check is not much of a warning.
    expect(body.contradictingAddress).toBe('5210 Martin Ave');
  });

  test('a widely syndicated photo carrying no single address does not accuse', async () => {
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: '456 Oak Ave' }),
      deps({ lookup: ok(syndicated('13505 Burnet Rd')) }),
    );
    const body = await res.json();
    expect(body.verdict).toBe('UNVERIFIED');
    expect(body).not.toHaveProperty('contradictingAddress');
  });

  test('a photo that appears nowhere is UNVERIFIED, never a pass', async () => {
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: '13505 Burnet Rd' }),
      deps({ lookup: ok([]) }),
    );
    const body = await res.json();
    expect(body.verdict).toBe('UNVERIFIED');
    expect(body.sourceCount).toBe(0);
  });

  // The whole point of the discriminated LensResult: a failed lookup and a
  // photo found nowhere mean opposite things and must not share an output.
  test('a lens failure returns an error and NEVER a verdict', async () => {
    for (const reason of ['auth', 'quota', 'transport', 'unknown'] as const) {
      const res = await handleAnalyze(
        post({ imageUrl: IMAGE, address: '13505 Burnet Rd' }),
        deps({ lookup: async () => ({ ok: false, reason, message: 'boom' }) }),
      );
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe(reason);
      expect(body).not.toHaveProperty('verdict');
    }
  });

  test('rejects an image url that is not on our own blob host', async () => {
    // Otherwise this endpoint is a free reverse-image-search proxy funded by
    // our 250-search monthly quota.
    for (const url of [
      'https://evil.example/cat.jpg',
      'http://blob.example/x.jpg',
      'https://blob.example.evil.com/x.jpg',
      'not-a-url',
      'file:///etc/passwd',
    ]) {
      const res = await handleAnalyze(post({ imageUrl: url, address: '1 Main St' }), deps());
      expect(res.status, url).toBe(400);
      expect((await res.json()).error).toBe('invalid_image_url');
    }
  });

  test('never calls the lens when validation fails', async () => {
    let called = false;
    const spy: AnalyzeDeps['lookup'] = async () => {
      called = true;
      return { ok: true, matches: [] };
    };
    await handleAnalyze(post({ imageUrl: 'https://evil.example/x.jpg', address: 'a' }), deps({ lookup: spy }));
    expect(called).toBe(false);
  });

  test('rejects a non-POST method', async () => {
    const res = await handleAnalyze(new Request('https://x/api/analyze'), deps());
    expect(res.status).toBe(405);
  });

  test('rejects a body that is not JSON', async () => {
    const res = await handleAnalyze(post('{not json'), deps());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('bad_request');
  });

  test('rejects a missing or non-string address', async () => {
    for (const address of [undefined, 42, null, {}]) {
      const res = await handleAnalyze(post({ imageUrl: IMAGE, address }), deps());
      expect(res.status).toBe(400);
    }
  });

  test('rejects an absurdly long address instead of regexing it', async () => {
    // Over MAX_ADDRESS_CHARS but well under the body cap, so this exercises the
    // address guard rather than the 413 that a multi-KB body would trip first.
    const res = await handleAnalyze(post({ imageUrl: IMAGE, address: 'a '.repeat(300) }), deps());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('address_too_long');
  });

  test('an empty address is UNVERIFIED, not an accusation', async () => {
    const res = await handleAnalyze(post({ imageUrl: IMAGE, address: '   ' }), deps());
    expect(res.status).toBe(200);
    expect((await res.json()).verdict).toBe('UNVERIFIED');
  });

  test('gives up on an oversized body mid-stream', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode('x'.repeat(1024)));
      },
    });
    const res = await handleAnalyze(
      new Request('https://x/api/analyze', { method: 'POST', body: endless, duplex: 'half' } as RequestInit),
      deps(),
    );
    expect(res.status).toBe(413);
  });

  test('deletes the stored photo once the lookup is done', async () => {
    const discarded: string[] = [];
    await handleAnalyze(
      post({ imageUrl: IMAGE, address: '13505 Burnet Rd' }),
      deps({ discard: async (u) => void discarded.push(u) }),
    );
    expect(discarded).toEqual([IMAGE]);
  });

  test('deletes the photo even when the lookup failed', async () => {
    const discarded: string[] = [];
    await handleAnalyze(
      post({ imageUrl: IMAGE, address: '13505 Burnet Rd' }),
      deps({
        lookup: async () => ({ ok: false, reason: 'transport', message: 'x' }),
        discard: async (u) => void discarded.push(u),
      }),
    );
    expect(discarded).toEqual([IMAGE]);
  });

  test('a failed delete does not fail the analysis the user is waiting on', async () => {
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: '13505 Burnet Rd' }),
      deps({ discard: async () => { throw new Error('blob down'); } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).verdict).toBe('CORROBORATED');
  });

  test('rate limits before spending a search, and says when to retry', async () => {
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000 });
    let searches = 0;
    const counted: AnalyzeDeps['lookup'] = async () => {
      searches += 1;
      return { ok: true, matches: [] };
    };
    const d = deps({ lookup: counted, limiter });
    const send = () =>
      handleAnalyze(post({ imageUrl: IMAGE, address: '1 Main St' }, { 'x-forwarded-for': '9.9.9.9' }), d);

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(searches).toBe(2);
  });

  // BUG-1: the 429 used to return before the discard, stranding a public photo
  // of someone's home that nothing else ever deletes.
  test('deletes the photo even when the request is rate limited', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000 });
    const discarded: string[] = [];
    const d = deps({ limiter, discard: async (u) => void discarded.push(u) });
    const send = () =>
      handleAnalyze(post({ imageUrl: IMAGE, address: '1 Main St' }, { 'x-forwarded-for': '7.7.7.7' }), d);

    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect(discarded).toEqual([IMAGE, IMAGE]);
  });

  // BUG-4: possession of a URL must not be authority to have it deleted.
  test('rejects a bad token without looking anything up or deleting anything', async () => {
    let looked = false;
    const discarded: string[] = [];
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: '1 Main St', token: 'wrong' }),
      deps({
        verifyToken: () => false,
        lookup: async () => { looked = true; return { ok: true, matches: [] }; },
        discard: async (u) => void discarded.push(u),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('invalid_token');
    expect(looked).toBe(false);
    expect(discarded).toEqual([]);
  });

  test('passes the token through to the verifier and proceeds when it is good', async () => {
    const seen: unknown[] = [];
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: '13505 Burnet Rd', token: 'good' }),
      deps({ verifyToken: (_u, t) => { seen.push(t); return true; } }),
    );
    expect(seen).toEqual(['good']);
    expect(res.status).toBe(200);
  });

  // BUG-3: an unreadable address must be distinguishable from "found nothing".
  test('reports an unreadable address as its own reason', async () => {
    const res = await handleAnalyze(post({ imageUrl: IMAGE, address: 'Austin, TX' }), deps());
    const body = await res.json();
    expect(body.verdict).toBe('UNVERIFIED');
    expect(body.reason).toBe('unreadable_address');
    // Zero, not four: the lookup no longer runs for an address we cannot read,
    // so there is nothing to count. The UI suppresses the evidence list for this
    // reason anyway, so the number was never shown.
    expect(body.sourceCount).toBe(0);
  });

  // An address we cannot read is knowable without the network, and a search is
  // the one resource here that is metered and paid for.
  test('spends no search when the address cannot be read', async () => {
    let looked = 0;
    const discarded: string[] = [];
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: 'Austin, TX' }),
      deps({
        lookup: async () => { looked += 1; return { ok: true, matches: syndicated('13505 Burnet Rd') }; },
        discard: async (u) => void discarded.push(u),
      }),
    );
    expect(looked).toBe(0);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reason).toBe('unreadable_address');
    expect(body.matches).toEqual([]);
    // Still cleaned up: the short circuit must not strand a public photo.
    expect(discarded).toEqual([IMAGE]);
  });

  test('spends no search for an empty address', async () => {
    let looked = 0;
    await handleAnalyze(
      post({ imageUrl: IMAGE, address: '' }),
      deps({ lookup: async () => { looked += 1; return { ok: true, matches: [] }; } }),
    );
    expect(looked).toBe(0);
  });

  test('a readable address carries no reason', async () => {
    const res = await handleAnalyze(post({ imageUrl: IMAGE, address: '13505 Burnet Rd' }), deps());
    expect(await res.json()).not.toHaveProperty('reason');
  });

  test('the api key never reaches the client in an error message', async () => {
    const res = await handleAnalyze(
      post({ imageUrl: IMAGE, address: '1 Main St' }),
      deps({ lookup: async () => ({ ok: false, reason: 'auth', message: 'bad key sk-secret-123' }) }),
    );
    expect(JSON.stringify(await res.json())).not.toContain('sk-secret-123');
  });
});
