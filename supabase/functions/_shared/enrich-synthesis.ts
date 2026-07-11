// Atlas synthesis — the "Research Backbone". Reads ONLY the gathered source
// material (Instagram bio, Google reviews, SERP editorial blurb) — no web
// access, so it can't drift — and compiles the canonical place profile JSON.
// The website is no longer scraped, so there is no menu source: products.menu
// is not synthesised. Model comes from the admin 'synthesis quality' param.

import {
  ENRICH_DESCRIPTION_MAX,
  ENRICH_DESCRIPTION_TARGET_WORDS,
  OPENAI_URL,
  QUALITY_MODEL,
} from "./enrich-config.ts";
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
  popular_times?: unknown[] | null;
};

// Resolve the synthesis model from the admin quality knob.
export function synthesisModelFor(quality: string): string {
  return QUALITY_MODEL[quality] ?? "gpt-4o-mini";
}

// Compile the place profile from gathered material. Returns the parsed profile
// (or null) plus a diagnostic for enrichment_sources.synthesis.
export async function synthesizeProfile(input: {
  openaiKey: string;
  model: string;
  name: string;
  locationLine: string;
  category: string | null;
  igBio: string;
  googleReviewsText: string;
  // P2 (SERP) web-grounded editorial color — SOFT context only, never
  // authoritative. Labelled as such in the grounding block so synthesis treats
  // it as background, not as a source of facts/ratings/prices.
  serpSummary?: string | null;
}): Promise<{ parsed: ProfileResult | null; diag: Record<string, unknown> }> {
  const {
    openaiKey, model, name, locationLine, category, igBio, googleReviewsText,
    serpSummary,
  } = input;

  const grounding = [
    igBio ? `Instagram bio: ${igBio}` : "",
    googleReviewsText ? `Google reviews (sample):\n${googleReviewsText}` : "",
    serpSummary
      ? `Web editorial color (SOFT context — background only, NOT authoritative; do not treat as a source of facts, ratings, or prices):\n${serpSummary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const userPrompt =
    `Compile the public profile of the place "${name}"` +
    (locationLine ? ` located at ${locationLine}` : "") +
    (category ? ` (category: ${category})` : "") +
    `, using ONLY the source material below. Return a single JSON object ` +
    `matching the schema. Write "description" as the ` +
    `public About section for the Place page: a rich, inviting, factual ` +
    `narrative of roughly ${ENRICH_DESCRIPTION_TARGET_WORDS} words (max ` +
    `${ENRICH_DESCRIPTION_MAX} characters). ` +
    `CRITICAL — paragraphs: "description" MUST be several short paragraphs ` +
    `separated by a blank line (the two-character sequence \\n\\n). Never ` +
    `return one unbroken wall of text. Aim for 3–6 paragraphs; each ` +
    `paragraph is 2–4 sentences on one idea (atmosphere, cuisine, ` +
    `signature dishes or experiences, history or neighborhood, why visit) ` +
    `— only when the sources support it. No filler or invented detail. ` +
    `"description" and every other text field MUST be a single JSON string — ` +
    `never an array or nested object. ` +
    `Use null or [] for anything the ` +
    `sources don't support. Never invent ratings, reviewer quotes, prices, or ` +
    `a chef's name.` +
    (grounding
      ? `\n\n--- SOURCE MATERIAL ---\n${grounding}`
      : "\n\n(No extra source material was gathered.)");

  const systemContent =
    "You are Mesita's place-intelligence synthesis agent. Use ONLY the source " +
    "material the user provides — do not browse or use outside knowledge. " +
    "Output a SINGLE valid JSON object (no prose, no markdown fences) matching " +
    "this shape, using null or [] when the sources don't support a field: " +
    JSON.stringify(PROFILE_SCHEMA.properties) +
    " Text fields (zone, city, executive_chef, editorial_summary, description) " +
    "are single JSON strings — never arrays or nested objects. " +
    "For description: separate paragraphs with blank lines (\\n\\n); never one " +
    "continuous block. Never invent ratings, reviewer quotes, prices, or a chef's name.";

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

// Coerce an LLM-produced value to usable text: a string is trimmed; an array
// of strings becomes paragraphs; a plain object's string values (a shape
// gpt-4o-mini actually emits for the About, e.g. {intro, ambiente, cocina})
// become paragraphs too, one level deep. Anything else is dropped.
// json_object mode only *describes* the schema — the model can and does
// return off-type fields, and one bad field must never throw the stage.
export function asProfileText(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  const parts: string[] = [];
  if (Array.isArray(v)) {
    for (const x of v) {
      if (typeof x === "string" && x.trim()) parts.push(x.trim());
      else if (x && typeof x === "object") {
        for (const y of Object.values(x)) {
          if (typeof y === "string" && y.trim()) parts.push(y.trim());
        }
      }
    }
  } else if (v && typeof v === "object") {
    for (const y of Object.values(v)) {
      if (typeof y === "string" && y.trim()) parts.push(y.trim());
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

// Ensure the public About is readable paragraphs, not one mambo-jumbo block.
// - Collapse runs of whitespace inside a paragraph.
// - Normalize any mix of single/double newlines into blank-line breaks.
// - If the model still returned one wall of text, split on sentence ends into
//   ~2–4 sentence paragraphs (skips short blurbs that don't need splitting).
export function formatAboutParagraphs(raw: string): string {
  const trimmed = raw.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return "";

  // Prefer blank-line breaks; if the model only used single newlines, those
  // become paragraphs too. Collapse soft wraps inside a paragraph last.
  let paragraphs = trimmed.split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 1 && /\n/.test(paragraphs[0])) {
    paragraphs = paragraphs[0].split(/\n+/).map((p) => p.trim()).filter(Boolean);
  }
  paragraphs = paragraphs.map((p) =>
    p.replace(/[ \t]*\n[ \t]*/g, " ").replace(/[ \t]+/g, " ").trim()
  ).filter(Boolean);

  // Still one block and long enough → sentence-pack into paragraphs.
  if (paragraphs.length === 1 && paragraphs[0].length > 280) {
    const sentences = paragraphs[0]
      .match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [paragraphs[0]];
    if (sentences.length >= 3) {
      const packed: string[] = [];
      for (let i = 0; i < sentences.length; i += 3) {
        packed.push(sentences.slice(i, i + 3).join(" "));
      }
      paragraphs = packed;
    }
  }

  return paragraphs.join("\n\n");
}

// Apply the synthesized profile onto the place update object (mutates it).
// Only sets a field when synthesis actually produced a usable value.
export function applyProfileToUpdate(
  update: Record<string, unknown>,
  parsed: ProfileResult,
): void {
  // Zone + city are Google-native (Product Rules §A): the Google spine seeds
  // them onto `update` before synthesis runs. Synthesis is only a FALLBACK for
  // when Google carried none — never let the LLM overwrite a native value.
  const zone = asProfileText(parsed.zone);
  if (zone && !update.zone) update.zone = zone;
  const city = asProfileText(parsed.city);
  if (city && !update.city) update.city = city;
  const year = typeof parsed.established_year === "number"
    ? parsed.established_year
    : typeof parsed.established_year === "string"
      ? parseInt(parsed.established_year, 10)
      : NaN;
  if (Number.isInteger(year)) update.established_year = year;
  const chef = asProfileText(parsed.executive_chef);
  if (chef) update.executive_chef = chef;
  const editorial = asProfileText(parsed.editorial_summary);
  if (editorial) update.editorial_summary = editorial;
  // The place's public About — hard cap at ~1000 words. Only overwrite when
  // synthesis actually produced text. Always normalize into blank-line paragraphs.
  const description = asProfileText(parsed.description);
  if (description) {
    update.description = formatAboutParagraphs(description).slice(0, ENRICH_DESCRIPTION_MAX);
  }
  if (parsed.details && typeof parsed.details === "object" && !Array.isArray(parsed.details)) {
    update.details = parsed.details;
  }
  // products.menu is no longer synthesised — the website (its only source) is no
  // longer scraped. Existing menus on the place are left untouched.
  if (Array.isArray(parsed.popular_times) && parsed.popular_times.length > 0) {
    update.popular_times = parsed.popular_times;
  }
}
