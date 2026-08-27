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

  // Was: "CONTRADICTED when a widely published photo never shows the claimed
  // address". ADR-0001 reversed this deliberately. Wide publication plus a
  // missing claim is exactly what a truncated result set looks like, and this
  // photo is an apartment marketing shot whose matches name about thirty
  // different properties, so it identifies none of them.
  test('a photo published at many addresses accuses nobody', () => {
    const r = classify(load('lens-zillow-lenox-grand'), { address: '456 Oak Ave, Dallas, TX' });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.reason).toBe('generic_photo');
    expect(r.addressHits).toBe(0);
    expect(r.contradictingAddress).toBeUndefined();
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

  // ADR-0001. A truncated result set and a genuine mismatch produce an
  // identical signal, so absence of the claimed address must never accuse.
  describe('accuses only on positive evidence', () => {
    test('the real truncated response must not accuse a genuine landlord', () => {
      const truncated = load('lens-truncated-lenox');
      const r = classify(truncated, { address: '13505 Burnet Rd, Austin, TX' });
      expect(r.addressHits).toBe(0); // the corroborating rows are genuinely absent
      expect(r.verdict).not.toBe('CONTRADICTED');
      expect(r.reason).toBe('generic_photo');
    });

    test('a photo tied to exactly one other address, agreed by two sources, accuses', () => {
      const matches = [
        { title: '5210 Martin Ave, Austin, TX 78751 | Zillow', source: 'Zillow' },
        { title: '5210 Martin Ave, Austin, TX 78751 - HotPads', source: 'HotPads' },
      ];
      const r = classify(matches, { address: '12 Elm St, Dallas, TX' });
      expect(r.verdict).toBe('CONTRADICTED');
      expect(r.contradictingAddress).toBe('5210 Martin Ave');
    });

    test('one competing address from a single source is not enough to accuse', () => {
      const matches = [{ title: '12809 Palfrey Dr, Austin TX | Zillow', source: 'Zillow' }];
      expect(classify(matches, { address: '12 Elm St' }).verdict).toBe('UNVERIFIED');
    });

    test('several competing addresses mean the photo identifies nothing', () => {
      const matches = [
        { title: '3300 Oak Creek Dr - Austin, TX', source: 'Rentable' },
        { title: '800 Turkey Tree Rd, Spicewood, TX', source: 'HotPads' },
        { title: '5210 Martin Ave, Austin, TX', source: 'Zillow' },
      ];
      const r = classify(matches, { address: '12 Elm St' });
      expect(r.verdict).toBe('UNVERIFIED');
      expect(r.reason).toBe('generic_photo');
    });

    test('matches carrying no address at all cannot accuse', () => {
      const matches = [
        { title: 'Apartments For Rent in Austin, TX - Trulia', source: 'Trulia' },
        { title: 'Pet Friendly Apartments - 571 Rentals | Zillow', source: 'Zillow' },
        { title: 'Photo Gallery | Lenox Grand', source: 'Lenox Grand' },
      ];
      const r = classify(matches, { address: '12 Elm St' });
      expect(r.verdict).toBe('UNVERIFIED');
      expect(r.reason).toBe('no_addresses_found');
    });

    test('the claimed address wins over any number of competing ones', () => {
      // The real Lenox response carries 13505 Burnet Rd AND ~29 other addresses.
      const r = classify(load('lens-zillow-lenox-grand'), { address: '13505 Burnet Rd, Austin, TX' });
      expect(r.verdict).toBe('CORROBORATED');
      expect(r.contradictingAddress).toBeUndefined();
    });
  });
});
