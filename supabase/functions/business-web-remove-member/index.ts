// Supabase Edge Function — business-web-remove-member
//
// Removes one team artefact from a place. The `kind` discriminates:
//
//   editor       → project_members row (cannot remove last owner)
//   waiter       → project_roles row
//   editorInvite → account_invites row (revoke pending email invite)
//   waiterInvite → staff_invites row (revoke pending waiter invite)
//
// Owners (and super-admins) can remove anyone. Editors and viewers
// cannot remove other members but may remove themselves (handy "leave
// place" affordance) — except the last owner, who is pinned.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsPreflight, json, readJsonOr } from "../_shared/http.ts";
import {
  adminClient,
  checkMembership,
  getAuthedUser,
  readEFEnv,
} from "../_shared/auth.ts";
import { isLastOwnerOfPlace } from "../_shared/place-ownership.ts";

const KINDS = ["editor", "waiter", "editorInvite", "waiterInvite"] as const;
type Kind = (typeof KINDS)[number];
type Body = { id?: string; kind?: Kind };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const body = await readJsonOr<Body>(req, {});
  const id = (body.id ?? "").trim();
  const kind = body.kind;
  if (!id) return json({ ok: false, error: "id is required" }, 400);
  if (!kind || !(KINDS as readonly string[]).includes(kind)) {
    return json({ ok: false, error: "kind must be editor | waiter | editorInvite | waiterInvite" }, 400);
  }

  const admin = adminClient(envRes.env);
  const target = await loadTarget(admin, kind, id, authRes.user.id);
  if (!target.ok) return target.response;

  // Authorization: self-removal is fine regardless of role; otherwise
  // the caller must be an owner of the same place (or super-admin).
  if (!target.isSelfRemoval) {
    const m = await checkMembership(admin, authRes.user, target.projectId);
    if (!m.isSuperAdmin && m.role !== "owner") {
      return json({ ok: false, error: "Not allowed to remove this member." }, 403);
    }
  }

  if (kind === "editor" && target.targetIsOwner) {
    if (await isLastOwnerOfPlace(admin, target.projectId)) {
      return json(
        { ok: false, code: "last_owner", error: "Promote another owner first." },
        409,
      );
    }
  }

  const del = await deleteTarget(admin, kind, id);
  if (del?.error) {
    return json({ ok: false, error: `delete: ${del.error.message}` }, 500);
  }

  return json({ ok: true, id, kind });
});

// ─── Helpers ────────────────────────────────────────────────────────

type LoadedTarget =
  | {
      ok: true;
      projectId: string;
      isSelfRemoval: boolean;
      targetIsOwner: boolean;
    }
  | { ok: false; response: Response };

async function loadTarget(
  admin: SupabaseClient,
  kind: Kind,
  id: string,
  callerId: string,
): Promise<LoadedTarget> {
  switch (kind) {
    case "editor": {
      const row = await admin
        .from("project_members")
        .select("project_id, business_id, role")
        .eq("id", id)
        .maybeSingle();
      if (row.error) return notFound(`member_read: ${row.error.message}`, 500);
      if (!row.data) return notFound("Member not found.", 404);
      return {
        ok: true,
        projectId: row.data.project_id,
        isSelfRemoval: row.data.business_id === callerId,
        targetIsOwner: row.data.role === "owner",
      };
    }
    case "waiter": {
      const [userId, placeIdFromKey] = id.split(":");
      if (!userId || !placeIdFromKey) {
        return notFound("id must be userId:projectId", 400);
      }
      const row = await admin
        .from("project_roles")
        .select("user_id, project_id")
        .eq("user_id", userId)
        .eq("project_id", placeIdFromKey)
        .maybeSingle();
      if (row.error) return notFound(`role_read: ${row.error.message}`, 500);
      if (!row.data) return notFound("Waiter not found on this place.", 404);
      return {
        ok: true,
        projectId: row.data.project_id,
        isSelfRemoval: false,
        targetIsOwner: false,
      };
    }
    case "editorInvite":
      return await loadInvite(admin, "account_invites", id);
    case "waiterInvite":
      return await loadInvite(admin, "staff_invites", id);
  }
}

async function loadInvite(
  admin: SupabaseClient,
  table: "account_invites" | "staff_invites",
  id: string,
): Promise<LoadedTarget> {
  const row = await admin.from(table).select("project_id").eq("id", id).maybeSingle();
  if (row.error) return notFound(`invite_read: ${row.error.message}`, 500);
  if (!row.data) return notFound("Invite not found.", 404);
  return {
    ok: true,
    projectId: row.data.project_id,
    isSelfRemoval: false,
    targetIsOwner: false,
  };
}

function notFound(error: string, status: number): { ok: false; response: Response } {
  return { ok: false, response: json({ ok: false, error }, status) };
}

async function deleteTarget(admin: SupabaseClient, kind: Kind, id: string) {
  switch (kind) {
    case "editor":
      return await admin.from("project_members").delete().eq("id", id);
    case "waiter": {
      const [userId, placeIdFromKey] = id.split(":");
      return await admin
        .from("project_roles")
        .delete()
        .eq("user_id", userId)
        .eq("project_id", placeIdFromKey);
    }
    case "editorInvite":
      return await admin.from("account_invites").delete().eq("id", id);
    case "waiterInvite":
      return await admin.from("staff_invites").delete().eq("id", id);
  }
}
