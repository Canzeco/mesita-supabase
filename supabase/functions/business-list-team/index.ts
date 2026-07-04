// Supabase Edge Function — business-list-team
//
// Returns the active team of a place in one round trip:
//   - businesses : project_members joined to businesses (email-pool roles)
//   - waiters  : project_roles joined to auth.users phones (phone-pool
//     staff)
//   - pendingBusinessInvites
//   - pendingWaiterInvites
//   - myRole : caller's role on this place (or "super_admin"), so the
//     UI doesn't have to derive owner-ness from the businesses list and
//     gets the right answer for super-admins who skipped project_members
//
// Auth: any signed-in member of the place. Super-admins
// (public.super_admins) bypass the membership check.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireMembership,
} from "../_shared/auth.ts";
import { phoneDigits } from "../_shared/phone.ts";

type Body = { projectId?: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const body = await readJsonOr<Body>(req, {});
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) return json({ ok: false, error: "projectId is required" }, 400);

  const admin = adminClient(envRes.env);
  const memberRes = await requireMembership(admin, authRes.user, projectId);
  if (!memberRes.ok) return memberRes.response;

  const nowIso = new Date().toISOString();

  // Four independent reads in parallel — no further fan-out except
  // for the waiter phone lookups below.
  const [memberRows, roleRows, pendingBusinessRows, pendingWaiterRows] = await Promise.all([
    admin
      .from("project_members")
      .select("id, role, created_at, business:businesses(id, full_name, email)")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
    admin
      .from("project_roles")
      .select("user_id, role, created_at")
      .eq("project_id", projectId)
      .eq("role", "staff")
      .order("created_at", { ascending: true }),
    admin
      .from("account_invites")
      .select("id, email, role, token, created_at, expires_at")
      .eq("project_id", projectId)
      .is("claimed_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false }),
    admin
      .from("staff_invites")
      .select("id, phone, channel, token, created_at, expires_at")
      .eq("project_id", projectId)
      .is("claimed_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false }),
  ]);

  for (const r of [memberRows, roleRows, pendingBusinessRows, pendingWaiterRows]) {
    if (r.error) {
      return json({ ok: false, error: `read: ${r.error.message}` }, 500);
    }
  }

  type BusinessJoin = {
    id: string;
    role: string;
    created_at: string;
    business: { id: string; full_name: string | null; email: string | null } | null;
  };
  const businesses = ((memberRows.data ?? []) as unknown as BusinessJoin[])
    .filter((r) => r.business != null)
    .map((r) => ({
      memberId: r.id,
      userId: r.business!.id,
      role: r.role,
      fullName: r.business!.full_name,
      email: r.business!.email,
      createdAt: r.created_at,
    }));

  const waiters = await loadWaitersWithPhones(admin, roleRows.data ?? []);

  const pendingBusinessInvites = (pendingBusinessRows.data ?? []).map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    token: r.token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
  }));

  const pendingWaiterInvites = dedupePendingWaiterInvites(
    (pendingWaiterRows.data ?? []).map((r) => ({
      id: r.id,
      phone: r.phone,
      channel: r.channel ?? "whatsapp",
      token: r.token,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    })),
  );

  // `myRole` lets the client gate UI without re-deriving from the
  // businesses list (super-admins aren't always in project_members).
  const myRole = memberRes.membership.isSuperAdmin
    ? "super_admin"
    : memberRes.membership.role;

  return json({
    ok: true,
    myRole,
    businesses,
    waiters,
    pendingBusinessInvites,
    pendingWaiterInvites,
  });
});

// ─── Waiter phone hydration ─────────────────────────────────────────
//
// project_roles only stores user_id; the phone lives on auth.users.
// Until we add a phone column to project_roles we have to read each
// auth user — running them in parallel keeps the latency flat.

type RoleRow = { user_id: string; role: string; created_at: string };

type PendingWaiterRow = {
  id: string;
  phone: string | null;
  channel: string;
  token: string;
  createdAt: string;
  expiresAt: string;
};

/** Safety net if legacy duplicate rows exist before migration is applied. */
function dedupePendingWaiterInvites(rows: PendingWaiterRow[]): PendingWaiterRow[] {
  const byKey = new Map<string, PendingWaiterRow>();
  for (const row of rows) {
    const key = row.phone ? phoneDigits(row.phone) : row.id;
    const prev = byKey.get(key);
    if (!prev || row.createdAt > prev.createdAt) {
      byKey.set(key, row);
    }
  }
  return Array.from(byKey.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

async function loadWaitersWithPhones(
  admin: SupabaseClient,
  rows: RoleRow[],
): Promise<{ userId: string; phone: string | null; createdAt: string }[]> {
  if (rows.length === 0) return [];
  const phones = await Promise.all(
    rows.map((r) =>
      admin.auth.admin
        .getUserById(r.user_id)
        .then((u) => (u.data.user?.phone ? `+${u.data.user.phone}` : null))
        .catch(() => null),
    ),
  );
  return rows.map((r, i) => ({
    userId: r.user_id,
    phone: phones[i],
    createdAt: r.created_at,
  }));
}
