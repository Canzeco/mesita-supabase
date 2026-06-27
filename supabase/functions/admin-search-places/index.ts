// Supabase Edge Function — admin-search-places
//
// Super-admin place search for the admin console's "Manage Single Unit"
// place picker. Takes a free-text query and returns matching Mesita places
// (by name / slug, or an exact id paste). The operator picks one, and the
// admin console then drives that place through the existing business-* EFs
// (super-admin bypass in _shared/auth.ts grants access regardless of
// project_members).
//
// Auth: caller's JWT email must be in public.super_admins.
// verify_jwt = true gates non-bearer callers at the gateway.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = { query?: unknown; limit?: unknown };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const q = typeof bodyRes.body.query === "string" ? bodyRes.body.query.trim() : "";
  const limit =
    typeof bodyRes.body.limit === "number" && Number.isInteger(bodyRes.body.limit)
      ? Math.min(Math.max(bodyRes.body.limit, 1), 50)
      : 25;

  const cols = "id, slug, name, category, category_label, status, address, photos";
  let rows;

  if (q.length === 0) {
    // Empty query — browse recent units for the catalog landing state.
    const { data, error } = await admin
      .from("projects_view")
      .select(cols)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) return json({ ok: false, error: `search_failed: ${error.message}` }, 500);
    rows = data ?? [];
  } else if (UUID_RE.test(q)) {
    // Exact id paste — return that one place.
    const { data, error } = await admin.from("projects_view").select(cols).eq("id", q).maybeSingle();
    if (error) return json({ ok: false, error: `search_failed: ${error.message}` }, 500);
    rows = data ? [data] : [];
  } else if (q.length < 2) {
    return json({ ok: false, error: "query must be at least 2 characters" }, 400);
  } else {
    // Free-text: match name OR slug, newest-touched first. Strip characters
    // that break the PostgREST or() grammar (comma / parens), then escape LIKE
    // wildcards so the remaining text matches literally.
    const safe = q.replace(/[,()"]/g, " ").trim();
    const escaped = safe.replace(/[%_\\]/g, (m) => `\\${m}`);
    const pattern = `%${escaped}%`;
    const { data, error } = await admin
      .from("projects_view")
      .select(cols)
      .or(`name.ilike."${pattern}",slug.ilike."${pattern}"`)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (error) return json({ ok: false, error: `search_failed: ${error.message}` }, 500);
    rows = data ?? [];
  }

  // Trim photos to the first thumbnail to keep the payload small.
  const places = (rows ?? []).map((v) => ({
    id: v.id,
    slug: v.slug,
    name: v.name,
    category: v.category,
    category_label: v.category_label,
    status: v.status,
    address: v.address,
    photo: Array.isArray(v.photos) && v.photos.length > 0 ? v.photos[0] : null,
  }));

  return json({ ok: true, places });
});
