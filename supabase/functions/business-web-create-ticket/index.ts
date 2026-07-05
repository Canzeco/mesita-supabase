// Supabase Edge Function — business-web-create-ticket
//
// Authenticated. The staff / validator opens a discount ticket against a
// consumer at their place. The body specifies which discount flow is run
// (`kind`): dp / s_dp_sf (with story) and their reservation-prefixed variants.
//
//   1. Verifies the caller's JWT and place membership.
//   2. Loads the place + consumer, validates input.
//   3. Snapshots the discount percent + cents off the subtotal. Mesita never
//      holds money — the discount is applied at the bill, paid off-rail.
//   4. If the kind includes a story (S in the name), seeds story_status =
//      'pending' so the post-meal story verify flow is gated.
//   5. If the kind is reservation-prefixed (R…), accepts reservation fields
//      and seeds reservation_status so the AI agent layer can pick it up.
//
// Self-contained: own auth, own DB writes via the service role, no
// function-to-function calls.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson, readPlaceIdAlias } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import {
  ACTIONABLE_KINDS,
  RESERVATION_KINDS,
  STORY_KINDS,
  toDbTicketKind,
} from "../_shared/ticket-kinds.ts";
import { isConsumerFirstVisit, selectprojectRate } from "../_shared/membership.ts";
import { computeTicketBill } from "../_shared/business-ticket-billing.ts";
import { closeTicketAndEnqueueReview } from "../_shared/ticket-informal.ts";
import { toCents } from "../_shared/money.ts";

