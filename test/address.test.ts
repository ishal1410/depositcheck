import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { addressAppearsIn, extractStreetAddress } from '../lib/address';

/** Real captured Google Lens response: 76 exact matches for one Austin listing photo. */
const lenox = JSON.parse(
  readFileSync(new URL('./fixtures/lens-zillow-lenox-grand.json', import.meta.url), 'utf8'),
);
const titles: string[] = lenox.exact_matches.map((m: { title?: string }) => m.title ?? '');

describe('addressAppearsIn', () => {
  test('finds the claimed street address in a real listing title', () => {
    expect(addressAppearsIn(titles, '13505 Burnet Rd, Austin, TX')).toBe(3);
  });

  test('does not match a street name that merely appears elsewhere in the title', () => {
    // "2 Austin St" shares both tokens with titles like "... Austin TX (2 units)".
    // Co-presence matching scored 5 here and would have CORROBORATED a scam.
    expect(addressAppearsIn(titles, '2 Austin St, Dallas, TX')).toBe(0);
  });

  test('does not match a common word used as a street name', () => {
    expect(addressAppearsIn(titles, '1 Apartments Rd, Dallas, TX')).toBe(0);
  });

  test('does not match the right number against the wrong street', () => {
    expect(addressAppearsIn(titles, '13505 Oak Ave, Austin, TX')).toBe(0);
  });

  test('treats an abbreviated suffix as equal to its full word', () => {
    expect(addressAppearsIn(['leasing at 13505 Burnet Road Austin'], '13505 Burnet Rd')).toBe(1);
  });

  test('matches when a property name precedes the street number', () => {
    expect(addressAppearsIn(titles, 'Lenox Grand, 13505 Burnet Rd, Austin, TX')).toBe(3);
  });

  test('matches when a directional precedes the street name', () => {
    expect(addressAppearsIn(titles, '13505 N Burnet Rd, Austin, TX')).toBe(3);
  });

  test('matches when a unit number precedes the street address', () => {
    expect(addressAppearsIn(titles, 'Apt 402, 13505 Burnet Rd')).toBe(3);
  });

  test('matches an alphanumeric house number', () => {
    expect(addressAppearsIn(['leasing at 13505 Burnet Rd'], '13505A Burnet Rd')).toBe(1);
  });

  test('treats a directional as the street name when nothing else follows it', () => {
    // "North" here is the street, not a prefix: skipping it leaves only "Ave".
    expect(addressAppearsIn(['now leasing 13505 North Ave Austin'], '13505 North Ave, Austin')).toBe(1);
  });

  test('still treats a directional as a prefix when a real street name follows', () => {
    expect(addressAppearsIn(['now leasing 13505 Burnet Rd'], '13505 N Burnet Rd')).toBe(1);
  });

  test('handles an ordinal street name', () => {
    expect(addressAppearsIn(['for rent 123 5th Ave New York'], '123 5th Ave, New York, NY')).toBe(1);
  });

  test('handles a two-digit ordinal street name', () => {
    expect(addressAppearsIn(['loft at 123 42nd St'], '123 42nd St')).toBe(1);
  });

  test('matches either end of a hyphenated address range', () => {
    expect(addressAppearsIn(['unit at 123 Main St'], '123-125 Main St')).toBe(1);
  });

  test('does not false-positive on common real street names with small numbers', () => {
    const realStreets = ['2 Park Ave', '1 Main St', '3 Oak Ave', '5 Grand Ave', '2 Lake Dr',
      '1 Village Rd', '4 Creek Dr', '2 Ridge Rd', '10 Burnet Rd', '2 Austin Ave'];
    for (const a of realStreets) expect([a, addressAppearsIn(titles, a)]).toEqual([a, 0]);
  });

  test('caps work on a pathologically long address', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `${i} street`).join(' ');
    const t0 = Date.now();
    addressAppearsIn(titles, huge);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test('returns 0 when the claim has no street number', () => {
    expect(addressAppearsIn(titles, 'Austin, TX')).toBe(0);
  });

  // Regression: streetCandidates skips every member of DIRECTIONALS, but the
  // matcher only allowed a single letter between number and name. So a title
  // carrying the claim verbatim scored 0 for NE/NW/SE/SW and the spelled-out
  // forms, and 0 hits with 3+ sources is what fires the fraud accusation.
  test.each([
    ['13505 N Burnet Rd, Austin TX'],
    ['13505 NE Burnet Rd, Austin TX'],
    ['13505 NW Burnet Rd, Austin TX'],
    ['13505 SE Burnet Rd, Austin TX'],
    ['13505 SW Burnet Rd, Austin TX'],
    ['13505 North Burnet Rd, Austin TX'],
    ['13505 South Burnet Rd, Austin TX'],
    ['13505 East Burnet Rd, Austin TX'],
    ['13505 West Burnet Rd, Austin TX'],
  ])('matches a title identical to the claim: %s', (claim) => {
    expect(addressAppearsIn([claim], claim)).toBe(1);
  });

  test('matches a directional claim against a title that omits the directional', () => {
    expect(addressAppearsIn(['Lenox Grand - 13505 Burnet Rd | Zillow'], '13505 NE Burnet Rd')).toBe(1);
  });

  // The widened directional group must not become a wildcard: a genuinely
  // different house number still has to miss.
  test('a different house number on the same street still scores 0', () => {
    expect(addressAppearsIn(['99999 NE Burnet Rd, Austin TX'], '13505 NE Burnet Rd')).toBe(0);
  });

  // "East" is the street name here, not a directional to be skipped over.
  test('a street actually named after a direction still matches', () => {
    expect(addressAppearsIn(['1200 East St, Austin TX'], '1200 East St')).toBe(1);
  });

  // A street name must not match a LONGER street name that merely starts the
  // same way. Telling someone their scam listing "checks out" is the one
  // failure worse than accusing an honest landlord.
  test('a street name does not match a longer street beginning with it', () => {
    expect(addressAppearsIn(['5210 Martin Luther King Blvd, Austin TX'], '5210 Martin Ave')).toBe(0);
  });

  test.each([
    ['1 Oak Ridge Rd, Austin TX', '1 Oak St'],
    ['20 Park Meadow Dr, Dallas TX', '20 Park Ave'],
    ['7 Lake View Ct, Austin TX', '7 Lake Rd'],
  ])('%s does not corroborate the different claim %s', (title, claim) => {
    expect(addressAppearsIn([title], claim)).toBe(0);
  });

  // The name still has to match when the title omits the suffix entirely,
  // which real titles do ("Lenox Grand, 13505 Burnet, Austin").
  test('still matches when the title writes the street with no suffix', () => {
    expect(addressAppearsIn(['Lenox Grand, 13505 Burnet, Austin'], '13505 Burnet Rd')).toBe(1);
  });

  // Rejecting a longer street must not reject a street that IS longer. The
  // claim carries "Luther" itself, so the continuation is the same address.
  test('a genuine multi-word street still corroborates itself', () => {
    expect(addressAppearsIn(['5210 Martin Luther King Blvd, Austin TX'], '5210 Martin Luther King Blvd')).toBe(1);
  });

  // One title can name two streets sharing a number; the second is a real match.
  test('matches a later occurrence when an earlier one is a longer street', () => {
    expect(addressAppearsIn(['1 Oak Ridge Rd and 1 Oak St, Austin TX'], '1 Oak St')).toBe(1);
  });

  // Regression: the longer-street guard only looked at letters, so an ordinal
  // continuation escaped it entirely. "1200 East St" was corroborated by a title
  // naming East 5th St — a real Austin street, and not the claimed one.
  test.each([
    ['1200 East 5th St, Austin TX', '1200 East St'],
    ['700 Main 2nd Ave, Dallas TX', '700 Main St'],
    ['13505 Burnet 5th Rd', '13505 Burnet Rd'],
  ])('%s does not corroborate the different claim %s', (title, claim) => {
    expect(addressAppearsIn([title], claim)).toBe(0);
  });

  // The ordinal street itself must still corroborate; it is the street name,
  // not a continuation.
  test('an ordinal street still matches when it is the claim', () => {
    expect(addressAppearsIn(['1200 East 5th St, Austin TX'], '1200 East 5th St')).toBe(1);
  });
});

