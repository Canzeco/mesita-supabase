// Supabase Edge Function — consumer-mcp
//
// Streamable HTTP MCP endpoint for the Consumer MCP. Authenticated with a
// personal access token (mesita_mcp_…), NOT a Supabase JWT — so Claude /
// ChatGPT / Cursor can control the signed-in consumer's Mesita profile.
//
// Protocol: JSON-RPC 2.0 over POST (initialize, tools/list, tools/call,
// notifications/initialized). Stateless sessions (Mcp-Session-Id echoed
// for clients that require it; no server-side session store).
//
// Tools wrap the same DB work as consumer-web-* EFs (service role, scoped
// to the token's consumer_id) — no EF→EF hop.
//
// verify_jwt = false in config.toml (custom bearer).
// Deploy: supabase functions deploy consumer-mcp

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json } from "../_shared/http.ts";
import { adminClient, readEFEnv } from "../_shared/auth.ts";
import { resolveMcpBearer } from "../_shared/mcp-tokens.ts";
import { PLACE_PUBLIC_COLUMNS } from "../_shared/place-columns.ts";
import { getTierConfig } from "../_shared/membership.ts";
import { suggestPlaces } from "../_shared/suggest-places.ts";
import { CORS } from "../_shared/cors.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const PROTOCOL_VERSION = "2025-03-26";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JsonRpcId = string | number | null;
type JsonRpcReq = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
};

type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: "get_profile",
    description:
      "Get the connected Mesita consumer profile: name, class (Free/Premium), reservation usage, Instagram handle.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_saved_places",
    description: "List places the consumer has saved (favorites).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "save_place",
    description:
      "Save or unsave a place. Saving a Verified Partner also issues a reward coupon when eligible.",
    inputSchema: {
      type: "object",
      properties: {
        place_id: { type: "string", description: "Place UUID" },
        saved: { type: "boolean" },
      },
      required: ["place_id", "saved"],
      additionalProperties: false,
    },
  },
  {
    name: "suggest_places",
    description:
      "Search Mesita + Google for places by name or vibe query (autocomplete-style).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_place",
    description: "Get a single place profile by id (UUID) or slug.",
    inputSchema: {
      type: "object",
      properties: {
        id_or_slug: { type: "string" },
      },
      required: ["id_or_slug"],
      additionalProperties: false,
    },
  },
  {
    name: "list_reservations",
    description: "List the consumer's reservations (upcoming, past, or all).",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["upcoming", "past", "all"] },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_reservation",
    description:
      "Book a table at a place. Requires place_id, ISO reserved_at, and party_size.",
    inputSchema: {
      type: "object",
      properties: {
        place_id: { type: "string" },
        reserved_at: {
          type: "string",
          description: "ISO 8601 datetime for the reservation",
        },
        party_size: { type: "number", minimum: 1, maximum: 50 },
        notes: { type: "string" },
      },
      required: ["place_id", "reserved_at", "party_size"],
      additionalProperties: false,
    },
  },
  {
    name: "list_rewards",
    description:
      "List active reward coupons (at-the-bill discounts) in the consumer wallet.",
    inputSchema: {
      type: "object",
      properties: {
        include_inactive: { type: "boolean" },
        limit: { type: "number", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
];

function rpcResult(id: JsonRpcId, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
    },
  });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  status = 200,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }),
    {
      status,
      headers: {
        ...CORS,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
      },
    },
  );
}

function toolText(payload: unknown): { content: { type: "text"; text: string }[]; isError?: boolean } {
  const text =
    typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }] };
}

