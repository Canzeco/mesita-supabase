// Auth + venue-membership helpers shared by every business-* Edge
// Function on the Team surface (and reusable anywhere else that needs
// "is this caller allowed to touch this venue?").
//
// The three EF entry-points always look the same:
//
//   1. Read SUPABASE_URL / ANON_KEY / SERVICE_ROLE_KEY → 500 if missing
//   2. Verify Bearer JWT → resolve auth.user → 401 if missing/invalid
//   3. (Optionally) confirm the user is a member of a venue, possibly
//      with role ≥ X, with super_admins as a bypass — 403 otherwise
//
// Repeating all three inline 7 times is what this module exists to
// eliminate. Each helper returns a tagged result so the EF can early
// return with a typed Response, no thrown exceptions.

import {
  createClient,
  type SupabaseClient,
  type User,
} from "jsr:@supabase/supabase-js@2";
import { json } from "./http.ts";

// ─── Env ────────────────────────────────────────────────────────────

export type EFEnv = {
  url: string;
  anonKey: string;
  serviceKey: string;
};

export function readEFEnv():
  | { ok: true; env: EFEnv }
  | { ok: false; response: Response } {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) {
    return {
      ok: false,
      response: json({ ok: false, error: "Server misconfigured" }, 500),
    };
  }
  return { ok: true, env: { url, anonKey, serviceKey } };
}

// Lighter variant for PUBLIC read endpoints that only need the anon key
// (RLS-restricted reads, no service-role writes, no internal invokes).
// Avoids 500ing on a missing SERVICE_ROLE_KEY that the handler never uses.
export type AnonEnv = { url: string; anonKey: string };

export function readAnonEnv():
  | { ok: true; env: AnonEnv }
  | { ok: false; response: Response } {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    return {
      ok: false,
      response: json({ ok: false, error: "Server misconfigured" }, 500),
    };
  }
  return { ok: true, env: { url, anonKey } };
}

// ─── User auth ──────────────────────────────────────────────────────

export type AuthedUser = {
  id: string;
  email: string | null;
  emailLower: string | null;
  phone: string | null;
  appRole: string | null;
  // The underlying Supabase user object — never null on the success
  // path because getAuthedUser bails before returning if data.user is
  // missing.
  raw: User;
};

// Shared shaping so getAuthedUser and getOptionalAuthedUser stay in lockstep.
function shapeAuthedUser(raw: User): AuthedUser {
  return {
    id: raw.id,
    email: raw.email ?? null,
    emailLower: raw.email?.toLowerCase() ?? null,
    phone: raw.phone ?? null,
    appRole:
      ((raw.app_metadata as Record<string, unknown> | null)?.role as
        | string
        | undefined) ?? null,
    raw,
  };
}

export async function getAuthedUser(
  req: Request,
  env: EFEnv,
): Promise<
  | { ok: true; user: AuthedUser; userClient: SupabaseClient }
  | { ok: false; response: Response }
> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return {
      ok: false,
      response: json({ ok: false, error: "Missing bearer token" }, 401),
    };
  }
  const userClient = createClient(env.url, env.anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) {
    return {
      ok: false,
      response: json({ ok: false, error: "Invalid session" }, 401),
    };
  }
  return { ok: true, userClient, user: shapeAuthedUser(data.user) };
}

// Anonymous-OK variant for public facades (discovery decks, catalog,
// place suggestions) where a signed-in caller gets personalization but an
// anonymous caller is still served. Never returns a 401: a missing or
// invalid bearer simply yields `user: null`. When a valid session IS
// present, the RLS-scoped `userClient` is returned so the handler can read
// the caller's own rows.
//
//   const { user, userClient } = await getOptionalAuthedUser(req, env);
//   if (user && userClient) { /* personalize */ }
export async function getOptionalAuthedUser(
  req: Request,
  env: EFEnv | AnonEnv,
): Promise<{ user: AuthedUser | null; userClient: SupabaseClient | null }> {
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, userClient: null };
  }
  const userClient = createClient(env.url, env.anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) {
    return { user: null, userClient: null };
  }
  return { user: shapeAuthedUser(data.user), userClient };
}

// ─── Admin client ───────────────────────────────────────────────────