type Body = {
  /** Canonical place-row id key (MESITA-26); `projectId` kept as legacy alias. */
  placeId?: string;
  projectId?: string;
  consumerCode?: string;
  kind?: string;
  /** Scan-only: link guest code without billing. Bill is submitted separately. */
  scanOnly?: boolean;
  checkSubtotalCents?: number;
  // Reservation fields (R-prefixed kinds)
  reservationAt?: string;
  reservationPartySize?: number;
  reservationChannel?: string;
  reservationNotes?: string;
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
  const validatorId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const projectId = readPlaceIdAlias(body);
  const consumerCode = (body.consumerCode ?? "").toString().trim().toUpperCase();
  const kind = (body.kind ?? "dp").toString().trim();

  if (!projectId) return json({ ok: false, error: "projectId is required" }, 400);
  if (!consumerCode) return json({ ok: false, error: "consumerCode is required" }, 400);
  if (!ACTIONABLE_KINDS.has(kind)) {
    return json(
      { ok: false, error: `Unsupported ticket kind: ${kind}` },
      400,
    );
  }

  const requiresStory = STORY_KINDS.has(kind);
  const isReservation = RESERVATION_KINDS.has(kind);
  // Persisted enum value — story is orthogonal (story_status), so kind only
  // distinguishes reservation vs coupon.
  const dbKind = toDbTicketKind(kind);
  const scanOnly = body.scanOnly === true;

  const admin = adminClient(envRes.env);

  // ── Membership ────────────────────────────────────────────────────────
  const memberRes = await requireMembership(admin, authRes.user, projectId);
  if (!memberRes.ok) return memberRes.response;

  // ── Place snapshot ──────────────────────────────────────────────────
  const placeRow = await admin
    .from("projects_view")
    .select(
      "id, name, slug, photos, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, monthly_promo_cap, listing_type, status, fiscal_type",
    )
    .eq("id", projectId)
    .maybeSingle();
  if (placeRow.error || !placeRow.data) {
    return json({ ok: false, error: "Place not found" }, 404);
  }
  const place = placeRow.data;
  if (place.status === "archived") {
    return json({ ok: false, error: "Place is archived" }, 409);
  }

  // ── Consumer lookup ─────────────────────────────────────────────────
  const consumerRow = await admin
    .from("consumers")
    .select("id, code, full_name, class_key")
    .eq("code", consumerCode)
    .maybeSingle();
  if (consumerRow.error) {
    return json(
      { ok: false, error: `consumer_lookup: ${consumerRow.error.message}` },
      500,
    );
  }
  if (!consumerRow.data) {
    return json({ ok: false, error: `No consumer with code ${consumerCode}` }, 404);
  }
  const consumerId = consumerRow.data.id;

  // ── Scan-only (no bill yet) ─────────────────────────────────────────
  if (scanOnly) {
    const insert = await admin
      .from("tickets")
      .insert({
        project_id: projectId,
        consumer_id: consumerId,
        opened_by: validatorId,
        kind: dbKind,
        status: "open",
        // Story is orthogonal to `kind` now (enum collapsed to reservation|coupon),
        // so seed the story requirement here from the wire kind — otherwise the
        // scan→bill path would lose it and never gate the story verify step.
        story_status: requiresStory ? "pending" : "not_required",
        check_subtotal_cents: null,
        tip_cents: null,
        total_cents: null,
        redeem_cents: 0,
        discount_percent: null,
        discount_cents: null,
        revealed_at: null,
      })
      .select(
        "id, kind, status, story_status, check_subtotal_cents, tip_cents, total_cents, discount_percent, discount_cents, revealed_at, currency, created_at",
      )
      .single();
    if (insert.error) {
      return json(
        { ok: false, error: `ticket_insert: ${insert.error.message}` },
        500,
      );
    }

    return json(
      {
        ok: true,
        ticket: insert.data,
        place: { id: place.id, name: place.name, fiscal_type: place.fiscal_type },
        consumer: {
          id: consumerId,
          code: consumerRow.data.code,
          full_name: consumerRow.data.full_name,
        },
      },
      201,
    );
  }

  // Bill subtotal required when not scan-only.
  const subtotal = toCents(body.checkSubtotalCents);
  if (subtotal == null) {
    return json(
      { ok: false, error: "checkSubtotalCents must be a non-negative integer" },
      400,
    );
  }

  const firstVisit = await isConsumerFirstVisit(admin, consumerId, projectId);
  const ratePercent = selectprojectRate(place, consumerRow.data.class_key, firstVisit);
  const capPesos = place.monthly_promo_cap;

  const billRes = computeTicketBill({ subtotal, ratePercent, capPesos });
  if (!billRes.ok) {
    return json({ ok: false, code: billRes.code, error: billRes.error }, 400);
  }
  const snap = billRes.snapshot;

  // ── Reservation fields ────────────────────────────────────────────────
  let reservationAt: string | null = null;
  let reservationPartySize: number | null = null;
  let reservationChannel: string | null = null;
  let reservationNotes: string | null = null;
  let reservationStatus: string | null = null;
  if (isReservation) {
    if (body.reservationAt) {
      const parsed = new Date(body.reservationAt);
      if (Number.isNaN(parsed.getTime())) {
        return json(
          { ok: false, error: "reservationAt must be an ISO timestamp" },
          400,
        );
      }
      reservationAt = parsed.toISOString();
    }
    if (body.reservationPartySize != null) {
      const n = Number(body.reservationPartySize);
      if (!Number.isFinite(n) || n < 1) {
        return json(
          { ok: false, error: "reservationPartySize must be ≥ 1" },
          400,
        );
      }
      reservationPartySize = Math.trunc(n);
    }
    if (body.reservationChannel) {
      const allowed = [
        "voice",
        "whatsapp",
        "instagram_dm",
        "web_form",
        "email",
      ];
      if (!allowed.includes(body.reservationChannel)) {
        return json(
          {
            ok: false,
            error: `reservationChannel must be one of ${allowed.join(", ")}`,
          },
          400,
        );
      }
      reservationChannel = body.reservationChannel;
    }
    if (body.reservationNotes) {
      reservationNotes = String(body.reservationNotes).slice(0, 500);
    }
    // The ticket is opened *at* the table — the consumer is here, the
    // reservation succeeded — so seed 'confirmed'.
    reservationStatus = "confirmed";
  }

  // ── Lifecycle status at insert time ───────────────────────────────────
  // The discount is applied at the bill right now and settles off-rail, so the
  // ticket closes here for Type A. Type B stays open for the story to verify.
  const now = new Date().toISOString();
  const status = requiresStory ? "awaiting_story" : "revealed";
  const storyStatus = requiresStory ? "pending" : "not_required";

  // ── Insert ────────────────────────────────────────────────────────────
  const insert = await admin
    .from("tickets")
    .insert({
      project_id: projectId,
      consumer_id: consumerId,
      opened_by: validatorId,
      kind: dbKind,
      status,
      story_status: storyStatus,
      check_subtotal_cents: snap.checkSubtotalCents,
      tip_cents: snap.tipCents,
      total_cents: snap.totalCents,
      redeem_cents: 0,
      discount_percent: snap.discountPercent,
      discount_cents: snap.discountCents,
      revealed_at: requiresStory ? null : now,
      paid_at: requiresStory ? null : now,
      reservation_status: reservationStatus,
      reservation_at: reservationAt,
      reservation_party_size: reservationPartySize,
      reservation_channel: reservationChannel,
      reservation_notes: reservationNotes,
    })
    .select(
      "id, kind, status, story_status, check_subtotal_cents, tip_cents, total_cents, discount_percent, discount_cents, revealed_at, reservation_status, reservation_at, reservation_party_size, currency, created_at",
    )
    .single();
  if (insert.error) {
    return json(
      { ok: false, error: `ticket_insert: ${insert.error.message}` },
      500,
    );
  }

  // Deliver the discounted bill receipt to the consumer Pay/Tickets inbox.
  await admin.from("consumer_pay_notifications").insert({
    consumer_id: consumerId,
    ticket_id: insert.data.id,
    kind: "bill",
    status: "completed",
    resolved_at: now,
    payload: {
      project_id: place.id,
      place_slug: place.slug ?? null,
      place_name: place.name,
      place_photo_url: place.photos?.[0] ?? null,
      ticket_kind: kind,
      check_subtotal_cents: snap.checkSubtotalCents,
      tip_cents: snap.tipCents,
      total_cents: snap.totalCents,
      discount_cents: snap.discountCents ?? 0,
      discount_percent: snap.discountPercent ?? 0,
      total_reward_cents: snap.discountCents ?? 0,
      reward_cap_mxn: capPesos ?? null,
      amount_due_cents: snap.amountDueCents,
      currency: insert.data.currency ?? "MXN",
    },
  });

  // Type A closes immediately — queue the consumer's review now.
  if (!requiresStory) {
    await closeTicketAndEnqueueReview(admin, insert.data.id, consumerId, place.id);
  }

  return json(
    {
      ok: true,
      ticket: insert.data,
      place: {
        id: place.id,
        name: place.name,
        fiscal_type: place.fiscal_type,
      },
      consumer: {
        id: consumerId,
        code: consumerRow.data.code,
        full_name: consumerRow.data.full_name,
      },
    },
    201,
  );
});
