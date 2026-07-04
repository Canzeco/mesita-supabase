// In-process ranking pipeline for the consumer swipe view.
//
// Absorbed from the former `recommender-rank-swipe` artificial-caller EF
// (MESITA-54): the HTTP hop was a synchronous 1:1 forward with a single
// natural caller, so per the actor-origin grammar the pipeline now runs
// in-process inside `consumer-web-recommend-swipe`. Any future surface that
// needs the same ranking imports this module — no endpoint required.
//
// Pure ranking pipeline. Takes a location + optional consumer profile and
// returns a curated 50-card deck for the consumer swipe view. Anonymous
// requests are valid — discovery is public until sign-up, so the caller
// passes profile=null when there's no session.
//
// Pipeline:
//   1. Pull a bounded candidate pool by bounding-box radius (cheap).
//   2. Lazy-embed any candidates missing an embedding (single batched
//      OpenAI call, capped so first-cold-request stays sub-EF-timeout).
//   3. Compose a one-sentence intent query from the profile + location
//      + time of day + dominant categories in the pool.
//   4. Embed the intent once and ORDER BY cosine.
//   5. Diversify (no >4 cards in the same category) + trim to limit.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  embedAndPersistPlaces,
  embedSingle,
  rankByCosine,
  shouldEmbed,
} from "./embeddings.ts";
import {
  type ConsumerProfile,
  fetchCandidatePool,
  stripInternal,
  type PlaceRow,
} from "./recommender-pool.ts";

const CANDIDATE_POOL = 200;
const MAX_PER_CATEGORY = 4;
const DEFAULT_RADIUS_KM = 25;
const LAZY_EMBED_BATCH = 50;

export type RankSwipeInput = {
  lat: number | null;
  lng: number | null;
  radiusKm: number;
  limit: number;
  profile: ConsumerProfile | null;
};

export type RankSwipeResult =
  | {
    ok: true;
    deck: Omit<PlaceRow, "embedding" | "embedding_source_hash">[];
    summary: {
      candidates: number;
      embedded: number;
      intent?: string;
      caller?: string;
    };
  }
  | { ok: false; error: string };

