# DepositCheck

Check whether a rental listing's photos actually belong to the address you were given — before you wire a deposit.

Built for the **SerpApi "Best AI Use Case"** challenge at the DevNetwork API+Cloud+AI Hackathon 2026.

## The problem

Rental scams work by theft, not invention. A scammer copies the photos, the description and the layout from a real listing, swaps the contact details and the address, and reposts it somewhere with weaker verification. The victim wires a deposit for a property the "landlord" has never owned.

This is not a rare edge case. Generation Rent examined 300 Facebook Marketplace rental listings in late 2024 and found **56% used images lifted from Booking.com, Rightmove or Zoopla**. The FBI publishes warnings about the same pattern.

The photos are the part the scammer cannot change. If they change them, the listing stops looking like the desirable flat that attracts victims. That is the leverage this tool uses.

## How it works

1. You upload one photo from the listing and type the address you were given.
2. The photo is stored briefly at a public URL, because Google Lens takes a URL and cannot accept an upload.
3. SerpApi's `google_lens` engine with `type=exact_matches` finds everywhere that exact image already appears online.
4. The claimed address is matched against those result titles.
5. The photo is deleted as soon as the lookup returns.

### Three verdicts, and deliberately no "safe"

| Verdict | Meaning |
|---|---|
| `CORROBORATED` | The photos appear elsewhere alongside the same address — what a genuine syndicated listing looks like. |
| `CONTRADICTED` | The photos were found to belong to one specific *other* address, which the result names. |
| `UNVERIFIED` | Not enough evidence either way. |

There is no green "this listing is safe" state, and that is a design decision rather than an omission. A listing built from AI-generated photos returns zero reverse-image matches — the same signal as an honest landlord who photographed the flat themselves and posted it nowhere else. **Absence of corroboration is not evidence of honesty**, and a UI that implied otherwise would be at its most confident exactly when it was most dangerous.

For the same reason the tool reports signals with their sources and never asserts that a listing *is* a scam. It shows you where the photos live; the conclusion is yours.

### Guarding against false accusations

Telling someone their honest landlord is a fraudster is the worst thing this tool could do, so an accusation requires **positive evidence** — a competing street address actually found in the matches, named by at least two independent sites. Not finding your address is never enough on its own.

That rule was bought with a real failure. On the first genuine production request the tool accused a real landlord: a photo of Lenox Grand, submitted with its true address, came back `CONTRADICTED`. The cause was not the matching logic but a **truncated search response** — that request received 23 matches, while twelve later calls for the same photo returned 84 to 88, three of which name 13505 Burnet Rd. The earlier rule treated "your address is absent" as evidence, and a truncated response is indistinguishable from a genuine mismatch. No threshold separates them; the truncated response still carried 23 matches across 9 sources. So absence stopped counting as evidence altogether. The reasoning is recorded in [ADR-0001](docs/adr/0001-accuse-only-on-positive-evidence.md), and the real truncated response is checked in as a regression fixture.

An address that cannot be parsed produces `UNVERIFIED` with an explicit "we could not read that address", never an accusation resting on an empty input box.

### What it cannot do

**It cannot judge an apartment complex's marketing photo.** Those staged show-unit shots are reused across every unit and on every aggregator's category pages, so the same image legitimately appears under many addresses. Measured across four complexes, such photos yielded 0, 10, 10 and 26 competing addresses — never exactly one. The tool says so plainly and asks for a different photo: a window view or an awkward corner of the actual unit identifies a property where a show kitchen cannot.

This is a real limit, not a rough edge. Detection works on listings whose photos trace to a single property, which in practice means houses and individual units rather than complexes.

## Setup

Requires **Node.js 20+** (developed on 24) and a free SerpApi account.

```bash
git clone <this-repo>
cd depositcheck
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where it comes from |
|---|---|
| `SERPAPI_KEY` | serpapi.com dashboard → "Your Private API Key". Free tier: 250 searches/month. |
| `BLOB_READ_WRITE_TOKEN` | Created with a Vercel Blob store. Free on Hobby. |
| `BLOB_PUBLIC_HOST` | The Blob store's public hostname, e.g. `abc123.public.blob.vercel-storage.com` |
| `UPLOAD_TOKEN_SECRET` | Any long random string: `openssl rand -hex 32` |

Then:

```bash
npm run dev        # http://localhost:3000
npm test           # 131 tests, fully offline - spends no SerpApi searches
npm run typecheck
npm run build
```

### One thing that cannot be tested locally

**Google Lens cannot fetch a `localhost` URL.** The upload → Lens path only works on a deployed URL, so end-to-end testing needs a Vercel preview deploy or a tunnel. Everything else — verdict logic, address matching, upload validation, rate limiting, token verification — is covered by the offline test suite.

## SerpApi integration notes

Findings from building against the live API, recorded here because they cost time to discover:

- **`google_reverse_image` is broken** (as of July 2026, per SerpApi's own roadmap). Use `engine=google_lens`.
- **`exact_matches` is a request parameter, not a response field.** With `type=exact_matches` the response's only top-level key is `exact_matches`. Omit the parameter and `json.exact_matches` is `undefined`, which reads as a false "found nothing".
- **Valid `type` values:** `all`, `about_this_image`, `products`, `exact_matches`, `visual_matches`.
- **Lens takes a URL only** — there is no file upload (SerpApi roadmap #948), which is why this app hosts the image itself.
- **Listing CDNs 403 inconsistently** depending on the client, so hosting the image ourselves is the only reliable path rather than passing a listing URL straight through.
- **"No results" arrives as an `error` field on an HTTP 200.** It is a real answer, not a failure, and is mapped to `UNVERIFIED` rather than an error. It does still consume a search.

`scripts/probe-serpapi.mjs` checks account state and runs one Lens lookup against an image URL, for verifying credentials without touching the app:

```bash
SERPAPI_KEY=xxx node scripts/probe-serpapi.mjs <image-url>
```

## Architecture

```
app/page.tsx              upload + address form, evidence rendering
app/api/upload/route.ts   validates and stores one photo, returns a signed URL
app/api/analyze/route.ts  verifies the token, runs Lens, classifies, deletes the photo
lib/upload.ts             size caps, magic-byte sniffing, streaming body guard
lib/uploadToken.ts        HMAC so a URL alone is not authority to delete an object
lib/lens.ts               SerpApi client, discriminated result type
lib/address.ts            street-address parsing and adjacency matching
lib/verdict.ts            the three-state classifier
lib/ratelimit.ts          fixed-window per-client limiter
```

Handlers are written against the Web `Request`/`Response` API rather than Next.js types, so they are unit-testable with no framework running and drop into the App Router unchanged.

## Known limits

- **Rate limits are per serverless instance.** Each instance enforces its own window and a cold start resets the count, so this bounds abuse rather than eliminating it. Upstash Redis is the upgrade path.
- **Uploads that are never analyzed are never deleted.** The analyze flow deletes the photo on every exit path, but a client that abandons the flow leaves one behind. A scheduled sweep is the fix.
- **A street named after listing vocabulary can match prose.** "1 Bedroom Ln" matches "1 Bedroom Apartments". All ten real street names tested score zero, so this is accepted rather than closed — tightening it would risk turning a harmless false match into a false accusation.
- **The upload token proves the URL came from us, not that it was issued to this caller.** Real per-caller binding needs session state this app does not have.
- **4 MB upload cap**, set by Vercel's 4.5 MB request body limit rather than by preference.

## License

MIT
