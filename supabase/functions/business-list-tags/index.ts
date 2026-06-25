// Supabase Edge Function — business-list-tags
//
// Returns Mesita's full tag vocabulary (public.venue_tags) for the Place
// "Tags" picker: the 17 facet groups (display chrome) plus every tag with its
// facet + section. Read-only, non-secret config. Mirrors how categories are
// listed, but routed through an EF so the business browser never reads the DB
// directly (project rule: clients go through Edge Functions).
//
// Caller: business. Verb: list. Noun: tags.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json } from "../_shared/http.ts";
import { readAnonEnv } from "../_shared/auth.ts";
import { fetchVenueTags, TAG_FACETS } from "../_shared/tags.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readAnonEnv();
  if (!envRes.ok) return envRes.response;

  const supabase = createClient(envRes.env.url, envRes.env.anonKey);
  const tags = await fetchVenueTags(supabase);

  // Always 200 with whatever the catalog yields (possibly []), so a transient
  // read hiccup degrades to an empty picker rather than breaking the form.
  return json({ ok: true, facets: TAG_FACETS, tags });
});
