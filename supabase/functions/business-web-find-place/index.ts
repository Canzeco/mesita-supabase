// Supabase Edge Function — business-web-find-place
//
// Returns the Mesita state of a place keyed by Google Place ID, so the
// /add page can show the right UI without redirecting:
//
//   not_in_mesita            — no place row exists for this Place ID.
//                              Caller can ask business-web-create-project to
//                              generate one.
//   web_listed_unclaimed     — place exists, listing_type='web', no
//                              owner. Caller can submit a verification.
//   pending_by_me            — place exists, no owner, caller has a
//                              pending project_verifications row.
//   pending_by_other         — place exists, no owner, someone else has
//                              a pending verification (caller can still
//                              submit their own).
//   verified_partner         — place exists and has an owner. Caller
//                              must use the contact / report-fraud flow.
//
// Every claim-able state (web_listed_unclaimed, pending_by_me,
// pending_by_other) carries a `methods` block describing which auto-
// verify paths the UI should surface:
//
//   methods.phone   — available when places.phone is non-null.
//   methods.email   — available when places.email is on-domain (its
//                     host matches the website_url host, ±www. and
//                     subdomain).
//
// The third "Talk to us" option (WhatsApp deep-link) is always shown
// by the UI and doesn't need a server hint — it's a static fallback
// channel handled entirely on the FE.
//
// Auth: any signed-in user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { isOnDomain } from "../_shared/onboarding.ts";

// `googlePlaceId` is the canonical key (Google Place ID). Legacy `placeId`
// is accepted as a fallback until every client sends the new key — it was
// semantically overloaded (Google ID here, place-row UUID on the
// readPlaceIdAlias endpoints), so the new slug disambiguates.
type Body = { googlePlaceId?: string; placeId?: string };

const PLACE_COLUMNS =
  "id, slug, name, status, listing_type, address, phone, email, website_url, photos, category, vibe, created_at, updated_at";

type PlaceRow = {
  id: string;
  phone: string | null;
  email: string | null;
  website_url: string | null;
};

type MethodsBlock = {
  phone: { available: boolean; displayPhone: string | null };
  email: { available: boolean; displayEmail: string | null };
};

function methodsFor(place: PlaceRow): MethodsBlock {
  const phoneOk = !!place.phone;
  const emailOk =
    !!place.email &&
    !!place.website_url &&
    isOnDomain(place.email, place.website_url);
  return {
    phone: {
      available: phoneOk,
      displayPhone: phoneOk ? place.phone : null,
    },
    email: {
      available: emailOk,
      displayEmail: emailOk ? place.email : null,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const placeId = (body.googlePlaceId ?? body.placeId ?? "").trim();
  if (!placeId) {
    return json({ ok: false, error: "googlePlaceId is required" }, 400);
  }

  const admin = adminClient(envRes.env);

  // 1. Place row by Place ID.
  const { data: place, error: placeError } = await admin
    .from("projects_view")
    .select(PLACE_COLUMNS)
    .eq("google_place_id", placeId)
    .maybeSingle();
  if (placeError) {
    return json(
      { ok: false, error: `place_lookup: ${placeError.message}` },
      500,
    );
  }
  if (!place) {
    return json({ ok: true, state: "not_in_mesita", place: null });
  }

  // 2. Owner check via project_members.
  const { data: owner } = await admin
    .from("project_members")
    .select("business_id, role")
    .eq("project_id", place.id)
    .eq("role", "owner")
    .maybeSingle();

  if (owner) {
    const { data: ownerUser } = await admin.auth.admin.getUserById(
      owner.business_id,
    );
    return json({
      ok: true,
      state: "verified_partner",
      place,
      owner: {
        id: owner.business_id,
        email: ownerUser?.user?.email ?? null,
      },
    });
  }

  // From here on the place is claim-able. Compute the methods block
  // once so all three pending/unclaimed branches return it identically.
  const methods = methodsFor(place as PlaceRow);

  // 3. Pending claim by this caller.
  const { data: pendingForMe } = await admin
    .from("project_verifications")
    .select(
      "id, method, payload, requester_email, status, reject_reason, decided_at, decided_via, created_at",
    )
    .eq("project_id", place.id)
    .eq("requester_id", userId)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (pendingForMe) {
    return json({
      ok: true,
      state: "pending_by_me",
      place,
      verification: pendingForMe,
      methods,
    });
  }

  // 4. Pending claim from a different user.
  const { data: pendingByOther } = await admin
    .from("project_verifications")
    .select("id")
    .eq("project_id", place.id)
    .eq("status", "pending")
    .neq("requester_id", userId)
    .limit(1)
    .maybeSingle();
  if (pendingByOther) {
    return json({ ok: true, state: "pending_by_other", place, methods });
  }

  // 5. Default: unclaimed and unmolested.
  return json({ ok: true, state: "web_listed_unclaimed", place, methods });
});
