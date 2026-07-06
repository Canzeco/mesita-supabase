// staff-web-benchmark-link-strategies
// Diagnostic EF: given one or more venues (name + city), runs the 5 link-discovery
// strategies in linklab/strategies.ts and returns each strategy's {website, instagram}.
// This is the SAME strategy module the local benchmark runner (scripts/linklab/run.ts)
// exercises — so the offline leaderboard reflects exactly what this EF would produce.
//
// Not wired to any client; invoke with a service-role JWT for ad-hoc evaluation, e.g.
//   POST { "venues": [{ "name": "Pujol", "city": "Ciudad de México" }] }
// Keys come from EF secrets: FIRECRAWL_KEY, PERPLEXITY_KEY, GMP_KEY.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { assembleContext } from "../_shared/linklab/context.ts";
import type { Keys } from "../_shared/linklab/providers.ts";
import { runAllStrategies, STRATEGIES } from "../_shared/linklab/strategies.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Venue = { name: string; city: string; country?: string };
type Body = { venues?: Venue[]; name?: string; city?: string; country?: string };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  const keys: Keys = {
    firecrawl: Deno.env.get("FIRECRAWL_KEY") ?? "",
    perplexity: Deno.env.get("PERPLEXITY_KEY") ?? "",
    google: Deno.env.get("GMP_KEY") ?? Deno.env.get("SUPA_GMP_KEY") ?? "",
  };
  if (!keys.firecrawl || !keys.perplexity || !keys.google) {
    return json({ ok: false, error: "Missing FIRECRAWL_KEY / PERPLEXITY_KEY / GMP_KEY secret" }, 500);
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ ok: false, error: "Invalid JSON" }, 400);
  }

  const venues: Venue[] = body.venues?.length
    ? body.venues
    : body.name && body.city
    ? [{ name: body.name, city: body.city, country: body.country }]
    : [];
  if (!venues.length) return json({ ok: false, error: "Provide { venues:[{name,city}] } or { name, city }" }, 400);
  // Hard cap: at most 3 places per message/response.
  if (venues.length > 3) return json({ ok: false, error: "Max 3 venues per call" }, 400);

  const strategies = STRATEGIES.map((s) => ({ id: s.id, name: s.name }));
  const out = [];
  for (const v of venues) {
    const ctx = await assembleContext(keys, v);
    const results = await runAllStrategies(ctx, keys);
    out.push({
      venue: v,
      google_place_id: ctx.google?.placeId ?? null,
      seed_website: ctx.seedWebsite,
      results,
    });
  }

  return json({ ok: true, strategies, count: out.length, out });
});
