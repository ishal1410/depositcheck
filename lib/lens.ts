import type { Match } from './verdict';

export type LensFailure = 'auth' | 'quota' | 'transport' | 'unknown';

/**
 * Discriminated on purpose: a failed call must never be mistaken for a photo
 * that genuinely appears nowhere. Those mean opposite things to the user —
 * one is "we could not check", the other is "we checked and found nothing".
 */
export type LensResult =
  | { ok: true; matches: Match[] }
  | { ok: false; reason: LensFailure; message: string };

export interface LensDeps {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Strip the key from anything that might be surfaced or logged. */
function redact(text: string, apiKey: string): string {
  const safe = apiKey ? text.split(apiKey).join('[redacted]') : text;
  return safe.replace(/(api_key=)[^&\s]+/gi, '$1[redacted]');
}

function classify(error: string): LensFailure | 'no_results' {
  if (/hasn't returned any results|no results/i.test(error)) return 'no_results';
  // Quota is tested before auth on purpose: "run out of searches, upgrade your
  // API key plan" mentions both, and the actionable cause is the quota. Auth
  // messages never mention exhaustion, so this ordering cannot misfile them.
  if (/exceeded|quota|run out|limit/i.test(error)) return 'quota';
  if (/api key|unauthorized|invalid key/i.test(error)) return 'auth';
  return 'unknown';
}

export async function fetchExactMatches(
  imageUrl: string,
  apiKey: string,
  deps: LensDeps = {},
): Promise<LensResult> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const q = new URLSearchParams({
    engine: 'google_lens',
    type: 'exact_matches',
    url: imageUrl,
    api_key: apiKey,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let status: number;
  let body: string;
  try {
    const res = await doFetch(`https://serpapi.com/search.json?${q}`, { signal: controller.signal });
    status = res.status;
    body = await res.text();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'transport', message: redact(msg, apiKey) };
  } finally {
    clearTimeout(timer);
  }

  let json: { error?: string; exact_matches?: unknown };
  try {
    json = JSON.parse(body);
  } catch {
    // A non-2xx from SerpApi can be HTML. Parsing it blindly would surface a
    // JSON syntax error and hide the real status.
    return {
      ok: false,
      reason: 'transport',
      message: redact(`HTTP ${status}, non-JSON body: ${body.slice(0, 120)}`, apiKey),
    };
  }

  if (typeof json.error === 'string') {
    const kind = classify(json.error);
    // "No results" arrives as an error field on an HTTP 200, but it is a real
    // answer: the photo appears nowhere. Reporting it as a failure would stop
    // the check instead of yielding the UNVERIFIED the user should see.
    if (kind === 'no_results') return { ok: true, matches: [] };
    return { ok: false, reason: kind, message: redact(json.error, apiKey) };
  }

  // A non-2xx whose body names no error has only the status line left as
  // evidence. Falling through would return an empty match list, which reads as
  // "the photo appears nowhere" — the opposite of "we could not check", and the
  // one answer that must never be manufactured out of a failed call.
  if (status >= 400) {
    return {
      ok: false,
      reason: 'unknown',
      message: redact(`HTTP ${status}, no error field in the response`, apiKey),
    };
  }

  // The API owns this array's shape; downstream treats every field as optional.
  const matches = Array.isArray(json.exact_matches) ? (json.exact_matches as Match[]) : [];
  return { ok: true, matches };
}
