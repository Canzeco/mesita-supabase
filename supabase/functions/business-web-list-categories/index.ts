// Supabase Edge Function — business-web-list-categories
//
// Returns Mesita's full category vocabulary (public.place_categories) for the
// Place category picker. Read-only, non-secret config. Mirrors business-web-list-tags
// so the business browser never reads the DB directly.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { anonClient, readAnonEnv } from "../_shared/auth.ts";
import { fetchPlaceCategories } from "../_shared/categories.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readAnonEnv();
  if (!envRes.ok) return envRes.response;

  const supabase = anonClient(envRes.env);
  const categories = await fetchPlaceCategories(supabase);

  return json({ ok: true, categories });
});
