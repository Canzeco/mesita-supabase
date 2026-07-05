// Shared Stripe billing helpers — the single place the Mesita subscription
// catalog (three products, all monthly MXN) is defined and provisioned.
//
//   consumer_premium — Mesita Premium  · $100 MXN/mo · classes.premium
//   business_pro     — Mesita Pro  · $100 MXN/mo · business_plans.pro
//   business_ultra   — Mesita Ultra    · $5,000 MXN/mo · business_plans.ultra
//
// resolvePlanPrice() is self-provisioning: the first real checkout after a
// deploy materializes the product + price in whatever Stripe account
// STRIPE_SECRET_KEY points at (live or sandbox), idempotently via lookup_key,
// and caches the resulting price id back onto the lookup row (classes /
// business_plans). A price change in the DB (e.g. Premium $200 → $100) is
// self-healing too: the cached price is re-verified against the row and a
// mismatched price is replaced (old one deactivated, lookup_key transferred).
// No dashboard step, and the secret never leaves the server.

import type Stripe from "npm:stripe@17";
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";

// Same version string prod has always passed. The cast keeps `deno check`
// happy when the locally-cached stripe@17 minor pins an older literal.
export const STRIPE_API_VERSION =
  "2025-03-31.basil" as Stripe.LatestApiVersion;

export type PlanCatalogEntry = {
  // Stable Mesita-wide id, stored in Stripe metadata.mesita_plan.
  id: "consumer_premium" | "business_pro" | "business_ultra";
  // Lookup row backing this price.
  table: "classes" | "business_plans";
  rowKey: string;
  // Stripe price lookup_key — the idempotency anchor.
  lookupKey: string;
  productName: string;
  productDescription: string;
};

export const STRIPE_CATALOG: PlanCatalogEntry[] = [
  {
    id: "consumer_premium",
    table: "classes",
    rowKey: "premium",
    lookupKey: "consumer_premium_monthly",
    productName: "Mesita Premium",
    productDescription:
      "Mesita consumer Premium plan — monthly subscription.",
  },
  {
    id: "business_pro",
    table: "business_plans",
    rowKey: "pro",
    lookupKey: "business_pro_monthly",
    productName: "Mesita Pro",
    productDescription:
      "Mesita business Pro plan — medium visibility. Monthly subscription.",
  },
  {
    id: "business_ultra",
    table: "business_plans",
    rowKey: "ultra",
    lookupKey: "business_ultra_monthly",
    productName: "Mesita Ultra",
    productDescription:
      "Mesita business Ultra plan — max visibility. Monthly subscription.",
  },
];

export type ResolvedPrice = {
  priceId: string;
  priceCents: number;
  currency: string; // uppercase ISO 4217, e.g. "MXN"
};

type PlanRow = {
  price_cents: number;
  currency: string;
  stripe_price_id: string | null;
};

// True when `price` is exactly the live monthly price the row asks for.
function priceMatchesRow(price: Stripe.Price, row: PlanRow): boolean {
  return (
    price.active &&
    price.unit_amount === row.price_cents &&
    price.currency.toLowerCase() === row.currency.toLowerCase() &&
    price.recurring?.interval === "month"
  );
}

