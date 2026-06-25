// Supabase Edge Function — consumer-get-venue
//
// Public. Returns a single venue by id (uuid) or slug, plus the business
// authority info needed for the detail page (vibe / channels / etc.).
// Anon-readable but the venues RLS policy still gates which rows ship.
//
// Caller: consumer. Verb: get. Noun: venue. (Per the new <caller>-<verb>-<noun>
// naming convention.)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { readAnonEnv } from "../_shared/auth.ts";
import { VENUE_PUBLIC_COLUMNS as VENUE_COLUMNS } from "../_shared/venue-columns.ts";
import { resolveVenueTags } from "../_shared/tags.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = { id?: string; slug?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readAnonEnv();
  if (!envRes.ok) return envRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const idOrSlug = (body.id ?? body.slug ?? "").toString().trim();
  if (!idOrSlug) {
    return json({ ok: false, error: "id or slug is required" }, 400);
  }

  const supabase = createClient(envRes.env.url, envRes.env.anonKey);
  const column = UUID_RE.test(idOrSlug) ? "id" : "slug";

  const { data, error } = await supabase
    .from("venues")
    .select(VENUE_COLUMNS)
    .eq(column, idOrSlug)
    .maybeSingle();

  if (error) return json({ ok: false, error: error.message }, 500);
  if (!data) return json({ ok: false, error: "Venue not found" }, 404);

  // Resolve the venue's tag slugs (venues.tags) into ordered, labelled catalog
  // entries so the detail modal can render chips without a second round-trip or
  // a client-side tag dictionary. Unknown slugs are dropped.
  const tags = await resolveVenueTags(
    supabase,
    (data as { tags?: string[] | null }).tags,
  );

  return json({ ok: true, venue: data, tags });
});

