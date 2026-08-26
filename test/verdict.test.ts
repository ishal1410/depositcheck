import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { classify } from '../lib/verdict';

function load(name: string) {
  const j = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
  return j.exact_matches as { title?: string; source?: string; link?: string }[];
}

describe('classify', () => {
  test('returns UNVERIFIED when the photo matched nothing', () => {
    expect(classify([], { address: '123 Main St, Austin, TX' }).verdict).toBe('UNVERIFIED');
  });

  test('counts distinct sources even when every link is a google redirect', () => {
    // SerpApi roadmap #4175: exact_matches sometimes returns lens.google.com as
    // the link. All 100 rows in this fixture do. Counting link hosts would see
    // one source and refuse to reach the 3-source bar.
    const matches = load('lens-rdcpix-redirect-bug');
    const linkHosts = new Set(matches.map((m) => new URL(m.link!).hostname));
    expect(linkHosts).toEqual(new Set(['lens.google.com']));
    expect(classify(matches, { address: '1 Nowhere Rd, Fargo, ND' }).sourceCount).toBeGreaterThan(3);
  });

  test('CORROBORATED when the claimed address appears in the real matches', () => {
    const r = classify(load('lens-zillow-lenox-grand'), { address: '13505 Burnet Rd, Austin, TX' });
    expect(r.verdict).toBe('CORROBORATED');
    expect(r.addressHits).toBeGreaterThan(0);
  });

  test('CONTRADICTED when a widely published photo never shows the claimed address', () => {
    const r = classify(load('lens-zillow-lenox-grand'), { address: '456 Oak Ave, Dallas, TX' });
    expect(r.verdict).toBe('CONTRADICTED');
    expect(r.sourceCount).toBeGreaterThanOrEqual(3);
    expect(r.addressHits).toBe(0);
  });

  test('will not accuse on thin evidence: too few sources stays UNVERIFIED', () => {
    const thin = [
      { title: 'nice flat', source: 'Pinterest' },
      { title: 'nice flat', source: 'Tumblr' },
    ];
    expect(classify(thin, { address: '456 Oak Ave, Dallas, TX' }).verdict).toBe('UNVERIFIED');
  });

  test('counts label variants of one site as a single source', () => {
    const oneSite = [
      { title: 'x', source: 'Zillow' },
      { title: 'x', source: 'zillow.com' },
      { title: 'x', source: 'ZILLOW.COM' },
      { title: 'x', source: 'Zillow Rentals' },
    ];
    const r = classify(oneSite, { address: '456 Oak Ave, Dallas TX' });
    expect(r.sourceCount).toBe(1);
    expect(r.verdict).not.toBe('CONTRADICTED');
  });

  test('never accuses when no match carries a usable title', () => {
    // Nothing to search means 0 hits by construction, not by absence.
    const untitled = [{ source: 'A' }, { source: 'B' }, { source: 'C' }];
    expect(classify(untitled, { address: '13505 Burnet Rd' }).verdict).not.toBe('CONTRADICTED');
  });

  test('does not throw on malformed match rows', () => {
    const junk = [null, undefined, { title: 123, source: 'A' }, {}] as never[];
    expect(() => classify(junk, { address: '13505 Burnet Rd' })).not.toThrow();
  });

  test.each(['', '   ', 'n/a', 'unknown', 'Austin TX', '?????', '123'])(
    'never accuses when the claimed address is unparseable: %j',
    (address) => {
      // 9 real corroborating sources. Without a readable street address there is
      // nothing to be absent, so CONTRADICTED would be an accusation built on no input.
      expect(classify(load('lens-zillow-lenox-grand'), { address }).verdict).not.toBe('CONTRADICTED');
    },
  );
});
