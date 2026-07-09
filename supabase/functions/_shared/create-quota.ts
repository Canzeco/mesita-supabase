// Per-consumer place-create quota (abuse guard for the consumer create EFs).
//
// The concurrency guards in create-place.ts only dedupe the SAME
// google_place_id; nothing bounded how many DIFFERENT places one consumer
// account could create. Each create burns a Google Basics call up front and
// seeds a full Enricher run (real Apify/Firecrawl/Perplexity/OpenAI budget),
// so an unbounded loop is a direct cost-amplification + catalog-spam vector.
//
// Model: rolling 24 h window over public.place_creation_attempts, counted
// per ATTEMPT (recorded before any Google spend). Insert-then-count makes
// parallel bursts self-limiting — each request in an N-wide burst sees the
// whole burst, so a deliberate parallel flood cannot slip past a
// check-then-insert window. A rejected attempt deletes its own row so a
// locked-out user's retries don't extend their lockout.
//
// Fail-closed: this guard protects real money — a ledger error rejects the
// create (the same DB being down would fail savePlaceData moments later
// anyway).
//
// Callers: consumer-web-create-place, consumer-web-schedule-project-creation
// (the compat alias — same privilege, must not be a bypass). Admin/business
// creates are intentionally NOT quota'd.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { json } from "./http.ts";

// Attempts per consumer per rolling 24 h. Generous for a real user (adds are
// occasional), tiny for a script. Dedupe-409 clicks count too — acceptable at
// this ceiling.
export const CONSUMER_CREATE_QUOTA = 20;

export async function consumeConsumerCreateQuota(
  admin: SupabaseClient,
  consumerId: string,
  googlePlaceId: string,
  caller: string,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const reject = (status: number, body: Record<string, unknown>) => ({
    ok: false as const,
    response: json({ ok: false, ...body }, status),
  });

  // 1) Record the attempt (before counting — see burst rationale above).
  const { data: attempt, error: insErr } = await admin
    .from("place_creation_attempts")
    .insert({ consumer_id: consumerId, google_place_id: googlePlaceId, caller })
    .select("id")
    .single();
  if (insErr || !attempt) {
    return reject(500, { error: `create_quota: ${insErr?.message ?? "no row"}` });
  }

  // 2) Count the rolling window, own attempt included.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: cntErr } = await admin
    .from("place_creation_attempts")
    .select("id", { count: "exact", head: true })
    .eq("consumer_id", consumerId)
    .gte("created_at", since);
  if (cntErr || count === null) {
    await admin.from("place_creation_attempts").delete().eq("id", attempt.id);
    return reject(500, { error: `create_quota: ${cntErr?.message ?? "no count"}` });
  }

  if (count > CONSUMER_CREATE_QUOTA) {
    // Withdraw the rejected attempt so retries don't extend the lockout.
    await admin.from("place_creation_attempts").delete().eq("id", attempt.id);
    return reject(429, {
      code: "create_quota_exceeded",
      error: "You've reached the daily limit for adding new places. Try again tomorrow.",
    });
  }

  return { ok: true };
}
