// Supabase Edge Function — stripe-handle-webhook (external caller)
//
// Public endpoint (verify_jwt disabled at the gateway). Security rests
// entirely on Stripe signature verification with STRIPE_WEBHOOK_SECRET — an
// unsigned or mis-signed request is rejected.
//
// One endpoint, two billing surfaces, discriminated by metadata:
//   • consumer_id  → consumer Premium ($100 MXN/mo). The ONLY writer that
//     flips a consumer to/from Premium on the back of the paid door.
//   • project_id   → place plans (Promote/Ultra). The ONLY writer that flips
//     projects.plan on the back of the paid door.
//
// Idempotency: Stripe retries deliveries. We record every processed event id
// in public.stripe_events and no-op on replays.
//
// Tier/plan precedence rule: a subscription lapse only downgrades an
// entitlement that came through the paid door. A consumer's Premium earned
// via Instagram or invitation is never stripped because a card failed — and
// a place plan granted outside billing is only lowered when it matches the
// plan the lapsed subscription was paying for.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { STRIPE_API_VERSION, STRIPE_CATALOG } from "../_shared/stripe-billing.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return new Response("Server misconfigured", { status: 500 });

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!stripeKey || !webhookSecret) {
    return new Response("Stripe not configured", { status: 500 });
  }
  const stripe = new Stripe(stripeKey, { apiVersion: STRIPE_API_VERSION });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, webhookSecret);
  } catch (err) {
    console.error("[stripe-handle-webhook] signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  const admin = adminClient(envRes.env);

  // Idempotency guard. If the event id is already recorded, this is a replay.
  const dedupe = await admin
    .from("stripe_events")
    .insert({ event_id: event.id });
  if (dedupe.error) {
    // 23505 = unique violation = already processed. Anything else is a real
    // error, but we still 200 so Stripe doesn't hammer retries on a transient.
    if (dedupe.error.code === "23505") {
      return new Response(JSON.stringify({ received: true, replay: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    console.error("[stripe-handle-webhook] dedupe insert error:", dedupe.error);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id ?? null;
        if (!subscriptionId) break;

        // Business checkout sessions always carry project_id metadata;
        // consumer ones carry consumer_id (or client_reference_id).
        const projectId =
          (session.metadata?.project_id as string | undefined) ?? null;
        if (projectId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          await reconcileProjectSubscription(admin, projectId, sub);
          break;
        }

        const consumerId =
          session.client_reference_id ??
          (session.metadata?.consumer_id as string | undefined) ??
          null;
        if (consumerId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          await reconcileConsumerSubscription(admin, consumerId, sub);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;

        const projectId =
          (sub.metadata?.project_id as string | undefined) ??
          (await resolveProjectId(admin, sub));
        if (projectId) {
          await reconcileProjectSubscription(admin, projectId, sub);
          break;
        }

        const consumerId = await resolveConsumerId(admin, stripe, sub);
        if (consumerId) {
          await reconcileConsumerSubscription(admin, consumerId, sub);
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged and ignored.
        break;
    }
  } catch (err) {
    console.error(`[stripe-handle-webhook] handler error (${event.type}):`, err);
    return new Response("Handler error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// ─── Consumer side ──────────────────────────────────────────────────────────

// Maps a Stripe subscription back to a Mesita consumer via metadata, falling
// back to the customer's metadata.
async function resolveConsumerId(
  admin: ReturnType<typeof adminClient>,
  stripe: Stripe,
  sub: Stripe.Subscription,
): Promise<string | null> {
  const fromSub = sub.metadata?.consumer_id as string | undefined;
  if (fromSub) return fromSub;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  // Try our own table first.
  const { data } = await admin
    .from("consumer_subscriptions")
    .select("consumer_id")
    .eq("stripe_customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (data?.consumer_id) return data.consumer_id as string;
  // Last resort: read the customer's metadata from Stripe.
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) {
      return (customer.metadata?.consumer_id as string | undefined) ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// Upserts the local subscription mirror and applies the tier side-effect.
async function reconcileConsumerSubscription(
  admin: ReturnType<typeof adminClient>,
  consumerId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  const localStatus = mapStatus(sub.status);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const priceCents = sub.items.data[0]?.price.unit_amount ?? null;
  const currency = (sub.items.data[0]?.price.currency ?? "mxn").toUpperCase();

  await admin
    .from("consumer_subscriptions")
    .upsert(
      {
        consumer_id: consumerId,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        status: localStatus,
        price_cents: priceCents,
        currency,
        current_period_end: periodEnd,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
      },
      { onConflict: "stripe_subscription_id" },
    );

  const isLive = localStatus === "active" || localStatus === "past_due";
  if (isLive) {
    // Grant Premium via the subscription door.
    await admin
      .from("consumers")
      .update({
        tier_key: "premium",
        tier_origin: "subscription",
        tier_granted_at: new Date().toISOString(),
        tier_expires_at: periodEnd,
      })
      .eq("id", consumerId);
  } else {
    // Lapsed/cancelled: only downgrade if Premium came through the paid door.
    // An Instagram/invitation Premium is left untouched.
    await admin
      .from("consumers")
      .update({
        tier_key: "free",
        tier_origin: "default",
        tier_expires_at: null,
      })
      .eq("id", consumerId)
      .eq("tier_origin", "subscription");
  }
}

// ─── Business side ──────────────────────────────────────────────────────────

// Maps a Stripe subscription back to a Mesita project via our own mirror
// table (subscription metadata was already checked by the caller).
async function resolveProjectId(
  admin: ReturnType<typeof adminClient>,
  sub: Stripe.Subscription,
): Promise<string | null> {
  const { data: bySub } = await admin
    .from("project_subscriptions")
    .select("project_id")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  if (bySub?.project_id) return bySub.project_id as string;

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { data: byCustomer } = await admin
    .from("project_subscriptions")
    .select("project_id")
    .eq("stripe_customer_id", customerId)
    .limit(1)
    .maybeSingle();
  return (byCustomer?.project_id as string | undefined) ?? null;
}

// Resolves which Mesita plan a Stripe subscription pays for: subscription
// metadata first, then the price id against business_plans, then the price
// lookup_key against the static catalog.
async function resolvePlanKey(
  admin: ReturnType<typeof adminClient>,
  sub: Stripe.Subscription,
): Promise<string | null> {
  const fromMeta = sub.metadata?.plan_key as string | undefined;
  if (fromMeta === "pro" || fromMeta === "ultra") return fromMeta;

  const price = sub.items.data[0]?.price ?? null;
  if (!price) return null;

  const { data } = await admin
    .from("business_plans")
    .select("key")
    .eq("stripe_price_id", price.id)
    .maybeSingle();
  if (data?.key) return data.key as string;

  const byLookup = STRIPE_CATALOG.find(
    (e) => e.lookupKey === price.lookup_key && e.table === "business_plans",
  );
  return byLookup?.rowKey ?? null;
}

// Upserts the project's subscription mirror and applies the plan side-effect.
async function reconcileProjectSubscription(
  admin: ReturnType<typeof adminClient>,
  projectId: string,
  sub: Stripe.Subscription,
): Promise<void> {
  const localStatus = mapStatus(sub.status);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;
  const priceCents = sub.items.data[0]?.price.unit_amount ?? null;
  const currency = (sub.items.data[0]?.price.currency ?? "mxn").toUpperCase();

  const planKey = await resolvePlanKey(admin, sub);
  if (!planKey) {
    console.error(
      `[stripe-handle-webhook] no plan_key resolvable for subscription ${sub.id} (project ${projectId})`,
    );
    return;
  }

  await admin
    .from("project_subscriptions")
    .upsert(
      {
        project_id: projectId,
        plan_key: planKey,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        status: localStatus,
        price_cents: priceCents,
        currency,
        current_period_end: periodEnd,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
      },
      { onConflict: "stripe_subscription_id" },
    );

  const isLive = localStatus === "active" || localStatus === "past_due";
  if (isLive) {
    // Grant the paid plan.
    await admin
      .from("projects")
      .update({ plan: planKey })
      .eq("id", projectId);
  } else {
    // Lapsed/cancelled: only lower the plan when it matches what this
    // subscription was paying for. A plan granted through another door
    // (admin, partnership) is left untouched.
    await admin
      .from("projects")
      .update({ plan: "free" })
      .eq("id", projectId)
      .eq("plan", planKey);
  }
}

function mapStatus(s: string): string {
  switch (s) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "unpaid":
      return "unpaid";
    default:
      return "incomplete";
  }
}
