// Shared helper — place tag vocabulary (public.place_tags, migration
// 20260625060037_place_tags). Mirrors categories.ts: the list is config that
// lives in the DB, read live, never hardcoded. Both the business tag picker
// (business-web-list-tags) and the consumer detail enrichment (consumer-web-get-place)
// resolve slugs → labelled catalog entries through here, so a place's tags are
// always canonical catalog entries (snake_case slugs) and never free text.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TAGGER_MODEL = "gpt-4o-mini";
const MAX_INFERRED_TAGS = 20;

export type PlaceTag = {
  slug: string;
  label_es: string;
  label_en: string;
  facet: string;
  section: string;
  sort_order: number;
};

// The 17 tag facets, in display order, with the emoji + bilingual group label
// the picker renders as section headers. Kept here (not in the DB) because it is
// pure presentation chrome; the canonical per-tag data lives in place_tags. The
// `slug` matches place_tags.facet exactly.
export type TagFacet = {
  slug: string;
  emoji: string;
  label_es: string;
  label_en: string;
};

export const TAG_FACETS: readonly TagFacet[] = [
  { slug: "payment", emoji: "💳", label_es: "Pago", label_en: "Payment" },
  { slug: "booking", emoji: "📅", label_es: "Reservas", label_en: "Booking" },
  { slug: "service", emoji: "🍽️", label_es: "Servicio", label_en: "Service" },
  { slug: "vibe", emoji: "✨", label_es: "Ambiente", label_en: "Vibe" },
  { slug: "occasion", emoji: "🎉", label_es: "Ideal para", label_en: "Good for" },
  { slug: "amenities", emoji: "🛋️", label_es: "Servicios", label_en: "Amenities" },
  { slug: "dietary", emoji: "🥗", label_es: "Dietético", label_en: "Dietary" },
  { slug: "menu", emoji: "🍳", label_es: "Menú", label_en: "Menu" },
  { slug: "drinks", emoji: "🍸", label_es: "Bar y bebidas", label_en: "Drinks" },
  { slug: "entertainment", emoji: "🎶", label_es: "Entretenimiento", label_en: "Entertainment" },
  { slug: "crowd", emoji: "👥", label_es: "Público", label_en: "Crowd" },
  { slug: "setting", emoji: "🌅", label_es: "Entorno", label_en: "Setting" },
  { slug: "hours", emoji: "🕒", label_es: "Horario", label_en: "Hours" },
  { slug: "dress", emoji: "👔", label_es: "Vestimenta", label_en: "Dress code" },
  { slug: "wellness", emoji: "🧘", label_es: "Bienestar", label_en: "Wellness" },
  { slug: "experiences", emoji: "🗺️", label_es: "Actividades", label_en: "Experiences" },
  { slug: "values", emoji: "🌱", label_es: "Valores", label_en: "Values" },
];

const TAG_COLUMNS = "slug, label_es, label_en, facet, section, sort_order";

// Reads the full, live tag vocabulary ordered by sort_order. Returns [] on
// error so callers degrade gracefully rather than failing over a tag lookup.
export async function fetchPlaceTags(
  client: SupabaseClient,
): Promise<PlaceTag[]> {
  const { data, error } = await client
    .from("place_tags")
    .select(TAG_COLUMNS)
    .order("sort_order", { ascending: true });
  if (error || !data) return [];
  return data as PlaceTag[];
}

// Resolves an arbitrary list of tag slugs (e.g. places.tags) into ordered,
// labelled catalog entries. Unknown slugs are dropped; the result follows the
// catalog sort_order, not the input order. Returns [] for empty input without
// touching the DB.
export async function resolvePlaceTags(
  client: SupabaseClient,
  slugs: readonly string[] | null | undefined,
): Promise<PlaceTag[]> {
  if (!slugs || slugs.length === 0) return [];
  const { data, error } = await client
    .from("place_tags")
    .select(TAG_COLUMNS)
    .in("slug", slugs as string[])
    .order("sort_order", { ascending: true });
  if (error || !data) return [];
  return data as PlaceTag[];
}

// Signals fed to the tag classifier (Enricher contents stage). All optional
// except name — the richer the material, the sharper the picks.
export type TagSignals = {
  name: string;
  category?: string | null;
  description?: string | null;
  googleReviewsText?: string | null;
  serpSummary?: string | null;
};

// Picks up to 20 tag slugs from the closed vocabulary, strongly supported by
// the place material. Returns [] when there's no OpenAI key, no vocabulary, or
// the model errors — tags are additive polish, never worth failing a run over.
// The vocabulary is passed in (the caller reads it once via fetchPlaceTags).
export async function inferPlaceTags(
  openaiKey: string | undefined,
  vocabulary: PlaceTag[],
  signals: TagSignals,
): Promise<string[]> {
  if (!openaiKey || vocabulary.length === 0) return [];
  const valid = new Set(vocabulary.map((t) => t.slug));
  const vocabText = vocabulary.map((t) => t.slug).join(", ");
  const placeLines = [
    `Name: ${signals.name}`,
    signals.category ? `Category: ${signals.category}` : "",
    signals.description ? `About: ${signals.description.slice(0, 1500)}` : "",
    signals.googleReviewsText ? `Reviews: ${signals.googleReviewsText.slice(0, 800)}` : "",
    signals.serpSummary ? `Editorial: ${signals.serpSummary}` : "",
  ].filter(Boolean).join("\n");

  const systemContent =
    "You tag a place using ONLY slugs from a fixed vocabulary. Respond with a " +
    `single JSON object {"tags": ["<slug>", ...]} containing at most ` +
    `${MAX_INFERRED_TAGS} slugs copied verbatim from the vocabulary. Pick only ` +
    "slugs strongly supported by the place material. Deduplicate. Never invent a slug.";
  const userPrompt =
    `Tag vocabulary (slugs):\n${vocabText}\n\nPlace:\n${placeLines}\n\n` +
    `Return {"tags": [up to ${MAX_INFERRED_TAGS} slugs from the vocabulary]}.`;

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TAGGER_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!r.ok) return [];
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    let parsed: { tags?: unknown };
    try {
      parsed = JSON.parse(data.choices?.[0]?.message?.content ?? "") as { tags?: unknown };
    } catch {
      return [];
    }
    if (!Array.isArray(parsed.tags)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of parsed.tags) {
      const slug = typeof t === "string" ? t.trim() : "";
      if (slug && valid.has(slug) && !seen.has(slug)) {
        seen.add(slug);
        out.push(slug);
        if (out.length >= MAX_INFERRED_TAGS) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}
