import { addressAppearsIn, extractStreetAddress, streetCandidates } from './address';

export type Verdict = 'CORROBORATED' | 'CONTRADICTED' | 'UNVERIFIED';

export interface Match {
  title?: string;
  /** Display label of the site the match was found on, e.g. "Realtor.com". */
  source?: string;
  link?: string;
}

export interface Claim {
  address: string;
}

/** Why a verdict came out UNVERIFIED, when the distinction matters to the user. */
export type UnverifiedReason =
  | 'unreadable_address'
  /** A generic photo: its matches point at many properties, or at none. */
  | 'generic_photo'
  | 'no_addresses_found';

export interface Result {
  verdict: Verdict;
  sourceCount: number;
  addressHits: number;
  /**
   * Set only when the claim itself could not be read. Without it an unparseable
   * address is indistinguishable from a photo nobody has published, and the UI
   * tells the user "not enough copies" while listing the copies it found.
   */
  reason?: UnverifiedReason;
  /**
   * The single competing address the photo was found to belong to. Present only
   * on CONTRADICTED, where it is the evidence: naming the address the photo
   * really belongs to is what makes the warning checkable by the user.
   */
  contradictingAddress?: string;
}

/**
 * Sources that must agree on the SAME competing address before we accuse.
 *
 * Not "sources overall" — that was the old meaning and it is what produced a
 * false accusation at 9 sources. Two independent sites naming one other address
 * is the measured shape of a real single-property listing.
 */
export const MIN_SOURCES_TO_CONTRADICT = 2;

/**
 * Collapse a site's display labels to one identity.
 *
 * The bar is meant to mean "three independent sites". SerpApi labels the same
 * site several ways ("Zillow", "zillow.com", "Zillow Rentals"), and three
 * variants of one site would otherwise clear the bar and accuse on a single
 * source. Over-merging two genuinely different sites that share a first word
 * only lowers the count, which errs toward not accusing.
 */
function normalizeSource(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\.(com|co|net|org|io)\b.*$/, '').split(/\s+/)[0] ?? '';
}

/**
 * Addresses found in the matches that are not the claimed one, mapped to the
 * sources that name each.
 *
 * A claimed "3300 Oak Creek Dr" parses to the key "3300 oak", while a title
 * writing it out yields "3300 oak creek". Treating those as different would let
 * a listing be accused of belonging to its own address, so a key that extends a
 * claimed one counts as the same address.
 */
function competingAddresses(
  matches: Match[],
  claimed: string,
): Map<string, { display: string; sources: Set<string> }> {
  const mine = streetCandidates(claimed).map((c) => `${c.number} ${c.name}`);
  const isMine = (key: string) => mine.some((m) => key === m || key.startsWith(`${m} `));

  const found = new Map<string, { display: string; sources: Set<string> }>();
  for (const m of matches) {
    const title = typeof m?.title === 'string' ? m.title : '';
    const hit = extractStreetAddress(title);
    if (hit === null || isMine(hit.key)) continue;
    const source = normalizeSource(m?.source);
    // Grouped by key so suffix variants are one address; the first spelling
    // seen is kept for display.
    const entry = found.get(hit.key) ?? { display: hit.display, sources: new Set<string>() };
    if (source) entry.sources.add(source);
    found.set(hit.key, entry);
  }
  return found;
}

export function classify(matches: Match[], claim: Claim): Result {
  if (matches.length === 0) return { verdict: 'UNVERIFIED', sourceCount: 0, addressHits: 0 };

  // Count `source`, not the link host. SerpApi #4175 returns lens.google.com as
  // the link for entire result sets, which would collapse every source into one.
  const sources = new Set(matches.map((m) => normalizeSource(m?.source)).filter(Boolean));
  const sourceCount = sources.size;

  // Rows arrive from a third-party API: nulls and non-string fields are its
  // problem to produce and ours not to crash on.
  const titles = matches
    .map((m) => (typeof m?.title === 'string' ? m.title : ''))
    .filter(Boolean);

  // No titles means zero hits by construction, not because the address is
  // absent. Accusing here would rest on missing data rather than evidence.
  if (titles.length === 0) {
    return { verdict: 'UNVERIFIED', sourceCount, addressHits: 0 };
  }

  // No readable street address means there is nothing that could be absent, so
  // absence cannot be evidence. Falling through to CONTRADICTED here would
  // accuse a landlord of fraud on the strength of an empty input box.
  if (streetCandidates(claim.address).length === 0) {
    return { verdict: 'UNVERIFIED', sourceCount, addressHits: 0, reason: 'unreadable_address' };
  }

  const addressHits = addressAppearsIn(titles, claim.address);

  // Checked before anything else can accuse. The real Lenox response carries the
  // claimed address AND about thirty others, so without this precedence a
  // genuine listing would be convicted by its own neighbours' addresses.
  if (addressHits > 0) return { verdict: 'CORROBORATED', sourceCount, addressHits };

  // ADR-0001: from here, absence of the claimed address proves nothing. A
  // truncated result set produces exactly this state, and did in production.
  // Only a competing address actually found in the evidence may accuse.
  const competing = competingAddresses(matches, claim.address);

  if (competing.size === 0) {
    return { verdict: 'UNVERIFIED', sourceCount, addressHits, reason: 'no_addresses_found' };
  }

  // A photo tied to several addresses identifies none of them: an apartment
  // block's marketing shot, reused across every unit and aggregator page.
  // Measured across four complexes: 0, 10, 10 and 26 competing addresses, never 1.
  if (competing.size > 1) {
    return { verdict: 'UNVERIFIED', sourceCount, addressHits, reason: 'generic_photo' };
  }

  const only = [...competing.values()][0];
  if (only.sources.size >= MIN_SOURCES_TO_CONTRADICT) {
    return {
      verdict: 'CONTRADICTED',
      sourceCount,
      addressHits,
      contradictingAddress: only.display,
    };
  }

  // One site saying so is a coincidence away from an accusation.
  return { verdict: 'UNVERIFIED', sourceCount, addressHits };
}
