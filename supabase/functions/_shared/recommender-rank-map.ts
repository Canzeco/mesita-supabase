// In-process ranking pipeline for the consumer catalog (map) view.
//
// Absorbed from the former `recommender-rank-map` artificial-caller EF
// (MESITA-54): the HTTP hop was a synchronous 1:1 forward with a single
// natural caller, so per the actor-origin grammar the pipeline now runs
// in-process inside `consumer-web-recommend-map`. Any future surface that
// needs the same ranking imports this module — no endpoint required.
//
// Builds a dynamically-curated catalog: up to N rows, each with its own
// LLM-proposed label/description/emoji + a cosine-ranked slice of the
// candidate pool. Categories are NOT a prebuilt taxonomy — they're
// proposed per request from the place mix in the user's area plus user
// context (location, time, profile).
//
// Pipeline:
//   1. Pull a wider candidate pool (default 300) by bounding-box radius.
//   2. Lazily embed any candidates missing an embedding (batched, capped).
//   3. Ask an LLM to propose category buckets that would resonate with
//      THIS user given THIS pool — each bucket carries a label, a short
//      description, an emoji icon, and a semantic-search intent_query.
//   4. Embed each intent_query in one batched OpenAI call.
//   5. For each category, cosine-rank the candidate pool against its
//      intent vec and slice off the top N.
//   6. Cross-category dedupe so a place appears in at most 2 buckets
//      (lets a really good place repeat once but not seven times).

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  EMBEDDING_DIMS,
  embedAndPersistPlaces,
  embedBatch,
  rankByCosine,
  shouldEmbed,
} from "./embeddings.ts";
import {
  type ConsumerProfile,
  fetchCandidatePool,
  stripInternal,
  type PlaceRow,
} from "./recommender-pool.ts";

const CANDIDATE_POOL = 300;
const DEFAULT_MAX_CATEGORIES = 10;
const DEFAULT_PER_CATEGORY = 10;
const MAX_PER_CATEGORY_CAP = 20;
const LAZY_EMBED_BATCH = 80;
const MAX_PLACE_REUSE = 2;

const CATEGORY_MODEL = "gpt-4o-mini";

export type RankMapInput = {
  lat: number | null;
  lng: number | null;
  radiusKm: number;
  maxCategories: number;
  perCategory: number;
  profile: ConsumerProfile | null;
};

type ProposedCategory = {
  key: string;
  label: string;
  description: string;
  emoji: string;
  intent_query: string;
};

type BuiltCategory = {
  key: string;
  label: string;
  description: string;
  emoji: string;
  places: Omit<PlaceRow, "embedding" | "embedding_source_hash">[];
};

export type RankMapResult =
  | {
    ok: true;
    categories: BuiltCategory[];
    summary: {
      candidates: number;
      embedded?: number;
      categoryCount?: number;
      caller?: string;
    };
  }
  | { ok: false; error: string };