function toolError(message: string) {
  return { ...toolText({ ok: false, error: message }), isError: true };
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  admin: SupabaseClient,
  consumerId: string,
  env: { url: string; anonKey: string; serviceKey: string },
): Promise<ReturnType<typeof toolText>> {
  switch (name) {
    case "get_profile": {
      const { data: consumer, error } = await admin
        .from("consumers")
        .select(
          "id, code, full_name, first_name, last_name, phone, instagram_handle, class_key, class_origin, consumer_instagram_followers_count, class_expires_at",
        )
        .eq("id", consumerId)
        .maybeSingle();
      if (error) return toolError(error.message);
      if (!consumer) return toolError("Consumer profile not found");
      const classKey = consumer.class_key ?? "free";
      let tier = null;
      try {
        tier = await getTierConfig(admin, classKey);
      } catch {
        tier = null;
      }
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const { count } = await admin
        .from("reservations")
        .select("id", { count: "exact", head: true })
        .eq("consumer_id", consumerId)
        .gte("created_at", monthStart.toISOString())
        .neq("status", "cancelled");
      return toolText({
        ok: true,
        consumer,
        class: {
          key: classKey,
          origin: consumer.class_origin ?? "default",
          label: tier?.label ?? "Free",
          followers: consumer.consumer_instagram_followers_count ?? null,
          expires_at: consumer.class_expires_at ?? null,
          usage: {
            reservations_used: count ?? 0,
            reservations_limit: tier?.monthly_reservation_limit ?? null,
          },
        },
      });
    }

    case "list_saved_places": {
      const limit = clamp(args.limit, 1, 100, 50);
      const { data, error } = await admin
        .from("saved_places")
        .select(
          "id, created_at, place:places(id, slug, name, category, price_level, listing_type, photos, address, lat, lng)",
        )
        .eq("consumer_id", consumerId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return toolError(error.message);
      return toolText({ ok: true, saved_places: data ?? [] });
    }

    case "save_place": {
      const placeId = String(args.place_id ?? "");
      const saved = args.saved === true;
      if (!UUID_RE.test(placeId)) return toolError("place_id must be a UUID");
      if (typeof args.saved !== "boolean") return toolError("saved (boolean) required");

      if (saved) {
        const { data: row, error } = await admin
          .from("saved_places")
          .upsert(
            { consumer_id: consumerId, project_id: placeId },
            { onConflict: "consumer_id,project_id" },
          )
          .select("id, project_id, created_at")
          .single();
        if (error) return toolError(error.message);
        const { data: coupon } = await admin
          .from("coupons")
          .select(
            "id, project_id, status, issued_at, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, cap_cents, currency, expires_at",
          )
          .eq("consumer_id", consumerId)
          .eq("project_id", placeId)
          .eq("status", "active")
          .maybeSingle();
        return toolText({ ok: true, saved_place: row, coupon });
      }

      const { error } = await admin
        .from("saved_places")
        .delete()
        .eq("consumer_id", consumerId)
        .eq("project_id", placeId);
      if (error) return toolError(error.message);
      return toolText({ ok: true, saved: false });
    }

    case "suggest_places": {
      const query = String(args.query ?? "").trim();
      if (!query) return toolError("query required");
      // Google Autocomplete requires a session token; mint one per tool call.
      const sessionToken = crypto.randomUUID();
      const res = await suggestPlaces(env, "consumer-mcp", {
        input: query,
        sessionToken,
        callerUserId: consumerId,
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        return toolError(
          (body as { error?: string } | null)?.error ??
            `suggest failed (${res.status})`,
        );
      }
      return toolText(body);
    }

    case "get_place": {
      const idOrSlug = String(args.id_or_slug ?? "").trim();
      if (!idOrSlug) return toolError("id_or_slug required");
      const column = UUID_RE.test(idOrSlug) ? "id" : "slug";
      const { data, error } = await admin
        .from("projects_view")
        .select(PLACE_PUBLIC_COLUMNS)
        .eq(column, idOrSlug)
        .maybeSingle();
      if (error) return toolError(error.message);
      if (!data) return toolError("Place not found");
      return toolText({ ok: true, place: data });
    }

    case "list_reservations": {
      const limit = clamp(args.limit, 1, 100, 50);
      const scope =
        args.scope === "past" || args.scope === "all" ? args.scope : "upcoming";
      let q = admin
        .from("reservations")
        .select(
          "id, reserved_at, party_size, status, notes, confirmed_at, completed_at, cancelled_at, coupon_id, created_at, place:places(id, slug, name, category, photos, address)",
        )
        .eq("consumer_id", consumerId)
        .order("reserved_at", { ascending: scope === "past" ? false : true })
        .limit(limit);
      if (scope === "upcoming") q = q.in("status", ["pending", "confirmed"]);
      else if (scope === "past") {
        q = q.in("status", ["declined", "no_show", "cancelled"]);
      }
      const { data, error } = await q;
      if (error) return toolError(error.message);
      return toolText({ ok: true, reservations: data ?? [] });
    }

    case "create_reservation": {
      const placeId = String(args.place_id ?? "");
      const reservedAtRaw = String(args.reserved_at ?? "");
      const partySize = Math.trunc(Number(args.party_size));
      const notes =
        typeof args.notes === "string" ? args.notes.trim() || null : null;
      if (!UUID_RE.test(placeId)) return toolError("place_id must be a UUID");
      const reservedAt = new Date(reservedAtRaw);
      if (Number.isNaN(reservedAt.getTime())) {
        return toolError("reserved_at must be a valid ISO 8601 timestamp");
      }
      if (!Number.isFinite(partySize) || partySize < 1 || partySize > 50) {
        return toolError("party_size must be 1..50");
      }

      const { data: consumerRow } = await admin
        .from("consumers")
        .select("class_key")
        .eq("id", consumerId)
        .maybeSingle();
      const classKey = consumerRow?.class_key ?? "free";
      let tier = null;
      try {
        tier = await getTierConfig(admin, classKey);
      } catch {
        tier = null;
      }
      const monthlyLimit = tier?.monthly_reservation_limit ?? null;
      if (monthlyLimit != null) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const { count, error: countErr } = await admin
          .from("reservations")
          .select("id", { count: "exact", head: true })
          .eq("consumer_id", consumerId)
          .gte("created_at", monthStart.toISOString())
          .neq("status", "cancelled");
        if (countErr) return toolError(countErr.message);
        if ((count ?? 0) >= monthlyLimit) {
          return toolError(
            "Monthly reservation limit reached. Upgrade to Mesita Premium for unlimited reservations.",
          );
        }
      }

      const { data: coupon } = await admin
        .from("coupons")
        .select("id")
        .eq("consumer_id", consumerId)
        .eq("project_id", placeId)
        .eq("status", "active")
        .maybeSingle();

      const { data: reservation, error } = await admin
        .from("reservations")
        .insert({
          consumer_id: consumerId,
          project_id: placeId,
          coupon_id: coupon?.id ?? null,
          reserved_at: reservedAt.toISOString(),
          party_size: partySize,
          notes,
          status: "pending",
        })
        .select(
          "id, reserved_at, party_size, status, notes, coupon_id, created_at, place:places(id, slug, name, category, photos, address)",
        )
        .single();
      if (error) return toolError(error.message);
      return toolText({
        ok: true,
        reservation,
        linked_coupon_id: coupon?.id ?? null,
      });
    }

    case "list_rewards": {
      const limit = clamp(args.limit, 1, 100, 50);
      const includeInactive = args.include_inactive === true;
      let q = admin
        .from("coupons")
        .select(
          "id, status, issued_at, redeemed_at, cancelled_at, expires_at, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, cap_cents, currency, place:places(id, slug, name, category, photos, address)",
        )
        .eq("consumer_id", consumerId)
        .order("issued_at", { ascending: false })
        .limit(limit);
      if (!includeInactive) q = q.eq("status", "active");
      const { data, error } = await q;
      if (error) return toolError(error.message);
      return toolText({ ok: true, coupons: data ?? [] });
    }

    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function clamp(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();

  // GET → tiny discovery doc (not part of MCP handshake; helps humans).
  if (req.method === "GET") {
    return json({
      ok: true,
      name: "mesita-consumer",
      title: "Mesita Consumer MCP",
      protocolVersion: PROTOCOL_VERSION,
      transport: "streamable-http",
      auth: "Authorization: Bearer mesita_mcp_… (mint from Me → AI in the app)",
      tools: TOOLS.map((t) => t.name),
    });
  }

  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const admin = adminClient(envRes.env);

  const auth = await resolveMcpBearer(req, admin);
  if (!auth.ok) return auth.response;
  const consumerId = auth.token.consumer_id;

  let body: JsonRpcReq;
  try {
    body = (await req.json()) as JsonRpcReq;
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }

  const id = body.id ?? null;
  const method = body.method ?? "";

  // Notifications have no id and expect 202/empty — return 204.
  if (method.startsWith("notifications/")) {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (method === "initialize") {
    const sessionId = crypto.randomUUID();
    const res = rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: {
        name: "mesita-consumer",
        version: "0.1.0",
        title: "Mesita Consumer",
      },
      instructions:
        "You are connected to a Mesita consumer account. Use tools to look up the profile, find/save places, book reservations, and check reward coupons. Prefer Verified Partners (listing_type=partner) when recommending places with rewards.",
    });
    res.headers.set("Mcp-Session-Id", sessionId);
    return res;
  }

  if (method === "ping") {
    return rpcResult(id, {});
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const params = body.params ?? {};
    const name = String(params.name ?? "");
    const args =
      params.arguments && typeof params.arguments === "object"
        ? (params.arguments as Record<string, unknown>)
        : {};
    if (!name) return rpcError(id, -32602, "tools/call requires params.name");
    try {
      const result = await runTool(name, args, admin, consumerId, envRes.env);
      return rpcResult(id, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Tool failed";
      return rpcResult(id, toolError(msg));
    }
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
});
