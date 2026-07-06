// Contract smoke tests for the money-path Edge Functions (MESITA-142).
//
// These EFs move real money (Stripe subscriptions, ticket billing). We lock
// their REQUEST/RESPONSE CONTRACT at the gate: every one must
//   • answer the CORS preflight (OPTIONS -> 200),
//   • reject the wrong HTTP method (-> 405),
//   • reject an unauthenticated caller (-> 401)  [webhook: -> 400 no signature]
// before any DB / Stripe work happens.
//
// No port is bound, no DB is hit, no Stripe call is made: the harness
// intercepts Deno.serve to capture the real production handler and invokes it
// with crafted Requests. The dummy Supabase env only lets the guard chain
// advance past readEFEnv() to the auth check; a missing bearer short-circuits
// to 401 before any client is constructed.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  jsonRequest,
  loadEFHandler,
  readBody,
  setDummyEnv,
} from "./ef-test-harness.ts";

setDummyEnv();

// POST-only, JWT-gated EFs (the common shape). `accepts` lists the allowed
// methods so we can pick a disallowed one for the 405 probe.
const JWT_EFS: { name: string; path: string; accepts: string[] }[] = [
  { name: "business-web-create-ticket", path: "../business-web-create-ticket/index.ts", accepts: ["POST"] },
  { name: "business-web-submit-ticket-bill", path: "../business-web-submit-ticket-bill/index.ts", accepts: ["POST"] },
  { name: "business-web-mark-ticket-paid", path: "../business-web-mark-ticket-paid/index.ts", accepts: ["POST"] },
  { name: "business-web-cancel-ticket", path: "../business-web-cancel-ticket/index.ts", accepts: ["POST"] },
  { name: "business-web-list-tickets", path: "../business-web-list-tickets/index.ts", accepts: ["POST"] },
  { name: "business-web-change-subscription", path: "../business-web-change-subscription/index.ts", accepts: ["POST"] },
  { name: "consumer-web-create-subscription", path: "../consumer-web-create-subscription/index.ts", accepts: ["POST"] },
  { name: "consumer-web-submit-ticket-review", path: "../consumer-web-submit-ticket-review/index.ts", accepts: ["POST"] },
  { name: "consumer-web-list-pay-notifications", path: "../consumer-web-list-pay-notifications/index.ts", accepts: ["POST"] },
  { name: "consumer-web-list-tickets", path: "../consumer-web-list-tickets/index.ts", accepts: ["GET", "POST"] },
];

for (const ef of JWT_EFS) {
  Deno.test(`${ef.name}: OPTIONS preflight -> 200 with CORS`, async () => {
    const h = await loadEFHandler(ef.path);
    const res = await h(new Request("http://ef.local/", { method: "OPTIONS" }));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    await res.body?.cancel();
  });

  Deno.test(`${ef.name}: disallowed method -> 405`, async () => {
    const h = await loadEFHandler(ef.path);
    // DELETE is never accepted by any of these handlers.
    const res = await h(new Request("http://ef.local/", { method: "DELETE" }));
    assertEquals(res.status, 405);
    await res.body?.cancel();
  });

  Deno.test(`${ef.name}: no auth -> 401 (before any DB/Stripe work)`, async () => {
    const h = await loadEFHandler(ef.path);
    const method = ef.accepts.includes("POST") ? "POST" : "GET";
    const res = await h(jsonRequest({}, { method, bearer: null }));
    assertEquals(res.status, 401, `${ef.name} must 401 an unauthenticated caller`);
    const body = await readBody(res);
    assert(
      typeof body === "object" && body !== null && (body as { ok?: boolean }).ok === false,
      `${ef.name} 401 body should be { ok:false, ... }`,
    );
  });

  Deno.test(`${ef.name}: malformed bearer -> 401`, async () => {
    const h = await loadEFHandler(ef.path);
    const method = ef.accepts.includes("POST") ? "POST" : "GET";
    const res = await h(
      jsonRequest({}, { method, headers: { Authorization: "NotBearer xyz" } }),
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  });
}

// ─── Stripe webhook: signature-gated, not JWT-gated ───────────────────────
// verify_jwt is disabled at the gateway; security rests on the Stripe
// signature. Contract: POST-only (plain-text 405), and a POST with no
// stripe-signature header is a 400 before any event is processed.

Deno.test("stripe-webhook-handle-event: non-POST -> 405", async () => {
  setDummyEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" });
  const h = await loadEFHandler("../stripe-webhook-handle-event/index.ts");
  const res = await h(new Request("http://ef.local/", { method: "GET" }));
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

Deno.test("stripe-webhook-handle-event: POST without stripe-signature -> 400", async () => {
  setDummyEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" });
  const h = await loadEFHandler("../stripe-webhook-handle-event/index.ts");
  const res = await h(
    new Request("http://ef.local/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assertEquals(res.status, 400);
  const text = await res.text();
  assert(/signature/i.test(text), "400 should mention the missing signature");
});

Deno.test("stripe-webhook-handle-event: a bogus signature fails verification -> 400", async () => {
  setDummyEnv({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" });
  const h = await loadEFHandler("../stripe-webhook-handle-event/index.ts");
  const res = await h(
    new Request("http://ef.local/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "stripe-signature": "t=1,v1=deadbeef",
      },
      body: JSON.stringify({ id: "evt_1", type: "checkout.session.completed" }),
    }),
  );
  assertEquals(res.status, 400);
  await res.body?.cancel();
});
