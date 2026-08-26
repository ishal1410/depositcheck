# DepositCheck — design

**Date:** 2026-08-25
**For:** SerpApi "Best AI Use Case" challenge, DevNetwork [API + Cloud + AI] Hackathon 2026
**Deadline:** 2026-09-03 10:00 AM PT
**Status:** blocked on SerpApi API key (phone verification); design is key-independent

---

## Problem

Rental scammers copy photos, description, and address from a real listing, swap in their own contact details, and repost on Craigslist or Facebook Marketplace. The renter wires a deposit for a property the scammer has never owned.

This is measured, not assumed: **56% of 300 Facebook Marketplace rental listings used images lifted from Booking.com, Rightmove, or Zoopla** (Generation Rent, late 2024). The FBI has a standing warning on fake rental listings and Zelle deposits. International students are prime targets — unfamiliar with local market rates, renting remotely, under time pressure.

A reverse image search catches the majority of these before the renter ever speaks to the scammer. Almost nobody runs one.

## What it does

Before you wire a deposit, you give DepositCheck the listing's photos. It reports where else those exact images already live on the web.

If the same photos appear under a different address or a different price, the listing is hijacked. That is the scam's signature, and it is visible in one screen.

## Why live search is structurally required

No language model and no static database can answer "where does this exact image appear on the web right now." This is not fresher data — it is data that only exists live. Remove SerpApi's Google Lens and the product cannot exist in any form.

## Architecture

Reasoning is deterministic; the language model only writes prose. Same pattern as GlowRead, which already ships this way: the output schema cannot break, no signal can be hallucinated, and every verdict traces to a rule.

```
photos in
  → host at public URL (Lens requires a URL, accepts no uploads)
  → google_lens type=exact_matches, per photo
  → normalize matches (source site, title, link)
  → [deterministic] classify each photo + aggregate to a verdict
  → [deterministic] supporting signals: Maps address, Search on contact, price sanity
  → [LLM] write the explanation
  → render verdict + evidence + sources
```

### Components

| Module | Responsibility | Pure? |
|---|---|---|
| `lib/lens.ts` | Call `engine=google_lens`, normalize the response | no (network) |
| `lib/verdict.ts` | Classify matches → `CORROBORATED` / `CONTRADICTED` / `UNVERIFIED` | **yes** |
| `lib/signals.ts` | Address, contact, and price checks → signal list | no (network) |
| `lib/narrate.ts` | LLM writes prose from the verdict. Never decides. | no |
| `app/api/check` | Orchestrates, enforces budget, caches | no |
| `app/upload/[id]` | Serves an uploaded photo at a public URL for Lens to fetch | no |

`verdict.ts` is the core and is a pure function. It is where the tests live.

## The three-state verdict

The naive version of this product renders a green checkmark when reverse image search finds nothing. That is a correctness bug, not a polish issue: **AI-generated listing photos are unique files and return zero matches.** A green check on zero matches actively assists the newest form of the scam.

The inversion that fixes it: a *legitimate* listing's photos usually appear elsewhere too, because the landlord also posted to Zillow and Apartments.com. Absence of matches is absence of corroboration, not evidence of honesty.

| Verdict | Trigger | Shown as |
|---|---|---|
| `CORROBORATED` | Same photos found at the **same** address | Consistent with a real listing |
| `CONTRADICTED` | Same photos found at a **different** address or price | **Hijacked listing signature** |
| `UNVERIFIED` | Photos found nowhere | No corroboration — could be new, could be fabricated. **Never "safe."** |

On `UNVERIFIED`, fall through to signals that do not depend on image matching: does the address exist and match the property type (Maps), is the rent far below local market (Search), do the phone or email appear in complaint reports (Search).

## Input

Lens requires an image URL and accepts no uploads (SerpApi roadmap #948, open). Listing sites cannot be scraped server-side — verified: Zillow 403, Apartments.com 403, Craigslist is a JS shell with zero image URLs in its HTML.

So: **drag the photos in.** The app stores them briefly and serves them at its own public URL, which Lens then fetches. No scraping, no blocked hosts, no headless browser.

Pasting an image URL directly is an optional fast path. It may fail if the host blocks hotlinking — unverified — so it degrades to the upload flow on error rather than being the primary route.

## Search budget

Free tier is 250 searches/month at 50/hour (serpapi.com/pricing).

Per run: 3 photos + 1 address + 1 contact = **~5 searches**. That is ~50 runs/month.

- Cache by SHA-256 of the image bytes, so re-running a demo costs zero
- Cap photos per run at 3
- Refuse the run and say so plainly when the budget is exhausted — never fail silently

## Error handling

Every failure has a user-visible, honest outcome. Silent degradation is the enemy — a plausible wrong answer ships where a crash gets fixed.

| Failure | Behavior |
|---|---|
| Lens returns nothing | `UNVERIFIED` — never "safe" |
| Lens/network error | Say the check could not complete. No verdict. |
| Budget exhausted | Say so before spending. |
| Non-image upload | Reject on magic bytes, not the MIME header |
| Oversized upload | Reject on declared length before buffering |
| LLM slow or down | Render the deterministic verdict; prose is optional |

## Testing

`verdict.ts` is pure, so it gets real tests: same-address match → `CORROBORATED`; different-address match → `CONTRADICTED`; empty matches → `UNVERIFIED`; and specifically **empty matches must never produce a safe/pass state** — that is the regression that would resurrect the AI-photo bug.

Vitest. Fixtures from real captured Lens responses once a key exists.

## Legal framing

Report **signals with sources**, never "this is a scam." Every claim links to the page the evidence came from so the user can see it themselves. Calling a real landlord a fraudster is a defamation problem, and the honest framing is also the more useful one.

## Stack

Next.js 16, React 19, TypeScript, Tailwind v4, Vitest, Vercel. Reuses the GlowRead skeleton — known-good, and nine days does not permit learning a new stack.

## Out of scope

- Scraping listing sites (verified impossible; the upload flow replaces it)
- EXIF / C2PA forensics — platforms strip metadata on upload, so listing photos carry none whether real or AI-generated. Checked; dead end.
- Accounts, history, monitoring, notifications
- Anything mobile-native

## Open risks

1. **Unverified:** is `google_lens` callable on the free plan? Kills the project if not.
2. **Unverified:** does `exact_matches` return useful hits on real listing photos? This is the entire product.
3. **Unverified:** are listing-site image CDNs hotlinkable? Affects only the optional fast path.
4. A striking demo example must be found — a real hijacked listing, or a controlled local reconstruction. Nothing gets posted anywhere.
5. Nine days, solo, with GlowRead's submission also outstanding.

Risks 1-3 are all settled by a single test call once a key exists. **No implementation should start before that test runs.**
