// TEMPORARY Edge Function — tmp-stripe-bootstrap
//
// Deployed once to provision the Mesita Stripe products/prices using the
// project's own STRIPE_SECRET_KEY (the key never leaves the server).
// Deleted from the cloud immediately after use. Never committed to main.
//
// Guarded by a random header token baked in at deploy time.

import Stripe from "npm:stripe@17";

const GUARD = "dd5334a28304ddc8efa6bec8ab242a03542dc50ac7e01600";
const OLD_PREMIUM_PRICE_ID = "price_1TcHZ0DullsJyvWdXl4BJmul";

type PlanSpec = {
  key: string;
  name: string;
  description: string;
  amountCents: number;
};

const PLANS: PlanSpec[] = [
  {
    key: "consumer_premium",
    name: "Mesita Premium",
    description:
      "Mesita consumer Premium plan. Monthly subscription via Stripe.",
    amountCents: 10000, // $100 MXN
  },
  {
    key: "business_pro",
    name: "Mesita Pro",
    description:
      "Mesita business Pro plan — medium visibility. Monthly subscription via Stripe.",
    amountCents: 10000, // $100 MXN
  },
  {
    key: "business_ultra",
    name: "Mesita Ultra",
    description:
      "Mesita business Ultra plan — max visibility. Monthly subscription via Stripe.",
    amountCents: 500000, // $5,000 MXN
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false }, 405);
  if (req.headers.get("x-guard") !== GUARD) return json({ ok: false }, 401);

  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) return json({ ok: false, error: "STRIPE_SECRET_KEY not set" }, 500);
  const stripe = new Stripe(key, { apiVersion: "2025-03-31.basil" });

  const { action } = await req.json().catch(() => ({ action: null }));

  if (action === "whoami") {
    const [acct, bal] = await Promise.all([
      stripe.accounts.retrieve(),
      stripe.balance.retrieve(),
    ]);
    let oldPremium: unknown = null;
    try {
      const p = await stripe.prices.retrieve(OLD_PREMIUM_PRICE_ID);
      oldPremium = {
        id: p.id,
        product: p.product,
        unit_amount: p.unit_amount,
        currency: p.currency,
        active: p.active,
        interval: p.recurring?.interval ?? null,
        livemode: p.livemode,
      };
    } catch (e) {
      oldPremium = { error: String(e) };
    }
    return json({
      ok: true,
      key_mode: key.startsWith("sk_live_")
        ? "live"
        : key.startsWith("sk_test_")
        ? "test"
        : key.slice(0, 3) === "rk_"
        ? "restricted"
        : "unknown",
      livemode: bal.livemode,
      account_id: acct.id,
      dashboard_name: acct.settings?.dashboard?.display_name ?? null,
      business_name: acct.business_profile?.name ?? null,
      old_premium_price: oldPremium,
    });
  }

  if (action === "bootstrap") {
    const out: Record<string, unknown> = {};

    for (const plan of PLANS) {
      // 1. Find (or create) the product, keyed by metadata.mesita_plan.
      const found = await stripe.products.search({
        query: `metadata['mesita_plan']:'${plan.key}' AND active:'true'`,
      });
      let product = found.data[0] ?? null;

      // The consumer premium product may already exist as the parent of the
      // old $200 price — reuse it and tag it instead of creating a twin.
      if (!product && plan.key === "consumer_premium") {
        try {
          const oldPrice = await stripe.prices.retrieve(OLD_PREMIUM_PRICE_ID);
          const prodId = typeof oldPrice.product === "string"
            ? oldPrice.product
            : oldPrice.product.id;
          product = await stripe.products.update(prodId, {
            name: plan.name,
            description: plan.description,
            metadata: { mesita_plan: plan.key },
          });
        } catch {
          /* old price gone — fall through to create */
        }
      }

      if (!product) {
        product = await stripe.products.create({
          name: plan.name,
          description: plan.description,
          metadata: { mesita_plan: plan.key },
        });
      }

      // 2. Find (or create) the active monthly MXN price at the right amount.
      const prices = await stripe.prices.list({
        product: product.id,
        active: true,
        limit: 100,
      });
      let price = prices.data.find(
        (p) =>
          p.unit_amount === plan.amountCents &&
          p.currency === "mxn" &&
          p.recurring?.interval === "month",
      ) ?? null;
      if (!price) {
        price = await stripe.prices.create({
          product: product.id,
          unit_amount: plan.amountCents,
          currency: "mxn",
          recurring: { interval: "month" },
          lookup_key: `${plan.key}_monthly`,
          transfer_lookup_key: true,
          metadata: { mesita_plan: plan.key },
        });
      }

      // 3. Deactivate any other active recurring price on the product so
      //    only the canonical monthly price can be checked out.
      for (const other of prices.data) {
        if (other.id !== price.id && other.active) {
          await stripe.prices.update(other.id, { active: false });
        }
      }
      await stripe.products.update(product.id, { default_price: price.id });

      out[plan.key] = {
        product_id: product.id,
        price_id: price.id,
        unit_amount: plan.amountCents,
        currency: "mxn",
        interval: "month",
      };
    }

    const bal = await stripe.balance.retrieve();
    return json({ ok: true, livemode: bal.livemode, plans: out });
  }

  return json({ ok: false, error: "unknown action" }, 400);
});
