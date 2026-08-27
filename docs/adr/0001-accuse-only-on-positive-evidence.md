# Accuse only on positive evidence, never on absence

CONTRADICTED originally meant "the photo was found at a different address"; at
some point it was inverted to "the claimed address appears in none of the
matches, and the photo is widely syndicated". On the first genuine production
request that inversion accused a real landlord: a Lenox Grand marketing photo
plus its true address, 13505 Burnet Rd, returned CONTRADICTED because that
request received a truncated result set of 23 matches. Twelve later calls for
the same photo returned 84 to 88 matches, three of which name 13505 Burnet Rd,
and the same code then returned CORROBORATED. We are reverting to the original
meaning: an accusation now requires a competing address to actually be found,
and absence of corroboration falls through to UNVERIFIED.

## Why this is not a tuning problem

Absence-based reasoning is unsound against a search API that can return an
incomplete answer, because a truncated result set and a genuine mismatch
produce an identical signal. No threshold separates them: the truncated
response here still carried 23 matches across 9 sources, which is not thin by
any measure we could have set. The only safe fix is to stop treating absence as
evidence at all. Truncation can then cost a verdict, but can never manufacture
an accusation.

## Considered options

- **Raise the source threshold.** Rejected: the false accusation happened at 9
  sources, so any plausible threshold would have passed it.
- **Retry on a thin-looking response.** Rejected as the primary fix: it lowers
  the odds without restoring soundness, and spends a second metered search on
  every suspicious check.
- **Drop CONTRADICTED entirely.** Rejected: hijack detection is the product.

## Consequences

Detection narrows to identifying photos, and we accept that. Measured across
four apartment complexes, marketing photos yielded 0, 10, 10 and 26 to 30
competing addresses and never exactly one, so the tool structurally cannot
accuse from an apartment-complex photo. That blind spot is stated in the
product rather than hidden, because a renter who is told "we cannot judge this"
is safe, while one who is told "this looks fine" is not.
