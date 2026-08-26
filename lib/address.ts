const SUFFIXES: Record<string, string> = {
  rd: 'road', st: 'street', ave: 'avenue', blvd: 'boulevard',
  dr: 'drive', ln: 'lane', ct: 'court', pkwy: 'parkway',
};

const DIRECTIONALS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  'north', 'south', 'east', 'west']);

/**
 * The same directionals, longest-first, for use inside the matcher.
 *
 * It must stay in sync with the set above by construction. When the matcher
 * hardcoded a single letter while `streetCandidates` skipped the whole set, a
 * title carrying "13505 NE Burnet Rd" verbatim scored zero against that exact
 * claim — and zero hits on a well-syndicated photo is what fires the fraud
 * accusation. Longest-first matters: with `n|ne`, the alternation would take
 * "n" out of "ne" and then fail on the missing space.
 *
 * Every member is plain [a-z], so none of them needs regex escaping.
 */
const DIRECTIONAL_ALTERNATION = [...DIRECTIONALS]
  .sort((a, b) => b.length - a.length)
  .join('|');

function isSuffix(token: string): boolean {
  return token in SUFFIXES || Object.values(SUFFIXES).includes(token);
}

function suffixVariants(token: string): string[] {
  const out = new Set([token]);
  if (SUFFIXES[token]) out.add(SUFFIXES[token]);
  for (const [abbr, full] of Object.entries(SUFFIXES)) if (token === full) out.add(abbr);
  return [...out];
}

export interface StreetCandidate {
  /** House number digits only; a trailing letter (123A) is kept separately. */
  number: string;
  /** The street name token following the number, past any directional. */
  name: string;
}

/**
 * Upper bounds on work done for one claimed address. A real address yields one
 * or two candidates; anything beyond this is junk or an attempt to make us build
 * thousands of regexes and run each against every title. Measured before the
 * caps: a 5,000-token address took 325ms; after, 3ms.
 */
export const MAX_TOKENS = 64;
export const MAX_CANDIDATES = 8;

/**
 * Every plausible (house number, street name) pair in a claimed address.
 *
 * Returns a list rather than one guess because real input carries extra
 * numbers: "Apt 402, 13505 Burnet Rd" must not lock onto 402. Taking the first
 * alphabetic token as the street name — the previous approach — broke on a
 * leading property name ("Lenox Grand, 13505 ...") and on a directional
 * ("13505 N Burnet"), scoring 0 hits on addresses that were in fact present.
 * An empty list means the claim has no readable street address at all, which
 * callers must treat as "cannot evaluate" rather than "address is absent".
 */
export function streetCandidates(claim: string): StreetCandidate[] {
  const tokens = claim.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, MAX_TOKENS);
  const out: StreetCandidate[] = [];

  for (let i = 0; i < tokens.length && out.length < MAX_CANDIDATES; i++) {
    const m = /^([0-9]+)[a-z]?$/.exec(tokens[i]);
    if (!m) continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = tokens[j];
      // A plain number here means a range ("123-125 Main") or a unit prefix
      // ("Apt 2, 456 Oak"). Keep scanning so both ends of a range get a candidate.
      // Ordinals ("5th", "42nd") fall through and are kept: the street name is
      // itself a number word, and bailing on digits made them all unparseable.
      if (/^[0-9]+$/.test(t)) continue;
      // "13505 N Burnet Rd" -> skip the directional. But in "13505 North Ave"
      // the directional IS the street name, and skipping it would leave the
      // suffix "ave" standing in as the street. Only skip when a real name follows.
      if (DIRECTIONALS.has(t) && j + 1 < tokens.length && !isSuffix(tokens[j + 1])) continue;
      out.push({ number: m[1], name: t });
      break;
    }
  }
  return out;
}

/**
 * How many of `titles` contain the street address in `claim`.
 *
 * ponytail: known ceiling — a street name that is also listing vocabulary can
 * match prose. Measured: "1 Bedroom Ln" hits "1 Bedroom Apartments" and
 * "10 Units Rd" hits "(10 units available)". All ten real street names tested
 * (Park, Main, Oak, Grand, Lake, Village, Creek, Ridge, Burnet, Austin) score 0,
 * so this is left alone deliberately. Requiring the street suffix to be adjacent
 * would close it, but would then miss titles that write "13505 Burnet, Austin"
 * with no suffix — turning a harmless false match into a false accusation.
 * Upgrade path if it ever matters: score suffix presence instead of requiring it.
 */
export function addressAppearsIn(titles: string[], claim: string): number {
  const candidates = streetCandidates(claim);
  if (candidates.length === 0) return 0;

  // Adjacency, not co-presence: requiring the number to sit immediately before
  // the street name is what stops "2 Austin St" matching any title that merely
  // contains both "2" and "Austin". Measured on real data: co-presence produced
  // 5 false hits on the Lenox Grand fixture, adjacency produced 0.
  const patterns = candidates.flatMap((c) =>
    suffixVariants(c.name).map(
      (v) => new RegExp(String.raw`\b${c.number}[a-z]?\s+(?:(?:${DIRECTIONAL_ALTERNATION})\.?\s+)?${v}\b`),
    ),
  );
  return titles.filter((t) => patterns.some((p) => p.test(t.toLowerCase()))).length;
}
