// Atlas synthesis — the "Research Backbone". Reads ONLY the gathered source
// material (Instagram bio, Google reviews, website content) — no web access, so
// it can't drift — and compiles the canonical venue profile JSON. Model comes
// from the admin 'synthesis quality' param.

import {
  ATLAS_DESCRIPTION_MAX,
  ATLAS_DESCRIPTION_TARGET_WORDS,
  OPENAI_URL,
  QUALITY_MODEL,
} from "./atlas-config.ts";
import { safeParseJson } from "./parse-utils.ts";

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    zone: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    established_year: { type: ["integer", "null"] },
    executive_chef: { type: ["string", "null"] },
    editorial_summary: { type: ["string", "null"] },
    description: { type: ["string", "null"] },
    details: {
      type: "object",
      properties: {
        dining_style: { type: ["string", "null"] },
        dress_code: { type: ["string", "null"] },
        service_options: { type: "array", items: { type: "string" } },
        reservations: { type: ["string", "null"] },
        payment_methods: { type: "array", items: { type: "string" } },
        parking: { type: ["string", "null"] },
        amenities: { type: "array", items: { type: "string" } },
        accessibility: { type: "array", items: { type: "string" } },
        dietary_options: { type: "array", items: { type: "string" } },
        good_for: { type: "array", items: { type: "string" } },
        languages: { type: "array", items: { type: "string" } },
        kid_friendly: { type: ["boolean", "null"] },
        pet_friendly: { type: ["boolean", "null"] },
      },
    },
    products: {
      type: "object",
      properties: {
        menu: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    price: { type: ["string", "null"] },
                    description: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
        },
      },
    },
    popular_times: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string" },
          range: { type: "string" },
        },
      },
    },
  },
} as const;

export type ProfileResult = {
  zone?: string | null;
  city?: string | null;
  established_year?: number | null;
  executive_chef?: string | null;
  editorial_summary?: string | null;
  description?: string | null;
  details?: Record<string, unknown> | null;
  products?: { menu?: unknown[] | null } | null;
  menus?: unknown[] | null;
  popular_times?: unknown[] | null;
};

// Resolve the synthesis model from the admin quality knob.
export function synthesisModelFor(quality: string): string {
  return QUALITY_MODEL[quality] ?? "gpt-4o-mini";
}

// Compile the venue profile from gathered material. Returns the parsed profile
// (or null) plus a diagnostic for enrichment_sources.synthesis.
export async function synthesizeProfile(input: {
  openaiKey: string;
  model: string;
  name: string;
  locationLine: string;
  category: string | null;
  igBio: string;
  googleReviewsText: string;
  siteMarkdown: string;
  // P2 (SERP) web-grounded editorial color — SOFT context only, never
  // authoritative. Labelled as such in the grounding block so synthesis treats
  // it as background, not as a source of facts/ratings/prices.
  serpSummary?: string | null;
}): Promise<{ parsed: ProfileResult | null; diag: Record<string, unknown> }> {
  const {
    openaiKey, model, name, locationLine, category, igBio, googleReviewsText,
    siteMarkdown, serpSummary,
  } = input;

  const grounding = [
    igBio ? `Instagram bio: ${igBio}` : "",
    googleReviewsText ? `Google reviews (sample):\n${googleReviewsText}` : "",
    siteMarkdown ? `Website content (excerpt):\n${siteMarkdown}` : "",
    serpSummary
      ? `Web editorial color (SOFT context — background only, NOT authoritative; do not treat as a source of facts, ratings, or prices):\n${serpSummary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userPrompt =
    `Compile the public profile of the venue "${name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `, using ONLY the source material below. Return a single JSON object ` +
    `matching the schema. Build products.menu from website content when ` +
    `present (real dish names + prices only). Write "description" as the ` +
    `public About section for the Place page: a rich, inviting, factual ` +
    `narrative of roughly ${ATLAS_DESCRIPTION_TARGET_WORDS} words (max ` +
    `${ATLAS_DESCRIPTION_MAX} characters). Use short paragraphs. Cover ` +
    `atmosphere, cuisine, signature dishes or experiences, history or ` +
    `neighborhood context, and what makes a visit worthwhile — only when ` +
    `the sources support it. No filler or invented detail. ` +
    `Use null or [] for anything the ` +
    `sources don't support. Never invent ratings, reviewer quotes, prices, or ` +
    `a chef's name.` +
    (grounding
      ? `\n\n--- SOURCE MATERIAL ---\n${grounding}`
      : "\n\n(No extra source material was gathered.)");

  const systemContent =
    "You are Mesita's venue-intelligence synthesis agent. Use ONLY the source " +
    "material the user provides — do not browse or use outside knowledge. " +
    "Output a SINGLE valid JSON object (no prose, no markdown fences) matching " +
    "this shape, using null or [] when the sources don't support a field: " +
    JSON.stringify(PROFILE_SCHEMA.properties) +
    " Never invent ratings, reviewer quotes, prices, or a chef's name.";

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (r.ok) {
      const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      const parsed = safeParseJson(data.choices?.[0]?.message?.content ?? "") as
        | ProfileResult
        | null;
      return { parsed, diag: { provider: "openai", model, ok: !!parsed } };
    }
    return { parsed: null, diag: { provider: "openai", model, ok: false, status: r.status } };
  } catch {
    return { parsed: null, diag: { provider: "openai", model, ok: false } };
  }
}

// Apply the synthesized profile onto the venue update object (mutates it).
// Only sets a field when synthesis actually produced a usable value.
export function applyProfileToUpdate(
  update: Record<string, unknown>,
  parsed: ProfileResult,
): void {
  if (parsed.zone) update.zone = parsed.zone;
  if (parsed.city) update.city = parsed.city;
  if (typeof parsed.established_year === "number") {
    update.established_year = parsed.established_year;
  }
  if (parsed.executive_chef) update.executive_chef = parsed.executive_chef;
  if (parsed.editorial_summary) update.editorial_summary = parsed.editorial_summary;
  // The place's public About — hard cap at ~1000 words. Only overwrite when
  // synthesis actually produced text.
  if (parsed.description && parsed.description.trim()) {
    update.description = parsed.description.trim().slice(0, ATLAS_DESCRIPTION_MAX);
  }
  if (parsed.details && typeof parsed.details === "object") {
    update.details = parsed.details;
  }
  const productMenu = Array.isArray(parsed.products?.menu)
    ? parsed.products?.menu
    : Array.isArray(parsed.menus)
      ? parsed.menus
      : null;
  if (productMenu && productMenu.length > 0) {
    // Canonical storage: products.menu. Keep menus synced for compatibility.
    update.products = { menu: productMenu };
    update.menus = productMenu;
  }
  if (Array.isArray(parsed.popular_times) && parsed.popular_times.length > 0) {
    update.popular_times = parsed.popular_times;
  }
}