// Runs the full catalog-ranking pipeline in-process. `callerName` labels the
// embedding backfill + summary for observability (pass the natural EF name).
export async function rankMapCatalog(
  admin: SupabaseClient,
  openaiKey: string | undefined,
  callerName: string,
  input: RankMapInput,
): Promise<RankMapResult> {
  const { lat, lng, radiusKm, profile } = input;
  const maxCategories = clampInt(input.maxCategories, DEFAULT_MAX_CATEGORIES, 1, 12);
  const perCategory = clampInt(input.perCategory, DEFAULT_PER_CATEGORY, 1, MAX_PER_CATEGORY_CAP);

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
    return { ok: true, categories: [], summary: { candidates: 0 } };
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

  // ── 3. Propose dynamic categories with an LLM ──────────────────────
  let proposed: ProposedCategory[];
  if (openaiKey) {
    try {
      proposed = await proposeCategories({
        candidates,
        profile,
        lat,
        lng,
        maxCategories,
        apiKey: openaiKey,
      });
    } catch (err) {
      console.error(`[${callerName}] propose failed:`, err);
      proposed = fallbackCategories(candidates, maxCategories);
    }
  } else {
    proposed = fallbackCategories(candidates, maxCategories);
  }

  if (proposed.length === 0) {
    return { ok: true, categories: [], summary: { candidates: candidates.length } };
  }

  // ── 4. Batch-embed all intent queries in ONE OpenAI call ───────────
  let intentVecs: number[][];
  if (openaiKey) {
    try {
      intentVecs = await embedBatch(proposed.map((c) => c.intent_query), openaiKey);
    } catch (err) {
      console.error(`[${callerName}] intent embed failed:`, err);
      intentVecs = [];
    }
  } else {
    intentVecs = [];
  }

  // ── 5. Rank candidates per category + 6. cross-category dedupe ─────
  const usage = new Map<string, number>();
  const categories: BuiltCategory[] = [];
  for (let i = 0; i < proposed.length; i += 1) {
    const p = proposed[i];
    const vec = intentVecs[i];
    let ranked: PlaceRow[];
    if (vec && vec.length === EMBEDDING_DIMS) {
      ranked = rankByCosine(candidates, vec);
    } else {
      // No vec → simple text-match fallback so the row still shows up.
      ranked = candidates.filter((v) =>
        (v.category ?? "").toLowerCase().includes(p.label.toLowerCase().split(" ")[0]) ||
        (v.vibe ?? "").toLowerCase().includes(p.label.toLowerCase().split(" ")[0])
      );
    }

    const picked: PlaceRow[] = [];
    for (const r of ranked) {
      if (picked.length >= perCategory) break;
      const used = usage.get(r.id) ?? 0;
      if (used >= MAX_PLACE_REUSE) continue;
      picked.push(r);
      usage.set(r.id, used + 1);
    }
    if (picked.length === 0) continue;
    categories.push({
      key: p.key,
      label: p.label,
      description: p.description,
      emoji: p.emoji,
      places: picked.map(stripInternal),
    });
  }

  return {
    ok: true,
    categories,
    summary: {
      candidates: candidates.length,
      embedded: embeddedCount,
      categoryCount: categories.length,
      caller: callerName,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Category proposal (LLM)
// ─────────────────────────────────────────────────────────────────────

async function proposeCategories({
  candidates,
  profile,
  lat,
  lng,
  maxCategories,
  apiKey,
}: {
  candidates: PlaceRow[];
  profile: ConsumerProfile | null;
  lat: number | null;
  lng: number | null;
  maxCategories: number;
  apiKey: string;
}): Promise<ProposedCategory[]> {
  // We give the model a compact view of the pool so its categories are
  // grounded in places that actually exist (not generic taxonomy). Keep
  // the payload modest — first 80 rows is plenty signal.
  const poolDigest = candidates.slice(0, 80).map((v) => ({
    name: v.name,
    category: v.category,
    vibe: v.vibe,
    price: v.price_level,
    listing_type: v.listing_type,
  }));

  const now = new Date();
  const userContext = {
    country: profile?.country ?? null,
    location: lat != null && lng != null ? { lat, lng } : null,
    utc_hour: now.getUTCHours(),
    weekday: now.toLocaleString("en", { weekday: "long" }),
    // Premium members get more aspirational, standout-leaning curation.
    membership: profile?.tier === "premium" ? "premium" : "free",
  };

  const system = [
    "You are Mesita's catalog curator. You see a real-time slice of nearby places and one user's context.",
    "Propose up to N catalog rows that feel hand-curated for THIS user — not a generic taxonomy.",
    "Hard rules:",
    "  • Every category must be groundable in the pool (don't propose 'ramen' if there's no ramen).",
    "  • Labels must be specific and motivating: 'Polanco rooftops for golden hour' not 'Italian'.",
    "  • Descriptions are one short sentence, written like a place card.",
    "  • Emoji must be a single character: 🌇 ✨ 🍷 ☕️ — not a sequence.",
    "  • intent_query is a SEMANTIC SEARCH PROMPT (one sentence, evocative) that will be embedded and",
    "    matched against place text. Write it as the kind of thing a search engine could rank against,",
    "    e.g. 'cozy candlelit bistros perfect for a quiet weeknight date'.",
    "Return STRICT JSON only, shape:",
    `{ "categories": [{ "label": "...", "description": "...", "emoji": "x", "intent_query": "..." }, ...] }`,
  ].join("\n");

  const user = JSON.stringify(
    { maxCategories, userContext, pool: poolDigest },
    null,
    2,
  );

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CATEGORY_MODEL,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`propose HTTP ${r.status}`);
  const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as { categories?: Partial<ProposedCategory>[] };
  const items = (parsed.categories ?? [])
    .filter((c) => c && typeof c.label === "string" && typeof c.intent_query === "string")
    .slice(0, maxCategories)
    .map((c, idx) => ({
      key: slug(c.label ?? `cat-${idx}`),
      label: (c.label ?? "").slice(0, 80),
      description: (c.description ?? "").slice(0, 140),
      emoji: pickEmoji(c.emoji),
      intent_query: (c.intent_query ?? c.label ?? "").slice(0, 240),
    }));
  return items;
}

// Used if the LLM proposal fails: bucket by Google primary category.
function fallbackCategories(rows: PlaceRow[], maxCategories: number): ProposedCategory[] {
  const byCat = new Map<string, PlaceRow[]>();
  for (const r of rows) {
    const c = (r.category ?? "").toLowerCase().trim();
    if (!c) continue;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(r);
  }
  return [...byCat.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, maxCategories)
    .map(([cat]) => ({
      key: slug(cat),
      label: cat.charAt(0).toUpperCase() + cat.slice(1),
      description: `Top ${cat} places nearby`,
      emoji: "✨",
      intent_query: `${cat} places with great vibe and worth the visit`,
    }));
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function pickEmoji(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "✨";
  const it = raw[Symbol.iterator]();
  const first = it.next();
  return first.done ? "✨" : (first.value as string);
}

function clampInt(v: unknown, def: number, lo: number, hi: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
