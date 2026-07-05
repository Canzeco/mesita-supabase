// Supabase Edge Function — consumer-web-get-profile
//
// Authenticated. Returns the caller's consumer profile, creating it on first
// call (with sequential 8-digit `code` 0000-0000 for validators / WhatsApp)
// and returning the consumer profile.
//
// Self-contained: verifies the JWT, does its own DB read/upsert through the
// service role, never calls another Edge Function.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { getTierConfig } from "../_shared/membership.ts";
import { isCanonicalConsumerCode } from "../_shared/consumer-code.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;
  const userId = authRes.user.id;

  const admin = adminClient(envRes.env);

  // Read once. If absent, insert with a generated code and re-read.
  const existing = await admin
    .from("consumers")
    .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, instagram_handle, profile_public, profile_show_saves, profile_show_visits, class_key, class_origin, consumer_instagram_followers_count, class_expires_at")
    .eq("id", userId)
    .maybeSingle();
  if (existing.error) {
    return json({ ok: false, error: `consumer_read: ${existing.error.message}` }, 500);
  }

  let consumer = existing.data;
  if (!consumer) {
    // Generate a code by calling the SQL helper (race-safe via unique
    // constraint; we retry once on conflict).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const codeResult = await admin.rpc("generate_consumer_code");
      if (codeResult.error) {
        return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
      }
      const inserted = await admin
        .from("consumers")
        .insert({ id: userId, code: codeResult.data as string })
        .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, instagram_handle, profile_public, profile_show_saves, profile_show_visits, class_key, class_origin, consumer_instagram_followers_count, class_expires_at")
        .single();
      if (!inserted.error) {
        consumer = inserted.data;
        break;
      }
      // Unique-violation on code → retry. Anything else: bail out.
      if (inserted.error.code !== "23505") {
        return json({ ok: false, error: `consumer_create: ${inserted.error.message}` }, 500);
      }
    }
    if (!consumer) {
      return json({ ok: false, error: "Could not assign a unique code" }, 500);
    }
  } else if (!consumer.code || !isCanonicalConsumerCode(consumer.code)) {
    // Missing or legacy alphanumeric code → allocate next sequential 8-digit code.
    const codeResult = await admin.rpc("generate_consumer_code");
    if (codeResult.error) {
      return json({ ok: false, error: `code_gen: ${codeResult.error.message}` }, 500);
    }
    const updated = await admin
      .from("consumers")
      .update({ code: codeResult.data as string })
      .eq("id", userId)
      .select("id, code, full_name, first_name, last_name, sex, birthday, country, phone, instagram_handle, profile_public, profile_show_saves, profile_show_visits, class_key, class_origin, consumer_instagram_followers_count, class_expires_at")
      .single();
    if (updated.error) {
      return json({ ok: false, error: `consumer_code_set: ${updated.error.message}` }, 500);
    }
    consumer = updated.data;
  }

  // ── Membership payload ─────────────────────────────────────────────────
  // Surfaces the consumer's class, how they earned it, their Instagram
  // follower count, current subscription (if any), and this month's
  // reservation usage vs their cap. The UI uses this to render the Class tab
  // and gate the "upgrade" affordances.
  //
  // Everything below is best-effort: a missing `classes` row, a transient
  // lookup failure, or a stray duplicate subscription row must degrade to
  // sensible free-class defaults, never surface as a 500 on the user-facing
  // Profile tab. `getTierConfig` already returns null for an unknown
  // class_key; we additionally guard the await so a transient throw can't
  // take the whole response down.
  const classKey = consumer.class_key ?? "free";
  let tier = null;
  try {
    tier = await getTierConfig(admin, classKey);
  } catch (_err) {
    tier = null; // fall through to Free defaults below
  }

  // A consumer should have at most one active/past_due subscription, but a
  // stray duplicate row must not 500 the profile — take the most recent via
  // limit(1) instead of .maybeSingle() (which throws on >1 matching row).
  const { data: subscriptionRows } = await admin
    .from("consumer_subscriptions")
    .select(
      "status, price_cents, currency, current_period_end, cancel_at_period_end",
    )
    .eq("consumer_id", userId)
    .in("status", ["active", "past_due"])
    .order("current_period_end", { ascending: false })
    .limit(1);
  const subscription = subscriptionRows?.[0] ?? null;

  let used = 0;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("reservations")
    .select("id", { count: "exact", head: true })
    .eq("consumer_id", userId)
    .gte("created_at", monthStart.toISOString())
    .neq("status", "cancelled");
  used = count ?? 0;

  const subscriptionClass = {
    key: consumer.class_key ?? "free",
    origin: consumer.class_origin ?? "default",
    label: tier?.label ?? "Free",
    followers: consumer.consumer_instagram_followers_count ?? null,
    expires_at: consumer.class_expires_at ?? null,
    subscription: subscription ?? null,
    usage: {
      reservations_used: used,
      reservations_limit: tier?.monthly_reservation_limit ?? null,
    },
  };

  return json({ ok: true, consumer, class: subscriptionClass });
});
