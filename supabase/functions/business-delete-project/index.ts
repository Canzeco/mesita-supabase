// Supabase Edge Function — business-delete-project
//
// Authenticated. Deletes a place (unit) the caller is an *owner* of, along
// with every dependent row. Self-contained: verifies the JWT, checks
// project_members membership + role itself, then deletes via service role.
// Does NOT call any other Edge Function.
//
// Cascade order matters: tickets reference places with ON DELETE RESTRICT,
// so they must be removed first. project_members cascades automatically when
// the place is dropped.
//
// Local:  supabase functions serve business-delete-project
// Deploy: supabase functions deploy business-delete-project

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireOwner,
} from "../_shared/auth.ts";

type DeleteBody = {
  id?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const bodyRes = await readJson<DeleteBody>(req);
  if (!bodyRes.ok) return bodyRes.response;
  const body = bodyRes.body;
  const projectId = (body.id ?? "").toString().trim();
  if (!projectId) return json({ ok: false, error: "id is required" }, 400);

  // Destructive operation — only owners (or super-admins) can delete.
  const admin = adminClient(envRes.env);
  const owner = await requireOwner(
    admin,
    authRes.user,
    projectId,
    "Only the owner can delete a unit",
  );
  if (!owner.ok) return owner.response;

  // Cascade clean-up. tickets are ON DELETE RESTRICT against places, so we
  // drop them first. project_members and place_links cascade with the place
  // row itself.
  const { error: ticketsErr } = await admin
    .from("tickets")
    .delete()
    .eq("project_id", projectId);
  if (ticketsErr) {
    return json({ ok: false, error: `tickets_delete: ${ticketsErr.message}` }, 500);
  }

  const { error: placeErr } = await admin
    .from("projects_view")
    .delete()
    .eq("id", projectId);
  if (placeErr) {
    return json({ ok: false, error: `place_delete: ${placeErr.message}` }, 500);
  }

  return json({ ok: true, id: projectId });
});
