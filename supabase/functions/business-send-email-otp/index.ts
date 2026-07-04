// Supabase Edge Function — business-send-email-otp
//
// Phase 1 of the automatic-email path for /add ownership verification.
// Sends a 6-digit OTP to the place's Firecrawl-discovered email — but
// only when that email is **on-domain**, i.e. its host matches the
// place's own website_url. A gmail/hotmail/etc. address scraped from
// the site doesn't qualify; the manual fallback covers those.
//
// On-domain rule: email host == website host (both stripped of "www.").
// We also accept exact subdomain matches in either direction, so
// "hola@reservas.casaluminar.mx" against website "casaluminar.mx" still
// passes. That window is intentionally wide — a place's own subdomain
// is still the place.
//
// Mock mode: no transactional email provider is wired yet, so the
// plaintext code is returned in `mockCode`. The operator types it back
// in the UI; business-verify-email-otp closes the loop. Provider wiring
// (Resend / Postmark / etc.) lands later without changing the contract.
//
// The email NEVER comes from the user. We always send to the email
// stored on the place row, captured at create time.
//
// Auth: any signed-in user. Pending-row dedup mirrors the phone path.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson, readPlaceIdAlias } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { resolveRequesterEmail } from "../_shared/input.ts";
import { isOnDomain } from "../_shared/onboarding.ts";
import {
  insertPendingOtpVerification,
  randomSixDigits,
  sha256Hex,
} from "../_shared/otp.ts";
import {
  isPlaceOtpMockMode,
  mockPlaceOtpEmail,
} from "../_shared/place-otp-mock.ts";

type Body = { placeId?: string; projectId?: string; requesterEmail?: string };

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
    .select("id, email, website_url")
    .eq("id", projectId)
    .maybeSingle();
  if (placeError || !place) {
    return json({ ok: false, error: "Place not found" }, 404);
  }
  if (!place.email || !place.website_url) {
    return json(
      {
        ok: false,
        code: "no_on_domain_email",
        error:
          "This place has no on-domain email on file — use the phone or manual fallback.",
      },
      409,
    );
  }
  if (!isOnDomain(place.email, place.website_url)) {
    return json(
      {
        ok: false,
        code: "email_not_on_domain",
        error:
          "The place's email isn't on the same domain as its website — use the manual fallback.",
      },
      409,
    );
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

  const code = randomSixDigits();
  const codeHash = await sha256Hex(code);
  const mockCode = mockMode ? code : null;
  const sentTo = mockMode ? mockPlaceOtpEmail() : place.email;

  const insertRes = await insertPendingOtpVerification(admin, {
    projectId,
    userId,
    requesterEmail,
    method: "ai_email",
    payload: {
      emailSent: place.email,
      websiteUrl: place.website_url,
      mockMode,
      displayEmail: sentTo,
    },
    codeHash,
  });
  if (!insertRes.ok) return insertRes.response;

  // Outbound email intentionally not implemented — place inboxes are not emailed.

  return json({
    ok: true,
    verificationId: insertRes.verificationId,
    sentTo,
    mockMode,
    mockCode,
  });
});

