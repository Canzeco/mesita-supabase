// Supabase Edge Function — business-request-manual-review
//
// Always-available fallback for /add ownership verification. Used when:
//
//   * the place has no Google-listed phone, AND
//   * no on-domain email was discovered on the website
//
// …or any operator who'd rather talk to a human. Unlike ai_call and
// ai_email, this path NEVER auto-grants ownership. It writes a pending
// project_verifications row (method='manual_contact') so the admin queue
// sees the request, and returns the Mesita ops contact details the UI
// renders as deep-link buttons.
//
// Region routing (off the place's country):
//   MX / LatAm (long list)  →  WhatsApp as primary, email floor
//   US / CA                  →  SMS as primary, email floor
//   anything else / null     →  email only
//
// For now WhatsApp and SMS are placeholders — the buttons render off
// optional env vars (MESITA_OPS_WHATSAPP, MESITA_OPS_SMS) and when those
// are unset only the email button is shown. Email defaults to
// hello@mesita.ai. The UI uses these to build mailto:/wa.me:/sms: links;
// no provider integration runs here.
//
// Auth: any signed-in user.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson, readPlaceIdAlias } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { resolveRequesterEmail } from "../_shared/input.ts";

type Body = { placeId?: string; projectId?: string; requesterEmail?: string; note?: string };

type Region = "mx_latam" | "us" | "other";

const LATAM_COUNTRIES = new Set([
  "mexico",
  "argentina",
  "colombia",
  "chile",
  "peru",
  "uruguay",
  "brazil",
  "ecuador",
  "bolivia",
  "paraguay",
  "venezuela",
  "guatemala",
  "costa rica",
  "panama",
  "dominican republic",
  "el salvador",
  "honduras",
  "nicaragua",
  "puerto rico",
]);

function regionForCountry(country: string | null): Region {
  if (!country) return "other";
  const c = country.toLowerCase();
  if (c === "united states" || c === "us" || c === "canada" || c === "ca") {
    return "us";
  }
  if (LATAM_COUNTRIES.has(c)) return "mx_latam";
  return "other";
}

// Ops contact destinations. Email is hard-baked so the floor always
// works; WhatsApp/SMS are env-driven so we can flip them on without
// a redeploy when real numbers exist.
const OPS_EMAIL = "hello@mesita.ai";

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
  const projectId = readPlaceIdAlias(body);
  const note = (body.note ?? "").trim().slice(0, 500);
  if (!projectId) return json({ ok: false, error: "projectId is required" }, 400);

  const requesterEmail = resolveRequesterEmail({
    bodyEmail: body.requesterEmail,
    sessionEmail: authRes.user.emailLower,
    userId,
    allowMockFallback: true,
  });
  if (!requesterEmail) {
    return json(
      {
        ok: false,
        error:
          "Add an email to your Mesita account, or sign in with email, to start verification.",
      },
      400,
    );
  }

  const admin = adminClient(envRes.env);

  const { data: place, error: placeError } = await admin
    .from("projects_view")
    .select("id, name, country")
    .eq("id", projectId)
    .maybeSingle();
  if (placeError || !place) {
    return json({ ok: false, error: "Place not found" }, 404);
  }

  const { data: existingOwner } = await admin
    .from("project_members")
    .select("business_id")
    .eq("project_id", projectId)
    .eq("role", "owner")
    .maybeSingle();
  if (existingOwner) {
    return json(
      {
        ok: false,
        code: "place_already_owned",
        error:
          "This place already has a verified owner. Use the contact / report-fraud flow instead.",
      },
      409,
    );
  }

  const region = regionForCountry(place.country);
  const whatsapp = (Deno.env.get("MESITA_OPS_WHATSAPP") ?? "").trim() || null;
  const sms = (Deno.env.get("MESITA_OPS_SMS") ?? "").trim() || null;

  // Dedup: drop any prior pending row by this caller on this place
  // before inserting the new one. Same pattern as the OTP EFs.
  await admin
    .from("project_verifications")
    .delete()
    .eq("project_id", projectId)
    .eq("requester_id", userId)
    .eq("status", "pending");

  const { data: verification, error: insertError } = await admin
    .from("project_verifications")
    .insert({
      project_id: projectId,
      requester_id: userId,
      method: "manual_contact",
      payload: {
        region,
        note: note || null,
        // Mirror the resolved contact set on the row so admins reviewing
        // this later see exactly which channels we offered.
        offered: {
          whatsapp: region === "mx_latam" ? whatsapp : null,
          sms: region === "us" ? sms : null,
          email: OPS_EMAIL,
        },
      },
      requester_email: requesterEmail,
      // manual_contact never auto-verifies; the row sits in the admin
      // queue until a human flips it via admin-decide-verification.
      status: "pending",
    })
    .select("id")
    .single();
  if (insertError) {
    return json(
      { ok: false, error: `verification_insert: ${insertError.message}` },
      500,
    );
  }

  return json({
    ok: true,
    verificationId: verification.id,
    region,
    contact: {
      whatsapp: region === "mx_latam" ? whatsapp : null,
      sms: region === "us" ? sms : null,
      email: OPS_EMAIL,
    },
    placeName: place.name,
  });
});
