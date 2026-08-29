import { describe, expect, test } from 'vitest';
import { handleSweep, MAX_PAGES, type SweepDeps, type StoredBlob } from '../lib/sweep';

const SECRET = 'cron-secret-value';
const NOW = Date.parse('2026-08-29T12:00:00.000Z');

/** Minutes before NOW, as the ISO string the storage API returns. */
function agedMinutes(min: number): string {
  return new Date(NOW - min * 60_000).toISOString();
}

function get(auth?: string) {
  return new Request('https://x/api/cleanup', {
    method: 'GET',
    headers: auth ? { authorization: auth } : {},
  });
}

function deps(
  blobs: StoredBlob[],
  over: Partial<SweepDeps> = {},
): SweepDeps & { removed: string[] } {
  const removed: string[] = [];
  return {
    secret: SECRET,
    now: () => NOW,
    list: async () => ({ blobs }),
    remove: async (urls) => {
      removed.push(...urls);
    },
    removed,
    ...over,
  };
}

describe('handleSweep', () => {
  test('refuses a caller with no authorization header', async () => {
    const d = deps([{ url: 'https://b/old.jpg', uploadedAt: agedMinutes(600) }]);
    const res = await handleSweep(get(), d);
    expect(res.status).toBe(401);
    // The important half: refused means nothing was deleted.
    expect(d.removed).toEqual([]);
  });

  test('refuses a wrong secret, including one of the same length', async () => {
    const d = deps([{ url: 'https://b/old.jpg', uploadedAt: agedMinutes(600) }]);
    expect((await handleSweep(get('Bearer nope'), d)).status).toBe(401);
    const sameLength = `Bearer ${'x'.repeat(SECRET.length)}`;
    expect((await handleSweep(get(sameLength), d)).status).toBe(401);
    expect(d.removed).toEqual([]);
  });

  test('deletes only photos past the age limit', async () => {
    const d = deps([
      { url: 'https://b/fresh.jpg', uploadedAt: agedMinutes(5) },
      { url: 'https://b/inflight.jpg', uploadedAt: agedMinutes(59) },
      { url: 'https://b/abandoned.jpg', uploadedAt: agedMinutes(61) },
      { url: 'https://b/ancient.jpg', uploadedAt: agedMinutes(60 * 48) },
    ]);
    const res = await handleSweep(get(`Bearer ${SECRET}`), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scanned: 4, deleted: 2 });
    expect(d.removed).toEqual(['https://b/abandoned.jpg', 'https://b/ancient.jpg']);
  });

  /*
   * A delete driven by a date must fail towards keeping the file. If a
   * malformed timestamp parsed as NaN were treated as "old", one bad record
   * from the storage API would wipe photos mid-check.
   */
  test('keeps a photo whose timestamp cannot be read', async () => {
    const d = deps([
      { url: 'https://b/unreadable.jpg', uploadedAt: 'not a date' },
      { url: 'https://b/empty.jpg', uploadedAt: '' },
    ]);
    await handleSweep(get(`Bearer ${SECRET}`), d);
    expect(d.removed).toEqual([]);
  });

  test('walks every page of the listing', async () => {
    const pages: Record<string, { blobs: StoredBlob[]; cursor?: string }> = {
      start: { blobs: [{ url: 'https://b/1.jpg', uploadedAt: agedMinutes(600) }], cursor: 'p2' },
      p2: { blobs: [{ url: 'https://b/2.jpg', uploadedAt: agedMinutes(600) }] },
    };
    const d = deps([], { list: async (cursor) => pages[cursor ?? 'start'] });
    const res = await handleSweep(get(`Bearer ${SECRET}`), d);
    expect(await res.json()).toEqual({ scanned: 2, deleted: 2 });
  });

  test('stops rather than looping forever on a cursor that never clears', async () => {
    let calls = 0;
    const d = deps([], {
      list: async () => {
        calls += 1;
        return { blobs: [], cursor: 'always-more' };
      },
    });
    await handleSweep(get(`Bearer ${SECRET}`), d);
    expect(calls).toBe(MAX_PAGES);
  });

  test('makes no delete call at all when nothing is stale', async () => {
    let removeCalls = 0;
    const d = deps([{ url: 'https://b/fresh.jpg', uploadedAt: agedMinutes(1) }], {
      remove: async () => {
        removeCalls += 1;
      },
    });
    const res = await handleSweep(get(`Bearer ${SECRET}`), d);
    expect(await res.json()).toEqual({ scanned: 1, deleted: 0 });
    expect(removeCalls).toBe(0);
  });
});
