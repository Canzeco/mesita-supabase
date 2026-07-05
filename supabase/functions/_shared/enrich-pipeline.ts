// Enricher v2 pipeline plumbing — the place_research stage machine.
//
// The Enricher is a PROCESS (not an agent): a cron-driven pipeline of three
// Edge Functions over public.place_research:
//
//   stage 'research'  → supabase-cron-enrich-place-research   (S1–S4 gather)
//   stage 'analysis'  → supabase-cron-enrich-place-analysis   (S5–S6 images)
//   stage 'contents'  → supabase-cron-enrich-place-contents   (S7–S9 persist)
//   stage 'done' | 'failed' — terminal.
//
// The SQL poller (run_place_enrichment_stages, pg_cron) claims pending rows
// per stage and fires ONE net.http_post per row at the matching EF with
// { project_id }. Each EF acks 200 immediately, does its stage's work in an
// EdgeRuntime.waitUntil background task, and finishes by advancing the row
// (advanceResearchStage) or failing it (failResearchRow). A crashed stage
// leaves the row 'running'; the poller's reaper flips it back to 'pending'
// after the lease window (attempts capped → stage 'failed').
//
// Payload contracts between stages live in the jsonb columns:
//   gathered  — research output: partial place update + grounding + image pools
//   analysis  — analysis output: ranked/selected photos + per-image descriptions
//
// Beacons: each stage INSERTs place_enrichment_events rows directly (we're
// already service-role inside an EF — no HTTP hop), keeping the admin console
// notifications feed identical to the n8n Enricher's S1–S9 step semantics.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { MediaAssetPayload } from "./enrich-config.ts";

export type ResearchStage = "research" | "analysis" | "contents" | "done" | "failed";

export type PlaceResearchRow = {
  project_id: string;
  google_place_id: string;
  stage: ResearchStage;
  status: "pending" | "running";
  attempts: number;
  gathered: GatheredPayload | null;
  analysis: AnalysisPayload | null;
  error: string | null;
};

// ── Stage payloads ───────────────────────────────────────────────────────────

// Research output. `place` carries only the columns research itself resolved
// (channels, contacts, reviews, follower counts, verified IG…) — the contents
// stage merges synthesis on top and persists the union.
export type GatheredPayload = {
  place: Record<string, unknown>;
  grounding: {
    igBio: string;
    googleReviewsText: string;
    siteMarkdown: string;
    serpSummary: string | null;
  };
  images: {
    google: string[];
    website: string[];
    instagram: string[];
    existingPhotos: string[];
  };
  // Maps serialised as plain objects (jsonb has no Map).
  instagramAssetMeta: Record<string, {
    likes_count: number | null;
    caption: string | null;
    source_metadata: Record<string, unknown>;
  }>;
  websiteAssetMeta: Record<string, Record<string, unknown>>;
  locationLine: string;
  sources: Record<string, unknown>;
};

export type AnalysisPayload = {
  finalPhotos: string[];
  saved: { url: string; source: "google" | "website" | "instagram" }[];
  imageAnalysisByUrl: Record<string, string>;
  diag: Record<string, unknown>;
};

// ── Row lifecycle ────────────────────────────────────────────────────────────

// Seed (or re-seed) the pipeline row for a project. Called by the create EFs
// right after the minimal 'generating' place lands. Upsert: re-creating a
// place (or manually re-enriching) resets the row to the research stage.
export async function seedPlaceResearch(
  admin: SupabaseClient,
  projectId: string,
  googlePlaceId: string,
  createdBy: string,
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await admin.from("place_research").upsert({
    project_id: projectId,
    google_place_id: googlePlaceId,
    stage: "research",
    status: "pending",
    attempts: 0,
    gathered: null,
    analysis: null,
    error: null,
    created_by: createdBy,
    updated_at: new Date().toISOString(),
  }, { onConflict: "project_id" });
  return error ? { ok: false, error: error.message } : { ok: true };
}

// Load the row a stage EF was invoked for, verifying it is actually claimed at
// the expected stage (guards against duplicate/stale pokes from the poller).
export async function loadClaimedRow(
  admin: SupabaseClient,
  projectId: string,
  stage: ResearchStage,
): Promise<{ ok: true; row: PlaceResearchRow } | { ok: false; reason: string }> {
  const { data, error } = await admin
    .from("place_research")
    .select("project_id, google_place_id, stage, status, attempts, gathered, analysis, error")
    .eq("project_id", projectId)
    .maybeSingle();
  if (error) return { ok: false, reason: `row_read: ${error.message}` };
  if (!data) return { ok: false, reason: "row_not_found" };
  const row = data as PlaceResearchRow;
  if (row.stage !== stage) return { ok: false, reason: `stage_mismatch: row is at '${row.stage}'` };
  if (row.status !== "running") return { ok: false, reason: `not_claimed: status '${row.status}'` };
  return { ok: true, row };
}

