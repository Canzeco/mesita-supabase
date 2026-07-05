// Supabase Edge Function — admin-web-list-notifications (admin caller)
//
// Powers admin.mesita.ai/global-performance → Notifications view. The
// console is intentionally NOT realtime: the operator pulls a fresh feed
// (manual Refresh + light client polling), and this EF recomputes the feed
// from source tables on every call.
//
// One category so far — **atlas** — with four event types. Three are
// *derived* (we read the timestamps the product already writes); the fourth
// reads the dedicated per-step events table the n8n Enricher appends to:
//
//   atlas.place_created      a new row in public.places
//   atlas.place_enriched     a place whose Enricher pass completed
//                            (enriched_at stamped) — carries the textual
//                            summary the enricher synthesised
//   atlas.enrichment_step    one Enricher pipeline step finished (or failed) —
//                            read from public.place_enrichment_events, written
//                            by enricher-agent-report-step as the n8n run progresses
//   atlas.ownership_claimed  someone submitted an ownership proof
//                            (public.project_verifications) for a place
//
// The envelope is category-agnostic so future categories (billing,
// verifications, consumers…) slot in without a client rewrite: each item
// is { id, category, type, occurredAt, place, actor, detail, meta } and the
// client renders title/icon from `type`.
//
// Filters: `category` narrows to a category; `types` narrows to specific
// event types server-side (skips whole source reads — step events flood the
// feed, so the client can ask for just what it shows); `projectId` narrows
// every source to one place; `q` is a case-insensitive place-name substring
// filter applied after the merge (the per-source window is already capped).
//
// "Who called it" for a creation: places don't persist the caller at insert
// time (business-web-create-project deliberately leaves the place unowned until an
// ownership claim is approved), so the closest honest signal is the place's
// current owner — resolved here via project_members(role=owner) → accounts.
// Unclaimed places report actor = null and meta.claimed = false. The exact
// claimant, when it exists, is its own ownership_claimed event.
//
// Place embedding — each source resolves the place profile through the FK it
// actually has (PostgREST embeds follow declared FKs only):
//   • place_enrichment_events.project_id → places(id)      → embed places directly
//   • project_verifications.project_id  → projects(id)     → hop projects → places
// projects (the owned entity) shares its PK 1:1 with places and carries the
// `slug`; the place profile columns (name/address/…) live on places. So the
// claims source embeds `projects(id, slug, places(…))` and flattens the two
// halves back into one PlaceRef. Do NOT embed `places` straight off
// project_verifications — there is no such FK and PostgREST 500s with
// "Could not find a relationship between 'project_verifications' and 'places'".
//
// Auth: caller's JWT email must be in public.super_admins.
//
// Deploy: supabase functions deploy admin-web-list-notifications

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { clampIntRange, corsPreflight, json, readJsonOr, readPlaceIdAlias } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Category = "atlas";

type NotificationType =
  | "atlas.place_created"
  | "atlas.place_enriched"
  | "atlas.enrichment_step"
  | "atlas.ownership_claimed";

const ALL_TYPES: NotificationType[] = [
  "atlas.place_created",
  "atlas.place_enriched",
  "atlas.enrichment_step",
  "atlas.ownership_claimed",
];

type Body = {
  // "all" (or omitted) returns every category. A specific category narrows
  // the feed server-side.
  category?: Category | "all" | null;
  // Narrow to specific event types server-side (empty/omitted = all types).
  types?: string[] | null;
  // Narrow every source to a single place (the places/projects shared PK).
  // `placeId` is the canonical key (MESITA-26); `projectId` is the legacy alias.
  placeId?: string | null;
  projectId?: string | null;
  // Case-insensitive place-name substring filter (applied post-merge).
  q?: string | null;
  limit?: number;
};

type PlaceRef = {
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
  place: PlaceRef;
  // "Who" — owner display for creations, requester email for claims,
  // "Enricher" for enrichment events. null when genuinely unknown.
  actor: string | null;
  // Free-text detail — the enrichment summary snippet / step detail line.
  detail: string | null;
  meta: Record<string, unknown>;
};

// supabase-js types a to-one embed as `T | T[] | null` depending on the
// relationship metadata; normalise to the first object either way.
function one<T>(rel: T | T[] | null | undefined): T | null {
  if (Array.isArray(rel)) return rel[0] ?? null;
  return rel ?? null;
}

type PlaceShape = {
  id: string;
  // `slug` is a projects-only column — the base public.places table has none.
  // Sources embedded via the places FK (steps) can't select it, so it's
  // optional here and defaults to null in placeRef. The claims source hops
  // through projects and DOES carry it (see projectPlaceRef).
  slug?: string | null;
  name: string | null;
  address: string | null;
  category_label: string | null;
  google_place_id: string | null;
};

