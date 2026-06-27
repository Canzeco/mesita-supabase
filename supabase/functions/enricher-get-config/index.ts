// Supabase Edge Function — enricher-get-config (artificial caller / agent)
//
// Read-only init endpoint for the n8n Enricher. n8n NEVER reads the DB directly
// (it is the N8N artificial caller); it calls THIS EF once at workflow start to
// load the enrichment config + the closed category/tag vocabularies it needs at
// S5 (category inference + tag synthesis).
//
// Returns { config, categories[], tags[] }:
//   • config     — the Atlas enrichment knobs from app_settings (loadAtlasConfig):
//                  synthesis quality, gather/analyze/save image caps, vision
//                  toggle, and the vision analysis/sorting prompts.
//   • categories — the live place_categories vocabulary (slug,label,section,
//                  sort_order). The Enricher picks place.category from these (or
//                  'undefined' when none fits).
//   • tags       — the live place_tags vocabulary (slug,label_es,label_en,facet,
//                  section,sort_order). The Enricher picks place.tags (≤20) from
//                  these slugs only.
//
// Contract: verify_jwt=false; requireInternalCaller gates the service-role
// bearer + X-Internal-Caller header. Mirrors enricher-update-project-data /
// enricher-save-place-media gating. GET or POST (no body needed).
//
// Local:  supabase functions serve enricher-get-config
// Deploy: supabase functions deploy enricher-get-config

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import { loadAtlasConfig } from "../_shared/atlas-config.ts";
import { fetchPlaceCategories } from "../_shared/categories.ts";
import { fetchPlaceTags } from "../_shared/tags.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const callerRes = requireInternalCaller(req, envRes.env);
  if (!callerRes.ok) return callerRes.response;

  const admin = adminClient(envRes.env);

  // All three are independent reads — fetch in parallel. fetchPlaceCategories /
  // fetchPlaceTags return [] on error (graceful), loadAtlasConfig falls back to
  // documented defaults, so a partial DB hiccup never hard-fails the Enricher init.
  const [config, categories, tags] = await Promise.all([
    loadAtlasConfig(admin),
    fetchPlaceCategories(admin),
    fetchPlaceTags(admin),
  ]);

  return json({
    ok: true,
    config,
    categories,
    tags,
    caller: callerRes.callerName,
  });
});
