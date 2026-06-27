// Supabase Edge Function — business-list-units
//
// Authenticated. Returns every place the caller is a member of,
// regardless of status (so paused / archived rows are visible to the
// owner).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { PLACE_BUSINESS_COLUMNS } from "../_shared/place-columns.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  // Service role: read regardless of place status (paused / archived
  // rows belong to the owner too). RLS would filter those out for the
  // user JWT path.
  const admin = adminClient(envRes.env);

  const { data, error } = await admin
    .from("project_members")
    .select(`role, place:places(${PLACE_BUSINESS_COLUMNS})`)
    .eq("business_id", authRes.user.id)
    .order("created_at", { ascending: false });

  if (error) {
    return json({ ok: false, error: error.message }, 500);
  }

  // Flatten — frontend only needs the place + the caller's role within it.
  type Row = { role: string; place: Record<string, unknown> | null };
  const rows = (data ?? []) as Row[];
  const places = rows
    .filter((r) => r.place != null)
    .map((r) => ({ ...r.place!, my_role: r.role }));

  return json({ ok: true, places });
});