// Advance to the next stage (attempts reset; status back to 'pending' so the
// next poller tick picks it up) or land the terminal 'done'.
export async function advanceResearchStage(
  admin: SupabaseClient,
  projectId: string,
  nextStage: ResearchStage,
  patch: Partial<{ gathered: GatheredPayload; analysis: AnalysisPayload }> = {},
): Promise<void> {
  const { error } = await admin
    .from("place_research")
    .update({
      stage: nextStage,
      status: "pending",
      attempts: 0,
      error: null,
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", projectId);
  if (error) console.error(`[enrich-pipeline] advance→${nextStage}:`, error.message);
}

// Release a row after a soft failure: back to 'pending' at the SAME stage so
// the poller retries it (attempts was bumped at claim time; the poller's cap
// turns a repeat offender into stage 'failed').
export async function releaseResearchRow(
  admin: SupabaseClient,
  projectId: string,
  errorMsg: string,
): Promise<void> {
  const { error } = await admin
    .from("place_research")
    .update({ status: "pending", error: errorMsg.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("project_id", projectId);
  if (error) console.error("[enrich-pipeline] release:", error.message);
}

// Hard-fail a row (non-retryable, e.g. Google spine incomplete): terminal
// stage 'failed' + flip the project's content_status so the place doesn't
// strand at 'generating'.
export async function failResearchRow(
  admin: SupabaseClient,
  projectId: string,
  errorMsg: string,
): Promise<void> {
  const { error } = await admin
    .from("place_research")
    .update({ stage: "failed", status: "pending", error: errorMsg.slice(0, 500), updated_at: new Date().toISOString() })
    .eq("project_id", projectId);
  if (error) console.error("[enrich-pipeline] fail:", error.message);
  const { error: projErr } = await admin
    .from("projects")
    .update({ content_status: "failed" })
    .eq("id", projectId);
  if (projErr) console.error("[enrich-pipeline] fail content_status:", projErr.message);
}

// ── Step beacons ─────────────────────────────────────────────────────────────

// Direct INSERT into place_enrichment_events (same contract as the retired
// enricher-agent-report-step EF, minus the HTTP hop). Best-effort: a beacon
// failure never breaks an enrichment run.
export async function reportEnrichmentStep(
  admin: SupabaseClient,
  projectId: string,
  step: `S${number}`,
  stepName: string,
  status: "started" | "completed" | "failed" | "skipped",
  detail: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await admin.from("place_enrichment_events").insert({
      project_id: projectId,
      step,
      step_name: stepName.slice(0, 80),
      status,
      detail: detail.slice(0, 500),
      meta,
    });
    if (error) console.error(`[enrich-pipeline] beacon ${step}:`, error.message);
  } catch (err) {
    console.error(`[enrich-pipeline] beacon ${step}:`, err instanceof Error ? err.message : err);
  }
}

// ── Misc shared bits ─────────────────────────────────────────────────────────

// Serialise a Map to a jsonb-safe plain object.
export function mapToObject<V>(m: Map<string, V> | null | undefined): Record<string, V> {
  const out: Record<string, V> = {};
  if (m) for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

// Build the media-asset payload rows for enricher-agent-store-place-images from
// the analysis output + research metadata.
export function buildMediaAssets(
  gathered: GatheredPayload,
  analysis: AnalysisPayload,
): MediaAssetPayload[] {
  return analysis.saved.map((img) => {
    const im = gathered.instagramAssetMeta[img.url];
    const wm = gathered.websiteAssetMeta[img.url];
    return {
      source: img.source,
      source_url: img.url,
      likes_count: im?.likes_count ?? null,
      caption: im?.caption ?? null,
      analysis: analysis.imageAnalysisByUrl[img.url] ?? null,
      source_metadata: im?.source_metadata ?? wm ?? null,
    };
  });
}

// Run a stage's work as an EdgeRuntime background task (ack-early pattern —
// the poller's HTTP call returns immediately; the wall clock still applies).
export function runInBackground(task: Promise<unknown>): void {
  const edgeRuntime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(task);
  else void task;
}