function placeRef(v: PlaceShape | null): PlaceRef {
  if (!v) return null;
  return {
    id: v.id,
    slug: v.slug ?? null,
    name: v.name ?? "(unnamed place)",
    address: v.address,
    categoryLabel: v.category_label,
    googlePlaceId: v.google_place_id,
  };
}

// A place profile reached by hopping project_verifications → projects → places.
// `slug` comes from the projects entity; the profile fields come from the
// nested places embed. Shared PK means projects.id === places.id, so we key
// the ref on the projects id.
type ProjectPlaceShape = {
  id: string;
  slug: string | null;
  place:
    | Omit<PlaceShape, "id" | "slug">
    | Array<Omit<PlaceShape, "id" | "slug">>
    | null;
};

function projectPlaceRef(p: ProjectPlaceShape | null): PlaceRef {
  if (!p) return null;
  const pl = one(p.place);
  return {
    id: p.id,
    slug: p.slug ?? null,
    name: pl?.name ?? "(unnamed place)",
    address: pl?.address ?? null,
    categoryLabel: pl?.category_label ?? null,
    googlePlaceId: pl?.google_place_id ?? null,
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
  const typesFilter = (Array.isArray(body.types) ? body.types : [])
    .filter((t): t is NotificationType => ALL_TYPES.includes(t as NotificationType));
  const wantType = (t: NotificationType) =>
    wantAtlas && (typesFilter.length === 0 || typesFilter.includes(t));
  const projectId = readPlaceIdAlias(body) || null;
  const q = (body.q ?? "").toString().trim().toLowerCase() || null;

  const items: NotificationItem[] = [];

  if (wantAtlas) {
    // Pull a window per source then merge-sort-slice. Each source is capped
    // at `limit` so a flood in one type can't starve the others before the
    // final sort. Sources whose type the caller filtered out are skipped
    // entirely.
    const createdQuery = wantType("atlas.place_created")
      ? (() => {
        let qb = admin
          .from("projects_view")
          .select(
            "id, slug, name, address, category_label, google_place_id, listing_type, status, created_at, enriched_at",
          )
          .order("created_at", { ascending: false })
          .limit(limit);
        if (projectId) qb = qb.eq("id", projectId);
        return qb;
      })()
      : Promise.resolve({ data: null, error: null });

    const enrichedQuery = wantType("atlas.place_enriched")
      ? (() => {
        let qb = admin
          .from("projects_view")
          .select(
            "id, slug, name, address, category_label, google_place_id, editorial_summary, description, details, enriched_at",
          )
          .not("enriched_at", "is", null)
          .order("enriched_at", { ascending: false })
          .limit(limit);
        if (projectId) qb = qb.eq("id", projectId);
        return qb;
      })()
      : Promise.resolve({ data: null, error: null });

    const stepsQuery = wantType("atlas.enrichment_step")
      ? (() => {
        let qb = admin
          .from("place_enrichment_events")
          .select(
            "id, project_id, step, step_name, status, detail, meta, created_at, place:places(id, name, address, category_label, google_place_id)",
          )
          .order("created_at", { ascending: false })
          .limit(limit);
        if (projectId) qb = qb.eq("project_id", projectId);
        return qb;
      })()
      : Promise.resolve({ data: null, error: null });

    const claimsQuery = wantType("atlas.ownership_claimed")
      ? (() => {
        let qb = admin
          .from("project_verifications")
          .select(
            // project_verifications has no FK to places — it references the
            // projects entity (shared PK with places). Hop through projects to
            // reach the profile; slug lives on projects, the rest on places.
            "id, project_id, method, requester_email, status, created_at, project:projects(id, slug, place:places(name, address, category_label, google_place_id))",
          )
          .order("created_at", { ascending: false })
          .limit(limit);
        if (projectId) qb = qb.eq("project_id", projectId);
        return qb;
      })()
      : Promise.resolve({ data: null, error: null });

    const [createdRes, enrichedRes, stepsRes, claimsRes] = await Promise.all([
      createdQuery,
      enrichedQuery,
      stepsQuery,
      claimsQuery,
    ]);

    if (createdRes.error) {
      return json({ ok: false, error: `places_created: ${createdRes.error.message}` }, 500);
    }
    if (enrichedRes.error) {
      return json({ ok: false, error: `places_enriched: ${enrichedRes.error.message}` }, 500);
    }
    if (stepsRes.error) {
      return json({ ok: false, error: `enrichment_steps: ${stepsRes.error.message}` }, 500);
    }
    if (claimsRes.error) {
      return json({ ok: false, error: `claims: ${claimsRes.error.message}` }, 500);
    }

    const createdRows = (createdRes.data ?? []) as Array<
      PlaceShape & {
        listing_type: string | null;
        status: string | null;
        created_at: string;
        enriched_at: string | null;
      }
    >;

    // Resolve the current owner for the created places in one batched read.
    // Most freshly-created places are unclaimed, so this map is usually small.
    const ownerByPlace = new Map<string, { email: string | null; name: string | null }>();
    const createdIds = createdRows.map((r) => r.id);
    if (createdIds.length > 0) {
      const { data: owners, error: ownersErr } = await admin
        .from("project_members")
        // project_members.business_id → accounts (the businesses table was
        // renamed to `accounts` in the R2 rename; no compat view exists, so
        // embedding `businesses` 500s). Alias the result back to `business`.
        .select("project_id, business:accounts(email, full_name, first_name, last_name)")
        .eq("role", "owner")
        .in("project_id", createdIds);
      if (ownersErr) {
        return json({ ok: false, error: `owners: ${ownersErr.message}` }, 500);
      }
      for (const row of (owners ?? []) as Array<{
        project_id: string;
        business:
          | { email: string | null; full_name: string | null; first_name: string | null; last_name: string | null }
          | Array<{ email: string | null; full_name: string | null; first_name: string | null; last_name: string | null }>
          | null;
      }>) {
        const b = one(row.business);
        const joined = [b?.first_name, b?.last_name].filter(Boolean).join(" ").trim();
        const fullName = b?.full_name?.trim() || null;
        const name = fullName || (joined.length > 0 ? joined : null);
        ownerByPlace.set(row.project_id, { email: b?.email ?? null, name });
      }
    }

    // ── atlas.place_created ──────────────────────────────────────────────
    for (const v of createdRows) {
      const owner = ownerByPlace.get(v.id);
      const actor = owner
        ? owner.name
          ? owner.email
            ? `${owner.name} · ${owner.email}`
            : owner.name
          : owner.email
        : null;
      items.push({
        id: `atlas.place_created:${v.id}`,
        category: "atlas",
        type: "atlas.place_created",
        occurredAt: v.created_at,
        place: placeRef(v),
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

    // ── atlas.place_enriched ─────────────────────────────────────────────
    for (const v of (enrichedRes.data ?? []) as Array<
      PlaceShape & {
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
        id: `atlas.place_enriched:${v.id}`,
        category: "atlas",
        type: "atlas.place_enriched",
        occurredAt: v.enriched_at,
        place: placeRef(v),
        actor: "Enricher",
        detail: summary ? truncate(summary, 260) : null,
        meta: { detailsFields, hasSummary: !!summary },
      });
    }

    // ── atlas.enrichment_step ────────────────────────────────────────────
    for (const e of (stepsRes.data ?? []) as Array<{
      id: string;
      project_id: string;
      step: string;
      step_name: string;
      status: string;
      detail: string | null;
      meta: Record<string, unknown> | null;
      created_at: string;
      place: PlaceShape | PlaceShape[] | null;
    }>) {
      items.push({
        id: `atlas.enrichment_step:${e.id}`,
        category: "atlas",
        type: "atlas.enrichment_step",
        occurredAt: e.created_at,
        place: placeRef(one(e.place)),
        actor: "Enricher",
        detail: e.detail,
        meta: {
          step: e.step,
          stepName: e.step_name,
          status: e.status,
          ...(e.meta && typeof e.meta === "object" ? e.meta : {}),
        },
      });
    }

    // ── atlas.ownership_claimed ──────────────────────────────────────────
    for (const c of (claimsRes.data ?? []) as Array<{
      id: string;
      project_id: string;
      method: string | null;
      requester_email: string | null;
      status: string | null;
      created_at: string;
      project: ProjectPlaceShape | ProjectPlaceShape[] | null;
    }>) {
      items.push({
        id: `atlas.ownership_claimed:${c.id}`,
        category: "atlas",
        type: "atlas.ownership_claimed",
        occurredAt: c.created_at,
        place: projectPlaceRef(one(c.project)),
        actor: c.requester_email ?? null,
        detail: null,
        meta: { method: c.method, status: c.status },
      });
    }
  }

  // Place-name substring filter, then newest-first across every type, then cap
  // to the requested window. Counts reflect the filtered set so the client's
  // pills stay consistent with what is shown.
  const filtered = q
    ? items.filter((i) => (i.place?.name ?? "").toLowerCase().includes(q))
    : items;

  const counts: Record<string, number> = {};
  for (const i of filtered) counts[i.type] = (counts[i.type] ?? 0) + 1;

  filtered.sort((a, b) =>
    a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0,
  );
  const notifications = filtered.slice(0, limit);

  return json({
    ok: true,
    notifications,
    counts,
    categories: ["atlas"],
    types: ALL_TYPES,
    total: filtered.length,
    generatedAt: new Date().toISOString(),
  });
});
