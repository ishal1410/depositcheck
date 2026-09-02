# DepositCheck: Devpost submission draft

For the SerpApi "Best AI Use Case" challenge, DevNetwork [API + Cloud + AI] Hackathon 2026.
Written in first person singular for a solo entry. Swap to "we" if anyone joins.

---

## Project name

DepositCheck

## Elevator pitch (200 char limit)

Before you wire a rental deposit, drop in the listing's photo. SerpApi's Google Lens finds every other place that exact image lives, and tells you when it belongs to a different address.

---

## Inspiration

Rental scams work by theft, not invention. A scammer copies the photos, the description and the layout from a real listing, swaps the contact details and the address, and reposts it somewhere with weaker verification. Someone wires a deposit for a property the "landlord" has never owned.

This is not a rare edge case. Generation Rent examined 300 Facebook Marketplace rental listings in late 2024 and found 56% used images lifted from Booking.com, Rightmove or Zoopla. The FBI publishes warnings about the same pattern.

What struck me is that the photos are the one thing the scammer cannot change. Swap them out and the listing stops looking like the desirable flat that attracts victims in the first place. The fraud depends on keeping the stolen images, and stolen images are exactly what a reverse image search is for. The evidence is already published on the open web. Nobody was putting it in front of the renter at the moment the decision gets made.

## What it does

You upload one photo from the listing and type the address you were given.

The photo is stored briefly at a public URL, because Google Lens takes a URL and cannot accept a file upload. SerpApi's `google_lens` engine with `type=exact_matches` finds everywhere that exact image already appears online. The claimed address is matched against those results. The photo is deleted as soon as the lookup returns.

You get one of three verdicts:

- **CORROBORATED** — the photos appear elsewhere alongside the same address, which is what a genuine syndicated listing looks like.
- **CONTRADICTED** — the photos were found to belong to one specific *other* address, and the result names it.
- **UNVERIFIED** — not enough evidence either way.

There is deliberately no green "this listing is safe" state. A listing built from AI-generated photos returns zero matches, which is the identical signal to an honest landlord who photographed the flat themselves and posted it nowhere else. Absence of corroboration is not evidence of honesty, and a UI that implied otherwise would be at its most confident exactly when it was most dangerous.

For the same reason, the app reports signals with their sources and never asserts that a listing *is* a scam. It shows you where the photos live. The conclusion is yours.

## How I built it

Next.js 16 and React 19 on Vercel, TypeScript throughout, Vercel Blob for the temporary photo host, SerpApi for every piece of real-world evidence.

The core architecture decision is that the verdict is deterministic and nothing generative touches it. Address parsing, adjacency matching, source counting and classification all happen in ordinary code with a single pure function at the end. SerpApi supplies the facts; `lib/verdict.ts` decides what they mean. When the output of a tool can accuse a real person of fraud, I want to be able to point at the line that made the call and at a test that pins it.

Route handlers are written against the Web `Request`/`Response` API rather than Next.js types, so the whole pipeline is unit-testable with no framework running. 177 tests run fully offline and spend zero SerpApi searches, including a checked-in fixture of the real truncated API response that caused the one false accusation this project produced.

## Challenges I ran into

**The API shape that reads as a silent lie.** `exact_matches` is a request parameter, not a response field. Call Lens without `type=exact_matches` and `json.exact_matches` is `undefined`, which any reasonable code path reads as "this photo appears nowhere" — the single most alarming answer the tool can give, produced by a missing query parameter.

**"No results" arrives as an error on an HTTP 200.** Combined with the above, this had teeth: a request for an image URL that no longer exists returns 200 with a "no results" body, which classifies as a real UNVERIFIED verdict about a photo the API never saw. Since the analyze flow deletes the photo on every exit path while the upload token never expires, replaying one request could manufacture a verdict out of nothing. Fixed with a single existence check placed after token verification and before the delete path, where every exit routes through it.

**Hotlinking splits by host, so the upload flow is mandatory.** I hoped users could paste a listing URL. `photos.zillowstatic.com` serves Lens fine and returned 76 exact matches on a real Austin listing photo. `images1.apartments.com` returns 403 to everyone, and Lens reports no results — indistinguishable, from inside the app, from a photo that genuinely appears nowhere. Hosting the image myself is the only path that fails honestly.

**The one that mattered: the tool accused a real landlord.** On the first genuine production request, a marketing photo of Lenox Grand submitted with its true address came back CONTRADICTED. The matching logic was not at fault. That request received a truncated response of 23 matches; twelve later calls for the same photo returned 84 to 88, three of which name 13505 Burnet Rd, and the same code then said CORROBORATED.

The bug was epistemic. CONTRADICTED had drifted to mean "your address appears in none of the matches", and against a search API that can return an incomplete answer, absence-based reasoning is unsound — a truncated result set and a genuine mismatch produce the same signal. No threshold separates them; that truncated response still carried 23 matches across 9 sources, which is not thin by any measure I could have set. So absence stopped counting as evidence at all. An accusation now requires a competing street address actually found in the results, named by at least two independent sites. Truncation can now cost a verdict, but it can never manufacture one. The reasoning is written up as ADR-0001 in the repo.

## Accomplishments that I'm proud of

Shipping a tool that states, in the product, what it cannot do.

DepositCheck cannot judge an apartment complex's marketing photo. Those staged show-unit shots are reused across every unit and every aggregator's category pages, so the same image legitimately appears under many addresses. Measured across four complexes, such photos yielded 0, 10, 10 and 26 competing addresses, never exactly one. So the app says so plainly and asks for a different photo — a window view, an awkward corner of the actual unit — because those identify a property where a show kitchen cannot.

Writing that blind spot into the interface was more useful than any accuracy number I could have quoted, and it came directly from the false accusation. A renter told "we cannot judge this" is safe. A renter told "this looks fine" is not.

## What I learned

Search results are evidence, and evidence has to be handled like evidence. A live API returning less than it did a minute ago is normal operation, not an outage, and any inference built on what is *missing* from a response inherits that instability. Every claim the app makes now rests on something it positively found, with a source link the user can open.

I also learned to distrust green states. The strongest design decision in this project was removing an option from the verdict enum.

## What's next for DepositCheck

- Multi-photo checks, so one truncated response cannot decide a verdict on its own.
- SerpApi Google Maps to verify the address is a residential property rather than a parking lot or a mailbox storefront.
- SerpApi Google Search on the landlord's phone number and email, which scam operations reuse across dozens of listings.
- Per-caller upload token binding, and an edge rate limit, which needs shared state the current per-instance limiter does not have.

## Built with

`serpapi` · `google-lens` · `nextjs` · `react` · `typescript` · `tailwindcss` · `vercel` · `vercel-blob` · `vitest` · `node.js`

## Try it out

- Live app: https://depositcheck-liart.vercel.app
- Source: https://github.com/ishal1410/depositcheck

---

## Submission checklist

- [x] Public repo with setup instructions — https://github.com/ishal1410/depositcheck is public, README "Setup" section written.
- [x] Demo video, 2–4 minutes, end-to-end functionality — `depositcheck-demo.mp4`, 2:20, 1440x900. Two live runs against the deployed app: CONTRADICTED then CORROBORATED. Silent, captioned by title cards; a voiceover can be laid over it.
- [x] Project name and one-line pitch — above.
- [x] Screenshots — five in `depositcheck-media/`, all from live runs: landing, filled form, CONTRADICTED verdict, its evidence list, CORROBORATED verdict.
- [ ] Select the SerpApi "Best AI Use Case" challenge on the Devpost form.
- [ ] Submit before **Sep 3 2026, 10:00 AM PDT**.
