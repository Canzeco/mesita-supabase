// Supabase Edge Function — consumer-mock-story-detect
//
// Dev/demo helper: simulates the IG bot detecting a tagged story and sets
// story_status to ai_verified. Not for production UX — local/staging testing only.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { STORY_KINDS } from "../_shared/ticket-kinds.ts";
import { closeTicketAndEnqueueReview } from "../_shared/ticket-informal.ts";

type Body = { ticketId?: string };

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
  const ticketId = (bodyRes.body.ticketId ?? "").trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select("id, consumer_id, venue_id, kind, story_status, total_cents")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketRow.error) {
    return json(
      { ok: false, error: `ticket_lookup: ${ticketRow.error.message}` },
      500,
    );
  }
  if (!ticketRow.data) return json({ ok: false, error: "Ticket not found" }, 404);
  const ticket = ticketRow.data;

  if (ticket.consumer_id !== userId) {
    return json({ ok: false, error: "Forbidden" }, 403);
  }
  if (!STORY_KINDS.has(ticket.kind)) {
    return json(
      { ok: false, error: "This ticket does not require a story." },
      409,
    );
  }

  if (
    ticket.story_status === "ai_verified" ||
    ticket.story_status === "waiter_verified"
  ) {
    return json({ ok: true, ticket, alreadyVerified: true });
  }

  const allowed = new Set(["pending", "submitted", "ai_rejected"]);
  if (!allowed.has(ticket.story_status)) {
    return json(
      {
        ok: false,
        error: `Cannot mock-detect story when story_status=${ticket.story_status}`,
      },
      409,
    );
  }

  const now = new Date().toISOString();
  const updated = await admin
    .from("tickets")
    .update({
      story_status: "ai_verified",
      story_submitted_at: now,
      story_verified_at: now,
      story_reject_reason: null,
    })
    .eq("id", ticketId)
    .select("id, kind, status, story_status, story_submitted_at, story_verified_at")
    .single();
  if (updated.error) {
    return json(
      { ok: false, error: `story_mock: ${updated.error.message}` },
      500,
    );
  }

  // Verifying the story closes the Type B ticket and queues the review.
  if ((ticket.total_cents ?? 0) > 0) {
    await closeTicketAndEnqueueReview(
      admin,
      ticketId,
      ticket.consumer_id,
      ticket.venue_id,
    );
  }

  return json({ ok: true, ticket: updated.data, mock: true });
});
