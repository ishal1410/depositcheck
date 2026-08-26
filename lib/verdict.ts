import { addressAppearsIn, streetCandidates } from './address';

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
export type UnverifiedReason = 'unreadable_address';

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
}

/** Distinct sites a photo was found on, before we will call a listing hijacked. */
export const MIN_SOURCES_TO_CONTRADICT = 3;

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

  if (addressHits > 0) return { verdict: 'CORROBORATED', sourceCount, addressHits };

  // The claimed address appears nowhere, but that only means something if the
  // photo is demonstrably published widely. Thin evidence must not accuse.
  if (sourceCount >= MIN_SOURCES_TO_CONTRADICT) {
    return { verdict: 'CONTRADICTED', sourceCount, addressHits };
  }

  // ponytail: everything else is UNVERIFIED on purpose. There is no safe/pass
  // verdict in the type, so an unmatched photo can never render as clean.
  return { verdict: 'UNVERIFIED', sourceCount, addressHits };
}
