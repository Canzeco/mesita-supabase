// Unit tests for the shared Stripe billing catalog + price resolver
// (MESITA-142). Stripe and Supabase are fully MOCKED — no network, no live
// Stripe account is ever touched.
//   deno test supabase/functions/_shared/stripe-billing.test.ts
//
// resolvePlanPrice() is the self-provisioning price resolver. The contract we
// lock here:
//   • the catalog is the source of truth for the three-plan mapping
//     (consumer premium / business pro / business ultra), amounts read from DB;
//   • a cached stripe_price_id that still matches the DB row is a fast-path
//     hit — no product/price is created (idempotent);
//   • a missing lookup row yields null (no accidental provisioning);
//   • when nothing matches, exactly one product + one price are provisioned and
//     the new price id is cached back onto the row.

import { assert, assertEquals } from "jsr:@std/assert@1";
// deno-lint-ignore no-explicit-any
import type Stripe from "npm:stripe@17";
// deno-lint-ignore no-explicit-any
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { resolvePlanPrice, STRIPE_CATALOG } from "./stripe-billing.ts";

// ─── Catalog contract ────────────────────────────────────────────────────

Deno.test("STRIPE_CATALOG: the three Mesita plans map to their DB rows", () => {
  const byId = Object.fromEntries(STRIPE_CATALOG.map((e) => [e.id, e]));
  assertEquals(STRIPE_CATALOG.length, 3);

  assertEquals(byId["consumer_premium"].table, "classes");
  assertEquals(byId["consumer_premium"].rowKey, "premium");
  assertEquals(byId["consumer_premium"].lookupKey, "consumer_premium_monthly");

  assertEquals(byId["business_pro"].table, "business_plans");
  assertEquals(byId["business_pro"].rowKey, "pro");
  assertEquals(byId["business_pro"].lookupKey, "business_pro_monthly");

  assertEquals(byId["business_ultra"].table, "business_plans");
  assertEquals(byId["business_ultra"].rowKey, "ultra");
  assertEquals(byId["business_ultra"].lookupKey, "business_ultra_monthly");
});

Deno.test("STRIPE_CATALOG: lookup keys are unique (idempotency anchors)", () => {
  const keys = STRIPE_CATALOG.map((e) => e.lookupKey);
  assertEquals(new Set(keys).size, keys.length);
});

// ─── Fakes ──────────────────────────────────────────────────────────────

type PlanRow = {
  price_cents: number;
  currency: string;
  stripe_price_id: string | null;
};

// Minimal Supabase mock: one lookup row keyed by (table, key). Records the
// value written back by cachePriceId so tests can assert the cache.
function fakeAdmin(row: PlanRow | null): {
  admin: SupabaseClient;
  cached: { value: string | null };
} {
  const cached = { value: null as string | null };
  const builder = {
    _table: "",
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle() {
      return Promise.resolve({ data: row, error: null });
    },
    update(patch: Record<string, unknown>) {
      if ("stripe_price_id" in patch) {
        cached.value = patch.stripe_price_id as string;
      }
      return { eq: () => Promise.resolve({ data: null, error: null }) };
    },
  };
  const admin = {
    from(table: string) {
      builder._table = table;
      return builder;
    },
  } as unknown as SupabaseClient;
  return { admin, cached };
}

function makePrice(over: Partial<Stripe.Price> = {}): Stripe.Price {
  return {
    id: "price_cached",
    active: true,
    unit_amount: 10000,
    currency: "mxn",
    recurring: { interval: "month" },
    product: "prod_1",
    lookup_key: "consumer_premium_monthly",
    ...over,
  } as unknown as Stripe.Price;
}

// ─── resolvePlanPrice ─────────────────────────────────────────────────────

Deno.test("resolvePlanPrice: unknown entry id -> null", async () => {
  const { admin } = fakeAdmin(null);
  const stripe = {} as unknown as Stripe;
  // deno-lint-ignore no-explicit-any
  const res = await resolvePlanPrice(admin, stripe, "nope" as any);
  assertEquals(res, null);
});

