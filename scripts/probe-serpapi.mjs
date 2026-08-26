// Probe: settles the unknowns the DepositCheck design rests on.
//   Q1 Is engine=google_lens callable on the free plan?
//   Q2 Does type=exact_matches return usable hits?
//   Q3 Will Lens fetch a listing-site CDN URL, or is hotlinking blocked?
//
// Usage: SERPAPI_KEY=xxx node scripts/probe-serpapi.mjs <image-url> [more-urls...]
// Docs: google_lens type= all | about_this_image | products | exact_matches | visual_matches
// Costs 1 search per URL. Account status check is free.

const KEY = process.env.SERPAPI_KEY;
if (!KEY) {
  console.error('SERPAPI_KEY not set.');
  process.exit(1);
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('Pass at least one image URL. Use a real listing photo to test hotlinking.');
  process.exit(1);
}

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.text();
  // A non-2xx from SerpApi can be HTML; parsing it blindly reports a parse error
  // as if it were a network failure, which hides quota and auth problems.
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`HTTP ${res.status}, non-JSON body: ${body.slice(0, 120)}`);
  }
  return { status: res.status, json };
}

const acct = await getJson(`https://serpapi.com/account?api_key=${KEY}`);
if (acct.json.error) {
  console.error(`ACCOUNT ERROR (HTTP ${acct.status}): ${acct.json.error}`);
  process.exit(1);
}
console.log('=== ACCOUNT (free, no search burned) ===');
console.log(`plan:  ${acct.json.plan_name}`);
console.log(`left:  ${acct.json.total_searches_left} of ${acct.json.searches_per_month}/month`);
console.log(`rate:  ${acct.json.account_rate_limit_per_hour}/hour`);
console.log();

for (const url of urls) {
  console.log(`=== ${url} ===`);

  // Fetch the image ourselves FIRST. Without this, a CDN 403 comes back from
  // SerpApi only as "hasn't returned any results", which is indistinguishable
  // from a plan/engine failure -- and reads as "Lens is unavailable" when the
  // real cause is hotlink blocking. Free, and it is the only way to tell them apart.
  let reach;
  try {
    const r = await fetch(url, { redirect: 'follow' });
    reach = { status: r.status, type: r.headers.get('content-type') ?? '?' };
  } catch (e) {
    reach = { status: 0, type: `fetch failed: ${e.message}` };
  }
  const hotlinkable = reach.status >= 200 && reach.status < 300;
  console.log(`  direct fetch: HTTP ${reach.status} ${reach.type} -> ${hotlinkable ? 'hotlinkable' : 'BLOCKED'}`);

  const q = new URLSearchParams({ engine: 'google_lens', type: 'exact_matches', url, api_key: KEY });
  let out;
  try {
    out = await getJson(`https://serpapi.com/search.json?${q}`);
  } catch (e) {
    console.log(`  TRANSPORT FAIL: ${e.message}\n`);
    continue;
  }

  if (out.json.error) {
    const err = out.json.error;
    console.log(`  LENS ERROR (HTTP ${out.status}): ${err}`);
    // Classify on evidence, not on keywords in the message.
    if (!hotlinkable) {
      console.log('  -> CAUSE: host blocked the image (Q3). Upload flow required for this host.');
    } else if (/api key|unauthorized|401/i.test(err)) {
      console.log('  -> CAUSE: auth / bad key.');
    } else if (/exceeded|limit|quota|run out/i.test(err)) {
      console.log('  -> CAUSE: quota exhausted.');
    } else if (/hasn't returned any results|no results/i.test(err)) {
      console.log('  -> CAUSE: image reachable but Lens indexed nothing for it (Q2 negative, NOT a plan problem).');
    } else {
      console.log('  -> CAUSE: unclassified; treat as engine/plan issue (Q1).');
    }
    console.log();
    continue;
  }

  const keys = Object.keys(out.json).filter((k) => !['search_metadata', 'search_parameters'].includes(k));
  const exact = out.json.exact_matches ?? [];
  // eTLD+1, not raw hostname: m./www./ar. subdomains would otherwise each count
  // as separate corroborating sources and inflate the evidence bar.
  const domains = new Set(
    exact.map((m) => {
      try {
        return new URL(m.link).hostname.replace(/^www\./, '').split('.').slice(-2).join('.');
      } catch {
        return null;
      }
    }).filter(Boolean),
  );
  console.log(`  keys: ${keys.join(', ')}`);
  console.log(`  exact_matches: ${exact.length} across ${domains.size} registrable domains`);
  console.log(`  domains: ${[...domains].join(', ')}`);
  for (const m of exact.slice(0, 5)) console.log(`    - ${m.source ?? '?'} | ${(m.title ?? '').slice(0, 60)}`);
  console.log();
}
