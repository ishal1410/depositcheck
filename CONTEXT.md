# DepositCheck

Checks whether a rental listing's photos actually belong to the address the
renter was given, before they wire a deposit.

## Language

### The check

**Claimed address**:
The street address the renter was given by whoever is advertising the property.
It is an assertion under test, never a fact.
_Avoid_: the address, user address, input address

**Listing photo**:
One image taken from the advertisement, supplied by the renter.
_Avoid_: image, picture, upload

**Match**:
One place on the web where the same listing photo already appears, as reported
by reverse image search. Carries a title and a source.
_Avoid_: hit, result, occurrence

**Source**:
The site a match was found on, identified by its display label rather than its
link, because the link is unreliable for this purpose.
_Avoid_: domain, site, publisher

**Syndication**:
The normal spread of a genuine listing across several sites, because the
landlord or agent posted it to more than one. Its absence is not suspicious.

### Photos

**Identifying photo**:
A listing photo whose matches point at exactly one property. Only these can
support a verdict about which property the photo belongs to.
_Avoid_: discriminative photo, unique photo

**Generic photo**:
A listing photo whose matches point at many properties, or none. Typically an
apartment complex's staged marketing shot, reused across every unit and every
aggregator category page. Nothing about the claimed address can be concluded
from one.
_Avoid_: non-discriminative photo, stock photo, reused photo

### Evidence

**Competing address**:
A street address found in a match title that is not the claimed address. The
only thing that may support an accusation.
_Avoid_: different address, other address, conflicting address

**Corroboration**:
Evidence that the claimed address and the listing photo belong together, namely
the claimed address appearing in a match title.

**Truncated result set**:
A reverse image search response that returns materially fewer matches than the
same query normally returns, omitting matches that do exist. Measured on this
project, so it is a known condition rather than a hypothetical one.
_Avoid_: partial results, bad response, API glitch

### Verdicts

**CORROBORATED**:
The claimed address was found alongside the photo elsewhere. Not a guarantee of
honesty, only of consistency.

**CONTRADICTED**:
The photo was found to belong to exactly one competing address instead. The only
verdict that makes an accusation, and therefore the one held to the highest bar.

**UNVERIFIED**:
Not enough evidence to say either way. Deliberately absorbs every uncertain
case, including a generic photo and a truncated result set.
_Avoid_: unknown, inconclusive, failed

**Absence of corroboration**:
The claimed address was not found. It is not evidence of dishonesty, because a
truncated result set produces exactly the same signal as a genuine mismatch.