Deno.test("resolvePlanPrice: missing lookup row -> null (no provisioning)", async () => {
  const { admin } = fakeAdmin(null);
  let created = false;
  const stripe = {
    prices: {
      retrieve: () => Promise.reject(new Error("should not be called")),
      create: () => {
        created = true;
        return Promise.resolve(makePrice());
      },
      list: () => Promise.resolve({ data: [] }),
    },
    products: { create: () => Promise.resolve({ id: "prod_x" }) },
  } as unknown as Stripe;

  const res = await resolvePlanPrice(admin, stripe, "consumer_premium");
  assertEquals(res, null);
  assert(!created, "no Stripe price should be created when the row is missing");
});

Deno.test("resolvePlanPrice: cached price matching the row is the fast path (idempotent)", async () => {
  const { admin, cached } = fakeAdmin({
    price_cents: 10000,
    currency: "MXN",
    stripe_price_id: "price_cached",
  });
  let createCalls = 0;
  const stripe = {
    prices: {
      retrieve: (id: string) => Promise.resolve(makePrice({ id })),
      create: () => {
        createCalls++;
        return Promise.resolve(makePrice());
      },
      list: () => Promise.resolve({ data: [] }),
    },
    products: {
      create: () => Promise.resolve({ id: "prod_new" }),
    },
  } as unknown as Stripe;

  const res = await resolvePlanPrice(admin, stripe, "consumer_premium");
  assert(res);
  assertEquals(res.priceId, "price_cached");
  assertEquals(res.priceCents, 10000);
  assertEquals(res.currency, "MXN"); // uppercased
  assertEquals(createCalls, 0, "fast path must not create anything");
  assertEquals(cached.value, null, "fast path must not re-cache");
});

Deno.test("resolvePlanPrice: no cache -> provisions product+price once and caches it", async () => {
  const { admin, cached } = fakeAdmin({
    price_cents: 10000,
    currency: "MXN",
    stripe_price_id: null,
  });
  let productCreates = 0;
  let priceCreates = 0;
  const stripe = {
    prices: {
      retrieve: () => Promise.reject(new Error("no cached id")),
      list: () => Promise.resolve({ data: [] }), // nothing carries our lookup_key yet
      create: () => {
        priceCreates++;
        return Promise.resolve(makePrice({ id: "price_new", product: "prod_new" }));
      },
      update: () => Promise.resolve({}),
    },
    products: {
      search: () => Promise.resolve({ data: [] }),
      create: () => {
        productCreates++;
        return Promise.resolve({ id: "prod_new" });
      },
      update: () => Promise.resolve({}),
    },
  } as unknown as Stripe;

  const res = await resolvePlanPrice(admin, stripe, "consumer_premium");
  assert(res);
  assertEquals(res.priceId, "price_new");
  assertEquals(productCreates, 1);
  assertEquals(priceCreates, 1);
  assertEquals(cached.value, "price_new", "the new price id is cached back on the row");
});

Deno.test("resolvePlanPrice: a stale cached id that mismatches the row re-provisions", async () => {
  // Row wants 5000¢ but the cached price is 10000¢ — must be replaced.
  const { admin, cached } = fakeAdmin({
    price_cents: 5000,
    currency: "MXN",
    stripe_price_id: "price_old",
  });
  let priceCreates = 0;
  const stripe = {
    prices: {
      retrieve: (id: string) => Promise.resolve(makePrice({ id, unit_amount: 10000 })),
      list: () => Promise.resolve({ data: [] }),
      create: () => {
        priceCreates++;
        return Promise.resolve(makePrice({ id: "price_fresh", unit_amount: 5000 }));
      },
      update: () => Promise.resolve({}),
    },
    products: {
      search: () => Promise.resolve({ data: [] }),
      create: () => Promise.resolve({ id: "prod_fresh" }),
      update: () => Promise.resolve({}),
    },
  } as unknown as Stripe;

  const res = await resolvePlanPrice(admin, stripe, "consumer_premium");
  assert(res);
  assertEquals(res.priceId, "price_fresh");
  assertEquals(res.priceCents, 5000);
  assertEquals(priceCreates, 1);
  assertEquals(cached.value, "price_fresh");
});
