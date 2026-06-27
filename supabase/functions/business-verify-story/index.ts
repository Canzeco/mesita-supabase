// Supabase Edge Function — business-verify-story
//
// Authenticated. The staff member (or AI-fallback escalation) approves or
// rejects a consumer's Instagram story for a discount-with-story ticket
// (s_dp_sf, r_s_dp_sf). The discount was already applied at the bill, so this
// only records the verification outcome — there is no money to credit or claw
// back. Reject is informational only.
//
// Self-contained: own auth, own DB writes, no function-to-function calls.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { STORY_KINDS } from "../_shared/ticket-kinds.ts";

type Body = {
  ticketId?: string;
  decision?: "approve" | "reject";
  reason?: string;
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
  const userId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const ticketId = (body.ticketId ?? "").toString().trim();
  if (!ticketId) return json({ ok: false, error: "ticketId is required" }, 400);
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return json(
      { ok: false, error: "decision must be 'approve' or 'reject'" },
      400,
    );
  }
  const reason = (body.reason ?? "").toString().trim().slice(0, 240) || null;

  const admin = adminClient(envRes.env);

  const ticketRow = await admin
    .from("tickets")
    .select("id, project_id, consumer_id, kind, status, story_status, total_cents")
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

  if (!STORY_KINDS.has(ticket.kind)) {
    return json(
      {
        ok: false,
        error: `Ticket kind ${ticket.kind} has no story step to verify.`,
      },
      409,
    );
  }

  // Membership: the staff member who verifies must belong to the ticket's place
  // (super-admins bypass — same rule as every other Team-surface EF).
  const memberRes = await requireMembership(admin, authRes.user, ticket.project_id);
  if (!memberRes.ok) return memberRes.response;

  // Idempotency: once we've moved to a terminal verified/rejected state we
  // don't re-process. Re-submission returns the row.
  if (
    ticket.story_status === "waiter_verified" ||
    ticket.story_status === "waiter_rejected"
  ) {
    return json({ ok: true, ticket, alreadyDecided: true });
  }

  const verifiedAt = new Date().toISOString();
  const nextStoryStatus = decision === "approve"
    ? "waiter_verified"
    : "waiter_rejected";

  // Approving the story advances Type B to the staff payment-confirm gate
  // (only if it's been billed). The ticket still closes later when staff tap
  // Paid received. Reject is informational only.
  const billed = (ticket.total_cents ?? 0) > 0;
  const nextStatus =
    decision === "approve" && billed && ticket.status === "awaiting_story"
      ? "awaiting_payment_confirm"
      : ticket.status;

  const updated = await admin
    .from("tickets")
    .update({
      story_status: nextStoryStatus,
      status: nextStatus,
      story_verified_at: verifiedAt,
      story_verified_by: userId,
      story_reject_reason: decision === "reject" ? reason : null,
    })
    .eq("id", ticketId)
    .select(
      "id, kind, status, story_status, story_verified_at, story_reject_reason",
    )
    .single();
  if (updated.error) {
    return json(
      { ok: false, error: `ticket_update: ${updated.error.message}` },
      500,
    );
  }

  return json({ ok: true, ticket: updated.data });
});