// Runs the full swipe-deck ranking pipeline in-process. `callerName` labels
// the embedding backfill + summary for observability (pass the natural EF
// name).
export async function rankSwipeDeck(
  admin: SupabaseClient,
  openaiKey: string | undefined,
  callerName: string,
  input: RankSwipeInput,
): Promise<RankSwipeResult> {
  const { lat, lng, radiusKm, limit, profile } = input;

  // ── 1. Candidate pool ──────────────────────────────────────────────
  const poolRes = await fetchCandidatePool<PlaceRow>(admin, {
    lat,
    lng,
    radiusKm,
    poolSize: CANDIDATE_POOL,
  });
  if (!poolRes.ok) {
    return { ok: false, error: `candidate_pool: ${poolRes.error}` };
  }
  const candidates = poolRes.rows;
  if (candidates.length === 0) {
    return { ok: true, deck: [], summary: { candidates: 0, embedded: 0 } };
  }

  // ── 2. Lazy embedding backfill ─────────────────────────────────────
  const needsEmbed = candidates.filter(shouldEmbed).slice(0, LAZY_EMBED_BATCH);
  let embeddedCount = 0;
  if (needsEmbed.length > 0 && openaiKey) {
    const patched = await embedAndPersistPlaces(needsEmbed, admin, openaiKey, callerName);
    embeddedCount = patched.size;
    for (const c of candidates) {
      const p = patched.get(c.id);
      if (p) {
        c.embedding = p.embedding;
        c.embedding_source_hash = p.hash;
      }
    }
  }

  // ── 3. Compose user-intent query ───────────────────────────────────
  const intent = composeIntent({ profile, lat, lng, candidates });

  // ── 4. Rank by embedding similarity (or fall back to partner-first) ──
  let ranked: PlaceRow[];
  if (openaiKey) {
    try {
      const intentVec = await embedSingle(intent, openaiKey);
      ranked = rankByCosine(candidates, intentVec);
    } catch (err) {
      console.error(`[${callerName}] intent embed failed:`, err);
      ranked = fallbackRank(candidates);
    }
  } else {
    ranked = fallbackRank(candidates);
  }

  // ── 5. Tier boost + diversity + partner-first trim ──────────────────
  // Premium guests get a stronger partner-first deck (a real perk: better,
  // more rewarding recommendations). Free guests keep the pure relevance
  // order. The boost is a stable partial reorder, so within partners /
  // within non-partners the relevance ranking from step 4 is preserved.
  const boosted = applyTierBoost(ranked, profile?.tier ?? null);
  const deck = diversify(boosted, limit, MAX_PER_CATEGORY);

  return {
    ok: true,
    deck: deck.map(stripInternal),
    summary: {
      candidates: candidates.length,
      embedded: embeddedCount,
      intent,
      caller: callerName,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Intent composition
// ─────────────────────────────────────────────────────────────────────

// Builds the one-line semantic query that gets embedded. The richer this
// is, the better the ranking — but we keep it terse so the embedding
// stays focused on the place-shaped signal.
function composeIntent({
  profile,
  lat,
  lng,
  candidates,
}: {
  profile: ConsumerProfile | null;
  lat: number | null;
  lng: number | null;
  candidates: PlaceRow[];
}): string {
  const parts: string[] = [];
  // Time-of-day handle. The Edge runtime is UTC; we don't know the
  // consumer's timezone, so this is rough — gives the embedder a flavour,
  // not a hard filter.
  const now = new Date();
  const hour = now.getUTCHours();
  if (hour < 11) parts.push("morning coffee and brunch energy");
  else if (hour < 16) parts.push("lunch and afternoon hangout vibes");
  else if (hour < 20) parts.push("golden hour rooftops and early dinner");
  else parts.push("dinner, cocktails, and late-night spots");

  if (profile?.country) parts.push(`a consumer from ${profile.country}`);
  if (profile?.tier === "premium") {
    parts.push("a Mesita Premium member who values standout, high-quality places");
  }
  if (lat != null && lng != null) parts.push(`within ${DEFAULT_RADIUS_KM}km of this location`);

  const topCats = topCategoriesIn(candidates, 3);
  if (topCats.length) parts.push(`mixing ${topCats.join(", ")}`);

  parts.push("places with great vibe and worth the visit");
  return parts.join("; ");
}

function topCategoriesIn(rows: PlaceRow[], k: number): string[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const c = (r.category ?? "").toLowerCase().trim();
    if (!c) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([c]) => c);
}

// ─────────────────────────────────────────────────────────────────────
// Trim helpers
// ─────────────────────────────────────────────────────────────────────

// Premium overlay: stable partition that floats partner places above
// non-partners while preserving the relevance order inside each group. A
// no-op for free / anonymous, so the deck only changes for Premium members.
function applyTierBoost(rows: PlaceRow[], tier: string | null): PlaceRow[] {
  if (tier !== "premium") return rows;
  const partners: PlaceRow[] = [];
  const rest: PlaceRow[] = [];
  for (const r of rows) {
    if (r.listing_type === "partner") partners.push(r);
    else rest.push(r);
  }
  return [...partners, ...rest];
}

function fallbackRank(rows: PlaceRow[]): PlaceRow[] {
  // Partner-first, then newest. Stable when OpenAI is down.
  return [...rows].sort((a, b) => {
    const ap = a.listing_type === "partner" ? 0 : 1;
    const bp = b.listing_type === "partner" ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return 0;
  });
}

// Cap the final deck so we don't return 50 identical "Italian" cards.
function diversify(rows: PlaceRow[], limit: number, perCategory: number): PlaceRow[] {
  const out: PlaceRow[] = [];
  const seenCat = new Map<string, number>();
  const tail: PlaceRow[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    const cat = (r.category ?? "").toLowerCase().trim();
    const count = seenCat.get(cat) ?? 0;
    if (cat && count >= perCategory) {
      tail.push(r);
      continue;
    }
    out.push(r);
    if (cat) seenCat.set(cat, count + 1);
  }
  for (const r of tail) {
    if (out.length >= limit) break;
    out.push(r);
  }
  return out;
}
