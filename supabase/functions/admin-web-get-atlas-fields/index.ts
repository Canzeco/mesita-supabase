// Supabase Edge Function — admin-web-get-atlas-fields
//
// Read-only Enricher vocabulary for the admin console: place categories, tag
// catalog, tag facets, and enforced field length limits.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";
import { fetchPlaceCategories } from "../_shared/categories.ts";
import { ATLAS_FIELD_LIMITS } from "../_shared/atlas-field-limits.ts";
import { fetchPlaceTags, TAG_FACETS } from "../_shared/tags.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const [categories, tags] = await Promise.all([
    fetchPlaceCategories(admin),
    fetchPlaceTags(admin),
  ]);

  return json({
    ok: true,
    categories,
    tags,
    facets: TAG_FACETS,
    fieldLimits: ATLAS_FIELD_LIMITS,
    counts: {
      categories: categories.length,
      tags: tags.length,
      facets: TAG_FACETS.length,
    },
  });
});
