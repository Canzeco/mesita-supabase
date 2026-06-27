// Supabase Edge Function — consumer-list-places
//
// Public endpoint. Returns places that are visible to consumers
// (status in 'active', 'lead'). Self-contained: no calls to other functions.
//
// Local:  supabase functions serve consumer-list-places
// Deploy: supabase functions deploy consumer-list-places

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { clampIntRange, corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import { readAnonEnv } from "../_shared/auth.ts";
import { PLACE_PUBLIC_COLUMNS } from "../_shared/place-columns.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

type ListBody = { limit?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readAnonEnv();
  if (!envRes.ok) return envRes.response;

  // Anon client is sufficient: the places RLS policy already restricts SELECT
  // to status in ('active', 'lead') for anon + authenticated. This is the
  // single source of truth for what consumers are allowed to see.
  const supabase = createClient(envRes.env.url, envRes.env.anonKey);

  // Limit can come from a JSON body (POST from supabase.functions.invoke) or
  // a query string (?limit=… for raw GETs). Body wins if both are present.
  let limit = DEFAULT_LIMIT;
  if (req.method === "POST") {
    const body = await readJsonOr<ListBody>(req, {});
    if (typeof body.limit === "number") {
      limit = clampIntRange(body.limit, 1, MAX_LIMIT);
    }
  } else {
    const q = Number(new URL(req.url).searchParams.get("limit"));
    if (Number.isFinite(q)) limit = clampIntRange(q, 1, MAX_LIMIT);
  }

  const { data, error } = await supabase
    .from("projects_view")
    .select(PLACE_PUBLIC_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  return json({ ok: true, places: data ?? [] });
});
