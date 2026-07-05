// Supabase Edge Function — supabase-cron-run-project-creations (artificial caller / cron)
//
// The SERVICE-GATED internal create path the SQL scheduler poller invokes. It is
// the headless twin of admin-web-create-project: the same createMinimalPlace
// core (_shared/create-place.ts: dedupe → Google spine → save 'generating' row →
// seed place_research for the Enricher pipeline), but gated by
// requireInternalCaller instead of getAuthedUser+requireSuperAdmin, because the
// poller is service-role with no end-user JWT and CANNOT call the JWT-gated
// natural create EFs.
//
// It also owns the queue row lifecycle: given a scheduled_id, it writes the row
// to 'done' (with the result summary) or 'failed' (with the error). The poller
// already marked the row 'running' + bumped attempts before firing this call.
//
// Like admin-web-create-project, the scheduler creates an UNOWNED listing
// (listing_type='web' is set by savePlaceData); there is NO
// accounts upsert here.
//
// Contract: verify_jwt=true; the gateway verifies the service-role credential,
// then requireInternalCaller checks it (JWT role claim or new secret API key).
//
// Local:  supabase functions serve supabase-cron-run-project-creations
// Deploy: supabase functions deploy supabase-cron-run-project-creations

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { requireInternalCaller } from "../_shared/internal.ts";
import { createMinimalPlace } from "../_shared/create-place.ts";

// `googlePlaceId` is the Google Place ID of the place to create (MESITA-51
// addendum 9: `placeId` is reserved for place-row UUIDs platform-wide, so
// the Google semantic moves to a distinct key on this new slug). The legacy
// `placeId` key is still accepted as a fallback for manual invocations.
type Body = { googlePlaceId?: string; placeId?: string; scheduled_id?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const env = envRes.env;

  // Service-role gate — the poller (and only the poller) reaches this EF.
  const callerRes = requireInternalCaller(req, env);
  if (!callerRes.ok) return callerRes.response;

  // Parse input.
  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const googlePlaceId = (bodyRes.body.googlePlaceId ?? bodyRes.body.placeId ?? "").toString().trim();
  const scheduledId = (bodyRes.body.scheduled_id ?? "").toString().trim() || null;
  if (!googlePlaceId) return json({ ok: false, error: "googlePlaceId is required" }, 400);

  const admin = adminClient(env);

  // Writes the queue row's terminal state. Best-effort — a row-update failure
  // never masks the real pipeline result we return to the caller. Touching
  // updated_at lets the reaper distinguish a row that's actively progressing
  // from a genuinely stuck one.
  const finishRow = async (
    status: "done" | "failed",
    fields: { result?: unknown; error?: string | null },
  ) => {
    if (!scheduledId) return;
    await admin
      .from("scheduled_project_creations")
      .update({
        status,
        result: fields.result ?? null,
        error: fields.error ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", scheduledId);
  };

  const created = await createMinimalPlace({
    admin,
    callerName: "supabase-cron-run-project-creations",
    googlePlaceId,
  });

  if (!created.ok) {
    // A duplicate is terminal 'failed' for the queue row, carrying the
    // existing-place code so the operator can see why.
    const code = (created.body.code as string | undefined) ?? null;
    await finishRow("failed", {
      error: code ?? (created.body.error as string | undefined) ?? "create_failed",
      result: code === "place_already_exists" ? { existing: created.body.existing } : null,
    });
    return json(created.body, created.status);
  }

  // Mark the queue row done — the place was created and enrichment queued.
  await finishRow("done", { result: { place: created.place, enrichment: created.enrichment } });

  return json(
    { ok: true, place: created.place, enrichment: created.enrichment, caller: callerRes.callerName },
    201,
  );
});