// Resolves (provisioning if needed) the Stripe price for a catalog entry.
// Reads the authoritative amount from the lookup row, verifies the cached
// stripe_price_id against it, and creates/repairs the Stripe side when they
// disagree. Returns null when the lookup row itself is missing.
export async function resolvePlanPrice(
  admin: SupabaseClient,
  stripe: Stripe,
  entryId: PlanCatalogEntry["id"],
): Promise<ResolvedPrice | null> {
  const entry = STRIPE_CATALOG.find((e) => e.id === entryId);
  if (!entry) return null;

  const { data: row } = await admin
    .from(entry.table)
    .select("price_cents, currency, stripe_price_id")
    .eq("key", entry.rowKey)
    .maybeSingle();
  if (!row) return null;
  const planRow = row as PlanRow;

  // Fast path: the cached price still matches the row.
  if (planRow.stripe_price_id) {
    try {
      const cached = await stripe.prices.retrieve(planRow.stripe_price_id);
      if (priceMatchesRow(cached, planRow)) {
        return {
          priceId: cached.id,
          priceCents: planRow.price_cents,
          currency: planRow.currency.toUpperCase(),
        };
      }
    } catch {
      // Cached id doesn't exist in this Stripe account (key rotated to a
      // different account/sandbox, or the price was deleted) — re-provision.
    }
  }

  // Second chance: a price already carries our lookup_key (e.g. provisioned
  // by a parallel request or an earlier deploy).
  let staleByLookup: Stripe.Price | null = null;
  try {
    const byLookup = await stripe.prices.list({
      lookup_keys: [entry.lookupKey],
      limit: 1,
    });
    const found = byLookup.data[0] ?? null;
    if (found && priceMatchesRow(found, planRow)) {
      await cachePriceId(admin, entry, found.id);
      return {
        priceId: found.id,
        priceCents: planRow.price_cents,
        currency: planRow.currency.toUpperCase(),
      };
    }
    staleByLookup = found;
  } catch {
    /* listing failed — fall through to provisioning */
  }

  // Provision. Reuse the product behind the stale price when there is one so
  // a price change doesn't spawn twin products; otherwise find the product by
  // metadata, and only then create it.
  let productId: string | null = staleByLookup
    ? typeof staleByLookup.product === "string"
      ? staleByLookup.product
      : staleByLookup.product.id
    : null;

  if (!productId) {
    try {
      const found = await stripe.products.search({
        query: `metadata['mesita_plan']:'${entry.id}' AND active:'true'`,
      });
      productId = found.data[0]?.id ?? null;
    } catch {
      /* search unsupported or failed — create below */
    }
  }

  if (!productId) {
    const product = await stripe.products.create({
      name: entry.productName,
      description: entry.productDescription,
      metadata: { mesita_plan: entry.id },
    });
    productId = product.id;
  }

  const price = await stripe.prices.create({
    product: productId,
    unit_amount: planRow.price_cents,
    currency: planRow.currency.toLowerCase(),
    recurring: { interval: "month" },
    lookup_key: entry.lookupKey,
    transfer_lookup_key: true,
    metadata: { mesita_plan: entry.id },
  });

  // Retire the superseded price so new checkouts can't pick it up, and point
  // the product's default at the fresh one.
  if (staleByLookup && staleByLookup.active && staleByLookup.id !== price.id) {
    try {
      await stripe.prices.update(staleByLookup.id, { active: false });
    } catch {
      /* non-fatal */
    }
  }
  try {
    await stripe.products.update(productId, { default_price: price.id });
  } catch {
    /* non-fatal */
  }

  await cachePriceId(admin, entry, price.id);
  return {
    priceId: price.id,
    priceCents: planRow.price_cents,
    currency: planRow.currency.toUpperCase(),
  };
}

async function cachePriceId(
  admin: SupabaseClient,
  entry: PlanCatalogEntry,
  priceId: string,
): Promise<void> {
  await admin
    .from(entry.table)
    .update({ stripe_price_id: priceId })
    .eq("key", entry.rowKey);
}

// Ensures the WHOLE catalog exists in Stripe, not just the plan being bought.
// Called fire-and-forget from checkout EFs so a single first checkout
// materializes all three products for review in the dashboard. Errors are
// swallowed — the purchase path only depends on its own resolvePlanPrice.
export async function ensureWholeCatalog(
  admin: SupabaseClient,
  stripe: Stripe,
): Promise<void> {
  for (const entry of STRIPE_CATALOG) {
    try {
      await resolvePlanPrice(admin, stripe, entry.id);
    } catch {
      /* best effort */
    }
  }
}
