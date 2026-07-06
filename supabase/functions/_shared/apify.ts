// Shared Apify helper. The Enricher selects Apify as the method for Instagram,
// Facebook and OpenTable data (followers, bio, page category, cuisine). Each
// source maps to a store actor run synchronously via the run-sync endpoint,
// which blocks until the run finishes and returns the dataset items inline.
//
// All calls are best-effort: a missing key, a slow actor, or a bad handle
// returns null so the enricher degrades to whatever other sources found
// rather than failing the whole profile.

const APIFY_BASE = "https://api.apify.com/v2/acts";

// Store actor ids (the "~" form the API expects). Standard Apify store actors.
export const APIFY_ACTORS = {
  instagramProfile: "apify~instagram-profile-scraper",
  facebookPages: "apify~facebook-pages-scraper",
  // Google Maps scraper — the depth Google's official API rations: ALL
  // reviews (Places caps at ~5) + popular_times, in one run.
  googleMaps: "compass~crawler-google-places",
} as const;

// One actor run's outcome. `items` is null on any failure; `status`/`error`
// carry the WHY into the per-source diags — a v2 launch bug hid weeks of
// silent 4xx behind indistinguishable nulls (MESITA-120).
export type ApifyRunResult<T = Record<string, unknown>> = {
  items: T[] | null;
  // HTTP status of the run-sync call (null = network error / client abort).
  status: number | null;
  // Failure detail: non-ok body head, timeout note, or fetch error message.
  error: string | null;
};

// Runs an actor synchronously and returns its dataset items. Capped so a
// stuck actor can't hang the enrichment past the EF wall-clock (note the
// actor keeps running — and billing — on Apify after a client abort).
export async function runApifyActor<T = Record<string, unknown>>(
  actorId: string,
  input: Record<string, unknown>,
  token: string,
  timeoutMs = 45000,
): Promise<ApifyRunResult<T>> {
  const url = `${APIFY_BASE}/${actorId}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = (await r.text().catch(() => "")).slice(0, 200);
      return { items: null, status: r.status, error: body || r.statusText };
    }
    const data = await r.json();
    return Array.isArray(data)
      ? { items: data as T[], status: r.status, error: null }
      : { items: null, status: r.status, error: "non-array response body" };
  } catch (err) {
    return {
      items: null,
      status: null,
      error: ctrl.signal.aborted
        ? `client timeout after ${timeoutMs}ms`
        : (err instanceof Error ? err.message : String(err)).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Extracts a bare Instagram handle from a profile URL. Returns null for
// non-profile URLs (posts, reels, explore) so we don't scrape garbage.
export function instagramHandleFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /instagram\.com\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  const handle = m[1].replace(/^@/, "").trim();
  if (!handle) return null;
  const reserved = new Set(["p", "reel", "reels", "explore", "stories", "tv"]);
  if (reserved.has(handle.toLowerCase())) return null;
  return handle;
}
