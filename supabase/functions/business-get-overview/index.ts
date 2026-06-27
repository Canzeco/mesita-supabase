// Supabase Edge Function — business-get-overview
//
// Authenticated. Returns *everything* the business / validator surfaces
// need for the active unit in one round trip:
//   - the signed-in user (id + email)
//   - every place they're a member of (sidebar picker)
//   - the active place's full row + recent tickets
//
// Self-contained: own JWT verification, own DB reads via the service role,
// never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import {
  adminClient,
  checkSuperAdmin,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { PLACE_BUSINESS_COLUMNS as PLACE_COLUMNS } from "../_shared/place-columns.ts";

type Body = { activeUnitId?: string; ticketsLimit?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;
  const userEmail = authRes.user.email;

  // Auth: any signed-in user. Super-admin elevation (skips project_members
  // and returns the requested place) is granted when the caller's email
  // is in public.super_admins.
  const admin = adminClient(envRes.env);
  const isSuperAdmin = await checkSuperAdmin(admin, authRes.user);

  const body = await readJsonOr<Body>(req, {});
  const requestedUnitId = (body.activeUnitId ?? "").toString().trim() || null;
  // 0 means "don't fetch tickets at all" — the sidebar layout doesn't need
  // them, only the active page does.
  const ticketsLimit = clampTicketsLimit(body.ticketsLimit);

  // Super-admin path: skip project_members. Require an explicit activeUnitId
  // (the link generator always supplies one) and return a single-row list.
  type PlaceRow = Record<string, unknown> & { id: string };
  let places: PlaceRow[];
  if (isSuperAdmin) {
    if (!requestedUnitId) {
      return json(
        { ok: false, error: "super-admin overview requires activeUnitId" },
        400,
      );
    }
    const placeRow = await admin
      .from("projects_view")
      .select(PLACE_COLUMNS)
      .eq("id", requestedUnitId)
      .maybeSingle();
    if (placeRow.error) {
      return json({ ok: false, error: placeRow.error.message }, 500);
    }
    if (!placeRow.data) {
      return json({ ok: false, error: "Place not found" }, 404);
    }
    // Tag as owner so any downstream UI that gates on role still works —
    // super-admin gets the broadest permission set the place role enum
    // can express. (The frontend MyPlace type only knows owner|business|staff.)
    places = [
      { ...(placeRow.data as Record<string, unknown>), my_role: "owner" } as PlaceRow,
    ];
  } else {
    // Pull every place the caller is a member of, with the role on each row.
    const memberRows = await admin
      .from("project_members")
      .select(`role, place:places(${PLACE_COLUMNS})`)
      .eq("business_id", userId)
      .order("created_at", { ascending: false });
    if (memberRows.error) {
      return json({ ok: false, error: memberRows.error.message }, 500);
    }
    type MemberRow = { role: string; place: Record<string, unknown> | null };
    places = ((memberRows.data ?? []) as MemberRow[])
      .filter((r) => r.place != null)
      .map((r) => ({ ...r.place!, my_role: r.role }) as PlaceRow);
  }

  // Pick the active unit. Honour the requested id when it matches a
  // membership; otherwise fall back to the first place.
  const active = places.length === 0
    ? null
    : (requestedUnitId && places.find((v) => (v as { id: string }).id === requestedUnitId)) ||
        places[0];

  // Recent tickets for the active place (skipped when ticketsLimit=0 or
  // there's no active place — saves a query the layout doesn't care about).
  let recentTickets: unknown[] = [];
  if (active && ticketsLimit > 0) {
    const activeId = (active as { id: string }).id;
    const tx = await admin
      .from("tickets")
      .select(
        "id, kind, status, story_status, story_screenshot_url, story_submitted_at, story_verified_at, story_reject_reason, check_subtotal_cents, tip_cents, total_cents, redeem_cents, discount_percent, discount_cents, revealed_at, reservation_status, reservation_at, reservation_party_size, currency, created_at, paid_at, cancelled_at, cancel_reason, consumer:consumers(id, code, full_name)",
      )
      .eq("project_id", activeId)
      .order("created_at", { ascending: false })
      .limit(ticketsLimit);
    if (tx.error) {
      // Don't fail the whole overview if tickets fail — surface as empty list
      // with an error breadcrumb the client can log.
      console.error("[business-get-overview] ticket fetch:", tx.error.message);
    } else {
      recentTickets = tx.data ?? [];
    }
  }

  return json({
    ok: true,
    user: { id: userId, email: userEmail },
    // Drives the business web's Topbar "Super-admin mode" banner.
    isSuperAdmin,
    places,
    active: active
      ? {
          place: active,
          recentTickets,
        }
      : null,
  });
});

function clampTicketsLimit(raw: unknown): number {
  if (raw == null) return 20;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 20;
  if (n <= 0) return 0;
  return Math.min(100, Math.trunc(n));
}