export function adminClient(env: EFEnv): SupabaseClient {
  return createClient(env.url, env.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ─── Membership ─────────────────────────────────────────────────────

// Mirrors the public.member_role enum (see migration 0025). 'staff' is
// legacy — only present on venue_members rows created before venue_roles
// existed; the Team UI speaks owner / editor / viewer.
type MembershipRole = "owner" | "editor" | "viewer" | "staff";

type Membership = {
  isSuperAdmin: boolean;
  // The venue_members.role for the caller, or null when the caller has
  // no membership row (super-admins land here too — owners write access
  // either way via the isSuperAdmin flag).
  role: MembershipRole | null;
};

// Returns whether the caller is a member of the venue (or a
// super-admin). Runs the two lookups in parallel.
export async function checkMembership(
  admin: SupabaseClient,
  user: AuthedUser,
  venueId: string,
): Promise<Membership> {
  const saPromise = user.emailLower
    ? admin
        .from("super_admins")
        .select("email")
        .eq("email", user.emailLower)
        .maybeSingle()
    : Promise.resolve({ data: null });

  const vmPromise = admin
    .from("venue_members")
    .select("role")
    .eq("venue_id", venueId)
    .eq("business_id", user.id)
    .maybeSingle();

  const [sa, vm] = await Promise.all([saPromise, vmPromise]);
  const role = (vm.data?.role as MembershipRole | undefined) ?? null;
  return {
    isSuperAdmin: !!sa.data,
    role,
  };
}

// Resolves the super-admin allowlist row for the caller, lazy-backfilling
// user_id so future audit logs can join by uuid without re-reading
// auth.users. Returns `null` if the caller isn't on the list.
//
// Pattern moved out of 12+ admin EFs that each reimplemented the same
// lookup + lazy backfill. Callers that need a hard 403 should use
// `requireSuperAdmin` below; callers that want to render a soft "you're
// not on the list" state (admin-whoami, business-get-overview) should
// call this directly and inspect the boolean.
export async function checkSuperAdmin(
  admin: SupabaseClient,
  user: AuthedUser,
): Promise<boolean> {
  if (!user.emailLower) return false;
  const { data: saRow } = await admin
    .from("super_admins")
    .select("email, user_id")
    .eq("email", user.emailLower)
    .maybeSingle();
  if (!saRow) return false;
  if (saRow.user_id == null) {
    // Fire-and-forget; the next call picks up the backfilled uuid.
    void admin
      .from("super_admins")
      .update({ user_id: user.id })
      .eq("email", user.emailLower)
      .is("user_id", null);
  }
  return true;
}

// 403s unless the caller's email is in `public.super_admins`. The 401
// for "no email on session" stays explicit because every admin EF wants
// to distinguish "I don't know who you are" from "I know but you can't".
export async function requireSuperAdmin(
  admin: SupabaseClient,
  user: AuthedUser,
  errorMessage = "Not a super-admin",
): Promise<{ ok: true } | { ok: false; response: Response }> {
  if (!user.emailLower) {
    return {
      ok: false,
      response: json({ ok: false, error: "No email on session" }, 401),
    };
  }
  const ok = await checkSuperAdmin(admin, user);
  if (!ok) {
    return {
      ok: false,
      response: json({ ok: false, error: errorMessage }, 403),
    };
  }
  return { ok: true };
}

// Convenience: 403s if the caller has no membership at all (and isn't
// a super-admin).
export async function requireMembership(
  admin: SupabaseClient,
  user: AuthedUser,
  venueId: string,
): Promise<
  | { ok: true; membership: Membership }
  | { ok: false; response: Response }
> {
  const m = await checkMembership(admin, user, venueId);
  if (!m.isSuperAdmin && m.role == null) {
    return {
      ok: false,
      response: json({ ok: false, error: "Not a member of this venue" }, 403),
    };
  }
  return { ok: true, membership: m };
}

// 403s unless the caller is an owner (or super-admin).
export async function requireOwner(
  admin: SupabaseClient,
  user: AuthedUser,
  venueId: string,
  errorMessage = "Only owners can do that.",
): Promise<
  | { ok: true; membership: Membership }
  | { ok: false; response: Response }
> {
  const m = await checkMembership(admin, user, venueId);
  if (!m.isSuperAdmin && m.role !== "owner") {
    return {
      ok: false,
      response: json({ ok: false, error: errorMessage }, 403),
    };
  }
  return { ok: true, membership: m };
}
