// Supabase Edge Function — atlas-enrich-event (artificial caller / agent)
//
// ADEA (Atlas Data Enrichment Agent) enrichment for EVENT entities — the
// sibling of atlas-enrich-place. A unit may contain an event; this is where
// its qualitative profile enrichment will live.
//
// STUB: not yet implemented. Returns 501 so callers fail loudly instead of
// silently no-op'ing. Implement alongside the event entity work.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

Deno.serve(() =>
  new Response(
    JSON.stringify({ ok: false, error: "atlas-enrich-event not implemented yet" }),
    { status: 501, headers: { "Content-Type": "application/json" } },
  )
);
