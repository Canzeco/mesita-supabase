// Supabase Edge Function — business-change-subscription (natural caller)
//
// Authenticated, owner-only. The paid "door" into a place's plan: Free,
// Promote ('pro', $100 MXN/mo) or Ultra ('ultra', $5,000 MXN/mo).
//
// A Stripe subscription is billing, not entitlement: projects.plan is the
// single source of truth and can be granted through other doors (admin,
// partnership). This EF and the Stripe webhook only ever couple the two for
// plans that came through the paid door.
//
// Modes, chosen by the same MOCK_SUBSCRIPTION toggle consumer billing uses:
//
//   • MOCK — grants the plan immediately, records a mock active subscription
//     row, and returns the success URL. No money moves. Also runs whenever
//     STRIPE_SECRET_KEY is absent so a project with no Stripe secret still
//     works out of the box.
//
//   • REAL — creates a Stripe Checkout Session (or switches / cancels the
//     live subscription in place) and lets stripe-handle-webhook flip
//     projects.plan once Stripe confirms.
//
// Body: { projectId: string, plan: "free" | "pro" | "ultra",
//         successUrl?: string, cancelUrl?: string }
// Response (one of):
//   { ok: true, checkout_url: string, mock?: true }   — go pay (or mock-paid)
//   { ok: true, plan, already_subscribed: true }      — no-op
//   { ok: true, plan, plan_switched: true }           — pro↔ultra in place
//   { ok: true, plan: "free", scheduled_downgrade: true, current_period_end }
//   { ok: true, plan: "free" }                        — downgraded now

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { corsPreflight, json, readJson, readPlaceIdAlias } from "../_shared/http.ts";
import { adminClient, getAuthedUser, readEFEnv, requireOwner } from "../_shared/auth.ts";
import {
  ensureWholeCatalog,
  resolvePlanPrice,
  STRIPE_API_VERSION,
} from "../_shared/stripe-billing.ts";

type Body = {
  /** Canonical place-row id key (MESITA-26); `projectId` kept as legacy alias. */
  placeId?: string;
  projectId?: string;
  plan?: string;
  successUrl?: string;
  cancelUrl?: string;
};

const PAID_PLANS = new Set(["pro", "ultra"]);
const MOCK_PERIOD_DAYS = 30;

