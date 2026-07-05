// Supabase Edge Function — admin-web-get-place-media (natural caller / admin)
//
// Read-only per-photo Enricher metadata for the admin console Place gallery.
// Given a project_id, returns one row per stored image in place_media_assets
// keyed by public_url (which matches the URLs in places.photos[]), carrying the
// image SOURCE (google / website / instagram) and the enricher's vision
// ANALYSIS text, plus caption + likes for Instagram assets.
//
// Internal enricher output — super-admin gated, admin console only. Never
// exposed through a shared business EF.
//
// Local:  supabase functions serve admin-web-get-place-media
// Deploy: supabase functions deploy admin-web-get-place-media

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsPreflight, json, readJson } from "../_shared/http.ts";
import {
  adminClient,
  getAuthedUser,
  readEFEnv,
  requireSuperAdmin,
} from "../_shared/auth.ts";

type Body = { projectId?: string; placeId?: string };

type MediaRow = {
  public_url: string | null;
  source: string | null;
  status: string | null;
  analysis_text: string | null;
  caption: string | null;
  likes_count: number | null;
  source_url: string | null;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return corsPreflight();
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const envRes = readEFEnv();
  if (!envRes.ok) return envRes.response;
  const authRes = await getAuthedUser(req, envRes.env);
  if (!authRes.ok) return authRes.response;

  const admin = adminClient(envRes.env);
  const saRes = await requireSuperAdmin(admin, authRes.user);
  if (!saRes.ok) return saRes.response;

  const bodyRes = await readJson<Body>(req);
  if (!bodyRes.ok) return bodyRes.response;
  // placeId is the MESITA-26 alias for the place-row id (== project_id here).
  const projectId = (bodyRes.body.projectId ?? bodyRes.body.placeId ?? "").trim();
  if (!projectId) return json({ ok: false, error: "Missing projectId" }, 400);

  const { data, error } = await admin
    .from("place_media_assets")
    .select(
      "public_url, source, status, analysis_text, caption, likes_count, source_url",
    )
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  if (error) return json({ ok: false, error: `place_media_assets: ${error.message}` }, 500);

  const rows = (data ?? []) as MediaRow[];
  // Keyed by public_url so the client can look up metadata per gallery photo.
  const media: Record<string, Omit<MediaRow, "public_url">> = {};
  for (const r of rows) {
    if (!r.public_url) continue;
    media[r.public_url] = {
      source: r.source,
      status: r.status,
      analysis_text: r.analysis_text,
      caption: r.caption,
      likes_count: r.likes_count,
      source_url: r.source_url,
    };
  }

  return json({ ok: true, media, count: Object.keys(media).length });
});
