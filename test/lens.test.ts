import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { fetchExactMatches } from '../lib/lens';

const fixture = readFileSync(new URL('./fixtures/lens-zillow-lenox-grand.json', import.meta.url), 'utf8');

/** A fetch stand-in that returns one canned HTTP response. */
function stubFetch(body: string, status = 200) {
  return async () => new Response(body, { status });
}

describe('fetchExactMatches', () => {
  test('returns the matches from a real SerpApi response', async () => {
    const r = await fetchExactMatches('https://img.example/x.jpg', 'k', { fetch: stubFetch(fixture) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matches).toHaveLength(76);
  });

  test('requests type=exact_matches, the image url, and the key', async () => {
    let seen = '';
    const spy = async (u: string | URL | Request) => {
      seen = String(u);
      return new Response(fixture, { status: 200 });
    };
    await fetchExactMatches('https://img.example/x.jpg', 'SECRET', { fetch: spy as typeof fetch });
    const q = new URL(seen).searchParams;
    expect(q.get('engine')).toBe('google_lens');
    // Without type=exact_matches the response has no exact_matches key at all.
    expect(q.get('type')).toBe('exact_matches');
    expect(q.get('url')).toBe('https://img.example/x.jpg');
    expect(q.get('api_key')).toBe('SECRET');
  });

  test('treats "no results" as zero matches, not as a failure', async () => {
    // Observed live on a real Craigslist photo. SerpApi reports this as an
    // error field on an HTTP 200, but it means the photo appears nowhere,
    // which the verdict engine must see as UNVERIFIED rather than a crash.
    const body = JSON.stringify({ error: "Google Lens hasn't returned any results for this query." });
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch(body) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matches).toEqual([]);
  });

  test('reports quota exhaustion as a failure', async () => {
    const body = JSON.stringify({ error: 'You have exceeded your searches per month.' });
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch(body) });
    expect(r).toMatchObject({ ok: false, reason: 'quota' });
  });

  test('reports a bad key as a failure', async () => {
    const body = JSON.stringify({ error: 'Invalid API key. Your API key should be here.' });
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch(body) });
    expect(r).toMatchObject({ ok: false, reason: 'auth' });
  });

  test('reports a non-JSON body as a failure rather than throwing', async () => {
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch('<html>502 Bad Gateway</html>', 502) });
    expect(r).toMatchObject({ ok: false, reason: 'transport' });
  });

  // The status line is the only evidence left when the body names no error.
  // Reading it as success would manufacture "the photo appears nowhere" out of
  // a call that never succeeded - the two answers this type exists to separate.
  test('reports a non-2xx JSON body carrying no error field as a failure', async () => {
    const body = JSON.stringify({ search_metadata: { status: 'Error' } });
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch(body, 503) });
    expect(r.ok).toBe(false);
  });

  test('an ordinary 200 with an empty match list is still a real answer', async () => {
    const body = JSON.stringify({ exact_matches: [] });
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch(body, 200) });
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.matches).toEqual([]);
  });

  test('reports a network throw as a failure', async () => {
    const boom = async () => { throw new Error('ECONNRESET'); };
    const r = await fetchExactMatches('u', 'k', { fetch: boom as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, reason: 'transport' });
  });

  test('never leaks the api key into the failure message', async () => {
    const boom = async () => { throw new Error('connect failed to serpapi.com?api_key=SECRETKEY'); };
    const r = await fetchExactMatches('u', 'SECRETKEY', { fetch: boom as unknown as typeof fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).not.toContain('SECRETKEY');
  });

  test('aborts a hanging request and reports transport failure', async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted')));
      });
    const r = await fetchExactMatches('u', 'k', { fetch: hang, timeoutMs: 10 });
    expect(r).toMatchObject({ ok: false, reason: 'transport' });
  });

  test('classifies a quota message that also mentions the api key as quota', async () => {
    // Both words appear; running out of searches is the actionable cause.
    const body = JSON.stringify({ error: 'You have run out of searches. Upgrade your API key plan.' });
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch(body) });
    expect(r).toMatchObject({ ok: false, reason: 'quota' });
  });

  test('returns no matches when the response omits exact_matches entirely', async () => {
    const r = await fetchExactMatches('u', 'k', { fetch: stubFetch(JSON.stringify({ search_metadata: {} })) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matches).toEqual([]);
  });
});
