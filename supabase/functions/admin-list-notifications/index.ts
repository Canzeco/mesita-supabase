// Supabase Edge Function — admin-list-notifications (admin caller)
//
// Powers admin.mesita.ai/global-performance → Notifications view. The
// console is intentionally NOT realtime: the operator pulls a fresh feed
// with the Refresh button, and this EF recomputes the feed from source
// tables on every call.
//
// v1 ships a single category — **atlas** — with three event types, all
// *derived* (there is no dedicated events/notifications table; we read the
// timestamps the product already writes):
//
//   atlas.venue_created      a new row in public.venues
//   atlas.venue_enriched     a venue whose Atlas profile pass completed
//                            (enriched_at stamped) — carries the textual
//                            summary the enricher synthesised
//   atlas.ownership_claimed  someone submitted an ownership proof
//                            (public.venue_verifications) for a place
//
// The envelope is category-agnostic so future categories (billing,
// verifications, consumers…) slot in without a client rewrite: each item
// is { id, category, type, occurredAt, venue, actor, detail, meta } and the
// client renders title/icon from `type`.
//
// "Who called it" for a creation: venues don't persist the caller at insert
// time (business-create-unit deliberately leaves the venue unowned until an
// ownership claim is approved), so the closest honest signal is the venue's
// current owner — resolved here via venue_members(role=owner) → businesses.
// Unclaimed venues report actor = null and meta.claimed = false. The exact
// claimant, when it exists, is its own ownership_claimed event.
//
// Auth: caller's JWT email must be in public.super_admins.
//
// Deploy: supabase functions deploy admin-list-notifications

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { clampIntRange, corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Category = "atlas";

type NotificationType =
  | "atlas.venue_created"
  | "atlas.venue_enriched"
  | "atlas.ownership_claimed";

type Body = {
  // "all" (or omitted) returns every category. A specific category narrows
  // the feed server-side.
  category?: Category | "all" | null;
  limit?: number;
};

type VenueRef = {
  id: string;
  slug: string | null;
  name: string;
  address: string | null;
  categoryLabel: string | null;
  googlePlaceId: string | null;
} | null;

type NotificationItem = {
  // Stable per underlying row so the client can key/dedupe across refreshes.
  id: string;
  category: Category;
  type: NotificationType;
  occurredAt: string;
  venue: VenueRef;
  // "Who" — owner display for creations, requester email for claims, "Atlas"
  // for enrichments. null when genuinely unknown (e.g. unclaimed venue).
  actor: string | null;
  // Free-text detail — the enrichment summary snippet. null otherwise.
  detail: string | null;
  meta: Record<string, unknown>;
};

// supabase-js types a to-one embed as `T | T[] | null` depending on the
// relationship metadata; normalise to the first object either way.
function one<T>(rel: T | T[] | null | undefined): T | null {
  if (Array.isArray(rel)) return rel[0] ?? null;
  return rel ?? null;
}

type VenueShape = {
  id: string;
  slug: string | null;
  name: string | null;
  address: string | null;
  category_label: string | null;
  google_place_id: string | null;
};

function venueRef(v: VenueShape | null): VenueRef {
  if (!v) return null;
  return {
    id: v.id,
    slug: v.slug,
    name: v.name ?? "(unnamed venue)",
    address: v.address,
    categoryLabel: v.category_label,
    googlePlaceId: v.google_place_id,
  };
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1).trimEnd() + "…";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405);
  }

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const body = await readJsonOr<Body>(req, {});
  const limit = clampIntRange(body.limit ?? 60, 1, 200);
  const category = body.category ?? "all";
  const wantAtlas = category === "all" || category === "atlas";

  const items: NotificationItem[] = [];
  const counts: Record<string, number> = {};

  if (wantAtlas) {
    // Pull a window per source then merge-sort-slice. Each source is capped
    // at `limit` so a flood in one type can't starve the others before the
    // final sort.
    const [createdRes, enrichedRes, claimsRes] = await Promise.all([
      admin
        .from("venues")
        .select(
          "id, slug, name, address, category_label, google_place_id, listing_type, status, created_at, enriched_at",
        )
        .order("created_at", { ascending: false })
        .limit(limit),
      admin
        .from("venues")
        .select(
          "id, slug, name, address, category_label, google_place_id, editorial_summary, description, details, enriched_at",
        )
        .not("enriched_at", "is", null)
        .order("enriched_at", { ascending: false })
        .limit(limit),
      admin
        .from("venue_verifications")
        .select(
          "id, venue_id, method, requester_email, status, created_at, venue:venues(id, slug, name, address, category_label, google_place_id)",
        )
        .order("created_at", { ascending: false })
        .limit(limit),
    ]);

    if (createdRes.error) {
      return json({ ok: false, error: `venues_created: ${createdRes.error.message}` }, 500);
    }
    if (enrichedRes.error) {
      return json({ ok: false, error: `venues_enriched: ${enrichedRes.error.message}` }, 500);
    }
    if (claimsRes.error) {
      return json({ ok: false, error: `claims: ${claimsRes.error.message}` }, 500);
    }

    const createdRows = (createdRes.data ?? []) as Array<
      VenueShape & {
        listing_type: string | null;
        status: string | null;
        created_at: string;
        enriched_at: string | null;
      }
    >;

    // Resolve the current owner for the created venues in one batched read.
    // Most freshly-created venues are unclaimed, so this map is usually small.
    const ownerByVenue = new Map<string, { email: string | null; name: string | null }>();
    const createdIds = createdRows.map((r) => r.id);
    if (createdIds.length > 0) {
      const { data: owners, error: ownersErr } = await admin
        .from("venue_members")
        .select("venue_id, business:businesses(email, full_name, first_name, last_name)")
        .eq("role", "owner")
        .in("venue_id", createdIds);
      if (ownersErr) {
        return json({ ok: false, error: `owners: ${ownersErr.message}` }, 500);
      }
      for (const row of (owners ?? []) as Array<{
        venue_id: string;
        business:
          | { email: string | null; full_name: string | null; first_name: string | null; last_name: string | null }
          | Array<{ email: string | null; full_name: string | null; first_name: string | null; last_name: string | null }>
          | null;
      }>) {
        const b = one(row.business);
        const joined = [b?.first_name, b?.last_name].filter(Boolean).join(" ").trim();
        const fullName = b?.full_name?.trim() || null;
        const name = fullName || (joined.length > 0 ? joined : null);
        ownerByVenue.set(row.venue_id, { email: b?.email ?? null, name });
      }
    }

    // ── atlas.venue_created ──────────────────────────────────────────────
    for (const v of createdRows) {
      const owner = ownerByVenue.get(v.id);
      const actor = owner
        ? owner.name
          ? owner.email
            ? `${owner.name} · ${owner.email}`
            : owner.name
          : owner.email
        : null;
      items.push({
        id: `atlas.venue_created:${v.id}`,
        category: "atlas",
        type: "atlas.venue_created",
        occurredAt: v.created_at,
        venue: venueRef(v),
        actor,
        detail: null,
        meta: {
          listingType: v.listing_type,
          status: v.status,
          enriched: v.enriched_at != null,
          claimed: !!owner,
        },
      });
    }

    // ── atlas.venue_enriched ─────────────────────────────────────────────
    for (const v of (enrichedRes.data ?? []) as Array<
      VenueShape & {
        editorial_summary: string | null;
        description: string | null;
        details: unknown;
        enriched_at: string;
      }
    >) {
      const summary =
        (v.editorial_summary && v.editorial_summary.trim()) ||
        (v.description && v.description.trim()) ||
        null;
      const detailsFields =
        v.details && typeof v.details === "object" && !Array.isArray(v.details)
          ? Object.keys(v.details as Record<string, unknown>).length
          : 0;
      items.push({
        id: `atlas.venue_enriched:${v.id}`,
        category: "atlas",
        type: "atlas.venue_enriched",
        occurredAt: v.enriched_at,
        venue: venueRef(v),
        actor: "Atlas",
        detail: summary ? truncate(summary, 260) : null,
        meta: { detailsFields, hasSummary: !!summary },
      });
    }

    // ── atlas.ownership_claimed ──────────────────────────────────────────
    for (const c of (claimsRes.data ?? []) as Array<{
      id: string;
      venue_id: string;
      method: string | null;
      requester_email: string | null;
      status: string | null;
      created_at: string;
      venue: VenueShape | VenueShape[] | null;
    }>) {
      items.push({
        id: `atlas.ownership_claimed:${c.id}`,
        category: "atlas",
        type: "atlas.ownership_claimed",
        occurredAt: c.created_at,
        venue: venueRef(one(c.venue)),
        actor: c.requester_email ?? null,
        detail: null,
        meta: { method: c.method, status: c.status },
      });
    }

    counts["atlas.venue_created"] = createdRows.length;
    counts["atlas.venue_enriched"] = (enrichedRes.data ?? []).length;
    counts["atlas.ownership_claimed"] = (claimsRes.data ?? []).length;
  }

  // Newest first across every type, then cap to the requested window.
  items.sort((a, b) =>
    a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
  );
  const notifications = items.slice(0, limit);

  return json({
    ok: true,
    notifications,
    counts,
    categories: ["atlas"],
    total: items.length,
    generatedAt: new Date().toISOString(),
  });
});
