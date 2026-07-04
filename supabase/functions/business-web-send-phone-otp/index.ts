// Supabase Edge Function — business-web-send-phone-otp
//
// Phase 1 of the automatic-phone path for /add ownership verification.
// Generates a 6-digit code, hashes it (SHA-256), inserts a pending
// project_verifications row (method='ai_call', payload={phoneCalled,
// channel, codeHash}), and "dispatches" the code to the
// Google-listed phone via Twilio.
//
// MOCK ONLY — we never dial place.phone (see place-otp-mock.ts). mockCode on screen.
//
// The phone NEVER comes from the user. We always dial the place's
// google_place_id-sourced phone, copied to payload.phoneCalled at insert
// time so an admin reviewing the row knows exactly what we tried.
//
// Auth: any signed-in user. Dedup against an existing pending row for
// (place, requester) is handled here — submitting again replaces the
// prior claim.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson, readPlaceIdAlias } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { resolveRequesterEmail } from "../_shared/input.ts";
import {
  insertPendingOtpVerification,
  randomSixDigits,
  sha256Hex,
} from "../_shared/otp.ts";
import {
  isPlaceOtpMockMode,
  mockPlaceOtpPhone,
} from "../_shared/place-otp-mock.ts";

type Body = { placeId?: string; projectId?: string; requesterEmail?: string };

// Channel choice. Voice for LatAm (landlines common; SMS-to-landline
// fails). SMS for US/CA (mobile-dominant; voice OTPs feel jarring).
// Everywhere else defaults to voice — the EF still works, the operator
// just hears the code instead of reading it.
function channelForCountry(country: string | null): "call" | "sms" {
  if (!country) return "call";
  const c = country.toLowerCase();
  if (c === "united states" || c === "us" || c === "canada" || c === "ca") {
    return "sms";
  }
  return "call";
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
  const projectId = readPlaceIdAlias(body);
  if (!projectId) return json({ ok: false, error: "projectId is required" }, 400);

  const mockMode = isPlaceOtpMockMode();
  const requesterEmail = resolveRequesterEmail({
    bodyEmail: body.requesterEmail,
    sessionEmail: authRes.user.emailLower,
    userId,
    allowMockFallback: mockMode,
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
    .select("id, phone, country")
    .eq("id", projectId)
    .maybeSingle();
  if (placeError || !place) {
    return json({ ok: false, error: "Place not found" }, 404);
  }
  if (!place.phone) {
    return json(
      {
        ok: false,
        code: "no_phone_on_record",
        error:
          "This place has no Google-listed phone — use the email or manual fallback.",
      },
      409,
    );
  }

  // Owner check — never let a claim go through on an already-owned
  // place. The lookup EF blocks the UI from getting here, but a
  // second guard keeps the path safe under stale clients.
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

  const channel = channelForCountry(place.country);
  const code = randomSixDigits();
  const codeHash = await sha256Hex(code);
  const mockCode = mockMode ? code : null;
  const phoneDialed = mockMode ? mockPlaceOtpPhone() : place.phone;

  const insertRes = await insertPendingOtpVerification(admin, {
    projectId,
    userId,
    requesterEmail,
    method: "ai_call",
    payload: {
      phoneCalled: place.phone,
      channel,
      mockMode,
      displayPhone: phoneDialed,
    },
    codeHash,
  });
  if (!insertRes.ok) return insertRes.response;

  // Outbound calls intentionally not implemented — places are never dialed.

  return json({
    ok: true,
    verificationId: insertRes.verificationId,
    channel,
    phoneDialed,
    mockMode,
    mockCode,
  });
});

