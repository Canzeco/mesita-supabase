// Shared helper for triggering n8n agent workflows from Edge Functions.
//
// n8n is the "N8N" artificial caller (see the callers taxonomy): it NEVER reads
// or writes the DB — EFs hand it work via an inbound webhook and it calls back
// into EFs to persist. This helper fires that inbound webhook: the workflow's
// Webhook node uses responseMode 'onReceived', so the POST is acknowledged in
// milliseconds while the real (minutes-long) workflow runs asynchronously inside
// n8n. A trigger failure NEVER fails the caller — the row is already created and
// the unit can be re-triggered (it stays content_status='generating').
//
// Config (EF env / Supabase secrets):
//   N8N_BASE_URL        default https://canzeco.app.n8n.cloud
//   N8N_WEBHOOK_SECRET  optional shared secret, sent as X-Webhook-Secret (used
//                       once the n8n webhook is locked down with Header Auth)

const DEFAULT_N8N_BASE = "https://canzeco.app.n8n.cloud";
const TRIGGER_TIMEOUT_MS = 8000;

export async function triggerN8nWorkflow(
  webhookPath: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const base = (Deno.env.get("N8N_BASE_URL") ?? DEFAULT_N8N_BASE).replace(/\/+$/, "");
  const url = `${base}/webhook/${webhookPath}`;
  const secret = Deno.env.get("N8N_WEBHOOK_SECRET");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRIGGER_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(secret ? { "X-Webhook-Secret": secret } : {}),
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : `n8n webhook HTTP ${r.status}` };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : "n8n webhook network error",
    };
  } finally {
    clearTimeout(timer);
  }
}

// Convenience wrapper for the place enricher workflow (enricher-enrich-place).
// Sends { project_id, placeId } — the workflow enriches placeId in FULL and
// persists onto project_id via enricher-update-project-data + enricher-save-place-media.
export function triggerEnrichPlace(
  projectId: string,
  placeId: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  return triggerN8nWorkflow("enrich-place", { project_id: projectId, placeId });
}
