// Supabase Edge Function — consumer-save-place (natural caller)
//
// Toggle a place's bookmark state for the calling consumer. Inserting a
// saved_places row fires the `tg_saved_places_issue_coupon` trigger which
// drops an active coupon into the consumer's wallet (for partner places
// only — web listings get bookmarked but spawn no coupon). Deleting fires
// the mirror trigger that cancels any active coupon.
//
// Response includes the saved_place row (when saved=true) plus the
// auto-issued coupon, if any — saves the client a follow-up round trip
// to refresh the wallet after a save.
//
// Local:  supabase functions serve consumer-save-place
// Deploy: supabase functions deploy consumer-save-place

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv } from "../_shared/auth.ts";

type Body = {
  project_id?: string;
  saved?: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const consumerId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  if (!body.project_id || typeof body.project_id !== "string") {
    return json({ ok: false, error: "project_id required" }, 400);
  }
  if (typeof body.saved !== "boolean") {
    return json({ ok: false, error: "saved (boolean) required" }, 400);
  }

  const admin = adminClient(envRes.env);

  if (body.saved) {
    // Upsert the bookmark. The (consumer_id, project_id) unique constraint
    // means a second save is a no-op at the DB level; the trigger is
    // ON CONFLICT DO NOTHING in the coupons insert, so a duplicate save
    // request from the client doesn't spawn duplicate coupons.
    const { data: saved, error: saveErr } = await admin
      .from("saved_places")
      .upsert(
        { consumer_id: consumerId, project_id: body.project_id },
        { onConflict: "consumer_id,project_id" },
      )
      .select("id, project_id, created_at")
      .single();
    if (saveErr) return json({ ok: false, error: saveErr.message }, 500);

    // Fetch the active coupon spawned by the trigger (if any — non-partner
    // places skip the insert).
    const { data: coupon } = await admin
      .from("coupons")
      .select(
        "id, project_id, status, issued_at, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, cap_cents, currency, expires_at",
      )
      .eq("consumer_id", consumerId)
      .eq("project_id", body.project_id)
      .eq("status", "active")
      .maybeSingle();

    return json({ ok: true, saved_place: saved, coupon });
  }

  // saved === false → delete bookmark. The cancel-coupon trigger flips
  // any active coupon for this (consumer, place) to 'cancelled'.
  const { error: delErr } = await admin
    .from("saved_places")
    .delete()
    .eq("consumer_id", consumerId)
    .eq("project_id", body.project_id);
  if (delErr) return json({ ok: false, error: delErr.message }, 500);

  return json({ ok: true });
});