describe('extractStreetAddress', () => {
  test('reads a street address out of a real listing title', () => {
    expect(extractStreetAddress('5210 Martin Ave, Austin, TX 78751 | Zillow'))
      .toMatchObject({ key: '5210 martin', display: '5210 Martin Ave' });
  });

  // Real titles from a live Lens response. A loose number+word extractor found
  // 14 "addresses" in these, 10 of them junk; each would become an accusation.
  test.each([
    ['1 Bedroom Apartments for Rent in Lamplight Village, Austin, TX'],
    ['Apartments Under $1200 for Rent in Lamplight Village, Austin, TX'],
    ['Section 8 - 5 Beds 2 Baths Single Family Home Apartments Austin, TX'],
    ['Gracy Woods Austin Pet Friendly Apartments - 571 Rentals | Zillow'],
    ['Apartments For Rent in 78727, - 791 Rentals | Trulia'],
    ['Lenox Grand - Austin, TX Apartments | Realtor.com'],
    ['Photo Gallery | Lenox Grand'],
  ])('reads no address out of listing vocabulary: %s', (t) => {
    expect(extractStreetAddress(t)).toBeNull();
  });

  test('reads a two-word street name', () => {
    expect(extractStreetAddress('3300 Oak Creek Dr - Austin, TX - Rentable'))
      .toMatchObject({ key: '3300 oak creek', display: '3300 Oak Creek Dr' });
  });

  test('skips a directional before the street name', () => {
    expect(extractStreetAddress('Lenox Grand - 13505 N Burnet Rd Austin TX')?.key).toBe('13505 burnet');
  });

  test('keeps a directional that is itself the street name', () => {
    expect(extractStreetAddress('now leasing 1200 East St, Austin')?.key).toBe('1200 east');
  });

  test('treats an abbreviated and a spelled-out suffix as the same address', () => {
    expect(extractStreetAddress('13505 Burnet Road, Austin')?.key)
      .toBe(extractStreetAddress('13505 Burnet Rd, Austin')?.key);
  });
});
