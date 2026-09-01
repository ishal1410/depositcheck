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

/**
 * Every suffix we recognise, abbreviations and full words alike, longest-first
 * so "street" is tried before "st". Built from SUFFIXES rather than repeated,
 * so the two stay in sync by construction.
 */
const SUFFIX_ALTERNATION = [...new Set([...Object.keys(SUFFIXES), ...Object.values(SUFFIXES)])]
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * A street address sitting inside someone else's title: number, optional
 * directional, one or two name words, then a suffix.
 *
 * The suffix is REQUIRED, and that is the whole point. Listing titles are full
 * of number-then-word pairs that are not addresses — "1 Bedroom Apartments",
 * "5 Beds 2 Baths", "Under $1200 for Rent", "791 Rentals". Measured on 23 real
 * titles, requiring the suffix found 4 addresses and 0 false ones; dropping it
 * found 14, of which 10 were junk. Every one of those would become an
 * accusation, so precision here is worth more than recall.
 */
const TITLE_ADDRESS = new RegExp(
  String.raw`\b(\d{1,6})\s+(?:(?:${DIRECTIONAL_ALTERNATION})\.?\s+)?([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*)?)\s+(?:${SUFFIX_ALTERNATION})\b`,
  // Case-insensitive, rather than matching against a lowercased copy, so the
  // index this reports indexes the same string `display` is sliced out of.
  // See extractStreetAddress.
  'i',
);

export interface FoundAddress {
  /**
   * Comparison key: number and street name, lowercased, suffix dropped, so
   * "Burnet Rd" and "Burnet Road" are one address rather than two. Internal.
   */
  key: string;
  /**
   * The address as the page actually wrote it, suffix and capitals intact.
   * This is the half a person can check, so it is the half we show them —
   * the key is a comparison artifact and reads as a typo on screen.
   */
  display: string;
}

/**
 * The street address a title refers to, or null if it names none.
 */
export function extractStreetAddress(title: string): FoundAddress | null {
  // Run against the title itself. Matching a lowercased copy and then slicing
  // the original is only safe while the two are the same length, and they are
  // not: U+0130 lowercases to two code units, so every index past one shifted
  // by a character and the slice ate the first digit of the house number —
  // naming "23 Main St" as the address a photo really belongs to. That string
  // is the evidence behind an accusation, so it has to be exact.
  const m = TITLE_ADDRESS.exec(title);
  if (m === null || m.index === undefined) return null;
  return {
    // Lowercased here rather than upstream: the key is a comparison artifact,
    // while `display` below keeps the site's own capitalisation.
    key: `${m[1]} ${m[2].toLowerCase().replace(/\s+/g, ' ')}`,
    display: title.slice(m.index, m.index + m[0].length).trim(),
  };
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

  // Every word the claim itself uses. A title that carries the claimed street
  // name and then keeps going ("7 Lake View Ct" against "7 Lake Rd") is naming
  // a DIFFERENT street, so a continuation word only counts as the same address
  // when the claim contains it too — which is what lets a genuine multi-word
  // street ("5210 Martin Luther King Blvd") still corroborate itself.
  const claimWords = new Set(claim.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

  // Adjacency, not co-presence: requiring the number to sit immediately before
  // the street name is what stops "2 Austin St" matching any title that merely
  // contains both "2" and "Austin". Measured on real data: co-presence produced
  // 5 false hits on the Lenox Grand fixture, adjacency produced 0.
  //
  // The trailing group captures whatever word follows the street name, and only
  // across a space — a comma ends the street ("13505 Burnet, Austin"), so that
  // case captures nothing and stays a match.
  //
  // The captured word may start with a digit, because ordinal street names are
  // ordinary: with a letters-only class, "1200 East St" matched a title reading
  // "1200 East 5th St" — the continuation "5th" simply failed to capture and the
  // claim was corroborated by a different street.
  const patterns = candidates.flatMap((c) =>
    suffixVariants(c.name).map(
      (v) => new RegExp(
        String.raw`\b${c.number}[a-z]?\s+(?:(?:${DIRECTIONAL_ALTERNATION})\.?\s+)?${v}\b(?:\s+([a-z0-9][a-z0-9'-]*))?`,
        'g',
      ),
    ),
  );
  return titles.filter((t) => patterns.some((p) => matchesAddress(p, t.toLowerCase(), claimWords))).length;
}

/**
 * Whether any occurrence of `pattern` in `title` names the claimed street
 * rather than a longer street that merely starts the same way.
 *
 * Every occurrence is tried, not just the first: one title can carry both
 * "1 Oak Ridge Rd" and "1 Oak St", and the second is a real match.
 *
 * ponytail: accepted ceiling — a continuation word that happens to appear
 * elsewhere in the claim ("1 Oak St, Ridge City" against a title reading
 * "1 Oak Ridge Rd") is taken as the same street. It needs the claim's city or
 * unit text to equal the other street's second word, and it fails toward a
 * missing accusation rather than a false one. Upgrade path: match the claim's
 * name words in sequence instead of as a set.
 */
function matchesAddress(pattern: RegExp, title: string, claimWords: Set<string>): boolean {
  pattern.lastIndex = 0;
  for (let m = pattern.exec(title); m !== null; m = pattern.exec(title)) {
    const next = m[1];
    if (next === undefined || isSuffix(next) || claimWords.has(next)) return true;
  }
  return false;
}
