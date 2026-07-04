// Supabase Edge Function — business-list-reservations
//
// Authenticated. Returns reservations for a place the caller is a member
// of, joined with the guest's display fields + plan (tier) for the
// capacity view. NO financial fields — reservations never carry money
// (the entity split keeps discounts on tickets, not bookings).
//
// Membership-gated like business-list-tickets; shape + scope filter mirror
// consumer-list-reservations. Self-contained.
//
// Deploy: supabase functions deploy business-list-reservations

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { clampIntRange, corsPreflight, json, readJson, readPlaceIdAlias } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { RESERVATION_SELECT } from "../_shared/reservation-columns.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

type Scope = "upcoming" | "past" | "all";
type Body = { placeId?: string; projectId?: string; limit?: number; scope?: Scope };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const projectId = readPlaceIdAlias(body);
  if (!projectId) return json({ ok: false, error: "projectId is required" }, 400);
  const limit = clampIntRange(Number(body.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  const scope: Scope =
    body.scope === "past" || body.scope === "all" ? body.scope : "upcoming";

  const admin = adminClient(envRes.env);
  const memberRes = await requireMembership(admin, authRes.user, projectId);
  if (!memberRes.ok) return memberRes.response;

  let q = admin
    .from("reservations")
    .select(RESERVATION_SELECT)
    .eq("project_id", projectId)
    .order("reserved_at", { ascending: scope !== "past" })
    .limit(limit);

  // "upcoming" shows live bookings (pending + confirmed); "past" shows the
  // terminal states; "all" leaves the result unfiltered for an archive view.
  if (scope === "upcoming") {
    q = q.in("status", ["pending", "confirmed"]);
  } else if (scope === "past") {
    q = q.in("status", ["declined", "no_show", "cancelled"]);
  }

  const { data, error } = await q;
  if (error) return json({ ok: false, error: error.message }, 500);
  return json({ ok: true, reservations: data ?? [] });
});
