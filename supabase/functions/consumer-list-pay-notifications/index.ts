// Supabase Edge Function — consumer-list-pay-notifications
//
// Authenticated. Returns pay inbox notifications for the caller's consumer
// account, plus joined ticket metadata and place promo caps used by Pay →
// Tickets. Optional ticketId scopes to one ticket (detail route).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";

type Body = {
  ticketId?: string;
  limit?: number;
  pendingCountOnly?: boolean;
};

type TicketMeta = {
  kind?: string;
  status?: string;
  story_status?: string;
  story_submitted_at?: string | null;
  total_cents?: number | null;
  discount_percent?: number | null;
  capMxn?: number | null;
  created_at?: string | null;
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
  const consumerId = authRes.user.id;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;

  const admin = adminClient(envRes.env);

  if (body.pendingCountOnly) {
    const { count, error } = await admin
      .from("consumer_pay_notifications")
      .select("id", { count: "exact", head: true })
      .eq("consumer_id", consumerId)
      .eq("status", "pending");
    if (error) {
      return json({ ok: false, error: error.message }, 500);
    }
    return json({ ok: true, pendingCount: count ?? 0 });
  }

  const limit = typeof body.limit === "number" && body.limit > 0
    ? Math.min(body.limit, 100)
    : 100;

  let notifQuery = admin
    .from("consumer_pay_notifications")
    .select("*")
    .eq("consumer_id", consumerId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (typeof body.ticketId === "string" && body.ticketId.trim()) {
    notifQuery = notifQuery.eq("ticket_id", body.ticketId.trim());
  }

  const notifRes = await notifQuery;
  if (notifRes.error) {
    return json({ ok: false, error: notifRes.error.message }, 500);
  }
  const notifications = notifRes.data ?? [];

  const ticketIds = [
    ...new Set(notifications.map((n) => n.ticket_id).filter(Boolean)),
  ];

  const tickets: Record<string, TicketMeta> = {};
  let placeInstagramUrl: string | null = null;

  if (ticketIds.length > 0) {
    const ticketRes = await admin
      .from("tickets")
      .select(
        "id, kind, status, story_status, story_submitted_at, discount_percent, project_id, total_cents, created_at",
      )
      .in("id", ticketIds);

    if (ticketRes.error) {
      return json({ ok: false, error: ticketRes.error.message }, 500);
    }

    const placeIds = [
      ...new Set(
        (ticketRes.data ?? [])
          .map((t) => t.project_id)
          .filter((id): id is string => Boolean(id)),
      ),
    ];

    const placeCapById = new Map<string, number>();
    const placeInstagramById = new Map<string, string | null>();

    if (placeIds.length > 0) {
      const placeRes = await admin
        .from("places")
        .select("id, monthly_promo_cap, instagram_url")
        .in("id", placeIds);

      for (const place of placeRes.data ?? []) {
        if (place.monthly_promo_cap != null && place.monthly_promo_cap > 0) {
          placeCapById.set(place.id, place.monthly_promo_cap);
        }
        placeInstagramById.set(place.id, place.instagram_url ?? null);
      }
    }

    for (const t of ticketRes.data ?? []) {
      tickets[t.id] = {
        kind: t.kind,
        status: t.status,
        story_status: t.story_status,
        story_submitted_at: t.story_submitted_at,
        total_cents: t.total_cents,
        discount_percent: t.discount_percent,
        capMxn: t.project_id ? (placeCapById.get(t.project_id) ?? null) : null,
        created_at: t.created_at,
      };
    }

    if (typeof body.ticketId === "string" && body.ticketId.trim()) {
      const ticketRow = ticketRes.data?.find((t) => t.id === body.ticketId!.trim());
      if (ticketRow?.project_id) {
        placeInstagramUrl = placeInstagramById.get(ticketRow.project_id) ?? null;
      }
    }
  }

  return json({
    ok: true,
    notifications,
    tickets,
    placeInstagramUrl,
  });
});
