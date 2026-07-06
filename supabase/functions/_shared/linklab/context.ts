// linklab — per-venue context assembly (shared by every strategy).
// Resolves the Google Place (identity spine + any website Google already knows) and a
// one-shot Perplexity SERP summary (the "SERP AI summary": a neutral synthesis of what the
// web says about the venue, used as soft grounding — NOT the answer). Cached per venue.

import { googleResolvePlace, GooglePlace, Keys, perplexitySonar } from "./providers.ts";

export type VenueInput = { name: string; city: string; country?: string };

export type VenueContext = {
  name: string;
  city: string;
  locationLine: string;
  google: GooglePlace | null;
  /** website Google already knows — a legitimate zero-search seed (like Mesita input) */
  seedWebsite: string | null;
  serpSummary: string | null;
};

export async function assembleContext(keys: Keys, v: VenueInput): Promise<VenueContext> {
  const google = await googleResolvePlace(keys, v.name, v.city);
  const locationLine = google?.formattedAddress ?? `${v.city}, ${v.country ?? "Mexico"}`;
  const serpSummary = await venueSerpSummary(keys, v, google);
  return {
    name: v.name,
    city: v.city,
    locationLine,
    google,
    seedWebsite: google?.websiteUri ?? null,
    serpSummary,
  };
}

async function venueSerpSummary(
  keys: Keys,
  v: VenueInput,
  google: GooglePlace | null,
): Promise<string | null> {
  const schema = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  };
  const cat = google?.types?.slice(0, 3).join(", ") ?? "restaurant";
  const { answer } = await perplexitySonar(
    keys,
    "You summarize restaurants factually for an internal knowledge base. Return strict JSON.",
    `In 3-4 sentences, describe the restaurant "${v.name}" in ${v.city}, ${v.country ?? "Mexico"} ` +
      `(category hints: ${cat}). Cover cuisine/concept, neighborhood, and any facts that help ` +
      `uniquely identify it (chef, year, sister venues). Do NOT list its website or social handles. ` +
      `Return {"summary": "..."}.`,
    schema,
    { searchContextSize: "low" },
  );
  const s = typeof answer.summary === "string" ? answer.summary.trim() : "";
  return s || null;
}
