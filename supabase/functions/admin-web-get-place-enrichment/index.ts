// Supabase Edge Function — admin-web-get-place-enrichment (natural caller / admin)
//
// Read-only per-place Enricher inspector for the admin console. Given a
// project_id, returns:
//   • media  — one entry per stored image (keyed by public_url AND source_url,
//     so it resolves whether places.photos[] holds the mirrored URL or the raw
//     source URL when mirroring failed), carrying SOURCE (google/website/
//     instagram), the enricher vision ANALYSIS text, plus the pre-analysis
//     source metadata: caption/likes for Instagram (+ comments/timestamp/video
//     flag) and alt/page/dimensions for website images.
//   • status — enrichment progress for the place: projects.content_status +
//     the place_research stage/status/error + last_enriched_at (the moment the
//     pipeline last reached stage='done').
//
// Internal enricher output — super-admin gated, admin console only. Never
// exposed through a shared business EF.
//
// Local:  supabase functions serve admin-web-get-place-enrichment
// Deploy: supabase functions deploy admin-web-get-place-enrichment

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
  source_metadata: Record<string, unknown> | null;
};

// What the client sees per photo. `position`/`total` are filled in the browser
// from the gallery order — the DB stores no rank, the array order IS the rank.
type MediaMeta = Omit<MediaRow, "public_url">;

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

  const [mediaRes, projectRes, researchRes] = await Promise.all([
    admin
      .from("place_media_assets")
      .select(
        "public_url, source, status, analysis_text, caption, likes_count, source_url, source_metadata",
      )
      .eq("project_id", projectId)
      .order("created_at", { ascending: true }),
    admin
      .from("projects")
      .select("content_status")
      .eq("id", projectId)
      .maybeSingle(),
    admin
      .from("place_research")
      .select("stage, status, error, updated_at")
      .eq("project_id", projectId)
      .maybeSingle(),
  ]);

  if (mediaRes.error) {
    return json({ ok: false, error: `place_media_assets: ${mediaRes.error.message}` }, 500);
  }
  if (projectRes.error) {
    return json({ ok: false, error: `projects: ${projectRes.error.message}` }, 500);
  }
  if (researchRes.error) {
    return json({ ok: false, error: `place_research: ${researchRes.error.message}` }, 500);
  }

  const rows = (mediaRes.data ?? []) as MediaRow[];
  // Keyed by BOTH public_url and source_url so the client resolves a gallery
  // photo whether places.photos[] holds the mirrored URL or (mirror failed) the
  // raw source URL. public_url wins on collision — it's the canonical stored key.
  const media: Record<string, MediaMeta> = {};
  for (const r of rows) {
    const meta: MediaMeta = {
      source: r.source,
      status: r.status,
      analysis_text: r.analysis_text,
      caption: r.caption,
      likes_count: r.likes_count,
      source_url: r.source_url,
      source_metadata: r.source_metadata,
    };
    if (r.source_url && !media[r.source_url]) media[r.source_url] = meta;
    if (r.public_url) media[r.public_url] = meta;
  }

  const research = researchRes.data as
    | {
        stage: string | null;
        status: string | null;
        error: string | null;
        updated_at: string | null;
      }
    | null;

  const status = {
    content_status: (projectRes.data?.content_status ?? null) as string | null,
    stage: research?.stage ?? null,
    stage_status: research?.status ?? null,
    error: research?.error ?? null,
    // The pipeline stamps updated_at on every stage advance; when the row is
    // 'done' that timestamp is the completion time.
    last_enriched_at: research?.stage === "done" ? (research?.updated_at ?? null) : null,
    updated_at: research?.updated_at ?? null,
  };

  return json({ ok: true, media, status, count: rows.length });
});