// ⚠️ DEMO MOCK — same single on/off switch as consumer-create-subscription.
// Set the MOCK_SUBSCRIPTION env to "false" and redeploy to require real
// Stripe Checkout payments.
const MOCK_SUBSCRIPTION =
  (Deno.env.get("MOCK_SUBSCRIPTION") ?? "true").toLowerCase() !== "false";

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
  const projectId = readPlaceIdAlias(bodyRes.body);
  const plan = (bodyRes.body.plan ?? "").toString().trim();
  if (!projectId) return json({ ok: false, error: "projectId is required" }, 400);
  if (plan !== "free" && !PAID_PLANS.has(plan)) {
    return json({ ok: false, error: "plan must be one of free | pro | ultra" }, 400);
  }

  const admin = adminClient(envRes.env);

  // Billing is owner-level (super-admins bypass inside requireOwner).
  const ownerRes = await requireOwner(
    admin,
    authRes.user,
    projectId,
    "Only owners can change the subscription.",
  );
  if (!ownerRes.ok) return ownerRes.response;

  const origin = req.headers.get("origin") ?? "";
  const successUrl =
    bodyRes.body.successUrl ??
    `${origin}/unit/${projectId}/promos/plan?subscription=success`;
  const cancelUrl =
    bodyRes.body.cancelUrl ??
    `${origin}/unit/${projectId}/promos/plan?subscription=cancelled`;

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const mockMode = MOCK_SUBSCRIPTION || !stripeKey;

  // The one live billing row for this project, if any. Mock rows are
  // recognisable by their id prefix regardless of the current toggle.
  const { data: liveSub } = await admin
    .from("project_subscriptions")
    .select("stripe_subscription_id, stripe_customer_id, plan_key, current_period_end")
    .eq("project_id", projectId)
    .in("status", ["active", "past_due"])
    .maybeSingle();
  const liveSubId = (liveSub?.stripe_subscription_id ?? "") as string;
  const liveIsMock = liveSubId.startsWith("mock_");

  // ── Downgrade to free ─────────────────────────────────────────────────────
  if (plan === "free") {
    if (liveSub && !liveIsMock && stripeKey) {
      // Real live subscription: cancel at period end; the plan stays paid
      // until then and the webhook flips it on customer.subscription.deleted.
      const stripe = new Stripe(stripeKey, { apiVersion: STRIPE_API_VERSION });
      await stripe.subscriptions.update(liveSubId, {
        cancel_at_period_end: true,
      });
      await admin
        .from("project_subscriptions")
        .update({ cancel_at_period_end: true })
        .eq("stripe_subscription_id", liveSubId);
      return json({
        ok: true,
        plan: "free",
        scheduled_downgrade: true,
        current_period_end: liveSub.current_period_end ?? null,
      });
    }

    // Mock subscription (or nothing billable on file): downgrade now.
    if (liveSub && liveIsMock) {
      await admin
        .from("project_subscriptions")
        .update({ status: "canceled", cancel_at_period_end: true })
        .eq("stripe_subscription_id", liveSubId);
    }
    const down = await admin
      .from("projects")
      .update({ plan: "free" })
      .eq("id", projectId);
    if (down.error) {
      return json({ ok: false, error: `downgrade: ${down.error.message}` }, 500);
    }
    return json({ ok: true, plan: "free" });
  }

  // ── Paid plans ────────────────────────────────────────────────────────────
  const { data: planRow } = await admin
    .from("business_plans")
    .select("key, label, price_cents, currency")
    .eq("key", plan)
    .maybeSingle();
  if (!planRow) {
    return json({ ok: false, error: `Plan '${plan}' is not configured` }, 500);
  }

  // Already on this plan? No-op — UNLESS we're in real mode and the live row
  // is only a leftover mock grant (from when MOCK_SUBSCRIPTION was on). In
  // that case fall through so the owner gets real Stripe billing; the webhook
  // retires the mock row when the real subscription lands.
  if (liveSub?.plan_key === plan && (mockMode || !liveIsMock)) {
    return json({ ok: true, plan, already_subscribed: true });
  }

  // ── MOCK mode ─────────────────────────────────────────────────────────────
  if (mockMode) {
    const periodEnd = new Date(
      Date.now() + MOCK_PERIOD_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    // Stable per-project id so re-subscribing updates the same row instead of
    // tripping the one-live-subscription-per-project unique index.
    const mockSubId = `mock_${projectId}`;

    const sub = await admin
      .from("project_subscriptions")
      .upsert(
        {
          project_id: projectId,
          plan_key: plan,
          stripe_subscription_id: mockSubId,
          stripe_customer_id: `mock_cus_${projectId}`,
          status: "active",
          price_cents: planRow.price_cents,
          currency: planRow.currency ?? "MXN",
          current_period_end: periodEnd,
          cancel_at_period_end: false,
        },
        { onConflict: "stripe_subscription_id" },
      );
    if (sub.error) {
      return json({ ok: false, error: `mock_subscription: ${sub.error.message}` }, 500);
    }

    const grant = await admin
      .from("projects")
      .update({ plan })
      .eq("id", projectId);
    if (grant.error) {
      return json({ ok: false, error: `mock_grant: ${grant.error.message}` }, 500);
    }

    return json({ ok: true, plan, checkout_url: successUrl, mock: true });
  }

  // ── REAL Stripe mode ──────────────────────────────────────────────────────
  const stripe = new Stripe(stripeKey!, { apiVersion: STRIPE_API_VERSION });

  const resolved = await resolvePlanPrice(admin, stripe, `business_${plan}` as
    | "business_pro"
    | "business_ultra");
  if (!resolved) {
    return json({ ok: false, error: `Plan '${plan}' price not configured` }, 500);
  }
  // Materialize the rest of the catalog in the background (best effort).
  void ensureWholeCatalog(admin, stripe);

  // Live real subscription on the other paid plan → switch the price in
  // place (prorated); the webhook reconciles the mirror + projects.plan.
  if (liveSub && !liveIsMock) {
    const current = await stripe.subscriptions.retrieve(liveSubId);
    const itemId = current.items.data[0]?.id;
    if (!itemId) {
      return json({ ok: false, error: "Live subscription has no item to switch" }, 500);
    }
    await stripe.subscriptions.update(liveSubId, {
      items: [{ id: itemId, price: resolved.priceId }],
      proration_behavior: "create_prorations",
      cancel_at_period_end: false,
      metadata: { project_id: projectId, plan_key: plan, mesita_kind: "business" },
    });
    // Optimistic flip — the subsequent customer.subscription.updated webhook
    // writes the same values idempotently.
    await admin
      .from("project_subscriptions")
      .update({
        plan_key: plan,
        price_cents: resolved.priceCents,
        currency: resolved.currency,
        cancel_at_period_end: false,
      })
      .eq("stripe_subscription_id", liveSubId);
    await admin.from("projects").update({ plan }).eq("id", projectId);
    return json({ ok: true, plan, plan_switched: true });
  }

  // Fresh checkout. Reuse an existing real Stripe customer if this project
  // has been through billing before.
  const { data: existing } = await admin
    .from("project_subscriptions")
    .select("stripe_customer_id")
    .eq("project_id", projectId)
    .not("stripe_customer_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let customerId = (existing?.stripe_customer_id as string | null) ?? null;
  if (!customerId || customerId.startsWith("mock_")) {
    const customer = await stripe.customers.create({
      metadata: { project_id: projectId },
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    client_reference_id: projectId,
    line_items: [{ price: resolved.priceId, quantity: 1 }],
    metadata: { project_id: projectId, plan_key: plan, mesita_kind: "business" },
    subscription_data: {
      metadata: { project_id: projectId, plan_key: plan, mesita_kind: "business" },
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  await admin.from("project_subscriptions").upsert(
    {
      project_id: projectId,
      plan_key: plan,
      stripe_customer_id: customerId,
      status: "incomplete",
      price_cents: resolved.priceCents,
      currency: resolved.currency,
    },
    { onConflict: "stripe_subscription_id", ignoreDuplicates: true },
  );

  return json({ ok: true, plan, checkout_url: session.url });
});
