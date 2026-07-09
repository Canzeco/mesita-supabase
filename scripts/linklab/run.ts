// linklab benchmark runner (local, Deno).
// Loads API keys from supabase/.env.local, resolves per-venue context, runs all 5 strategies
// against the ground-truth set, scores website + instagram, prints a leaderboard.
//
//   deno run --allow-env --allow-net --allow-read --allow-write \
//     scripts/linklab/run.ts [--limit N] [--only A,C] [--concurrency 4] [--no-cache]
//
// Cache lives in scripts/linklab/.cache (per-request JSON) so re-runs don't re-bill.

import { assembleContext, VenueInput } from "../../supabase/functions/_shared/linklab/context.ts";
import { Keys, meter } from "../../supabase/functions/_shared/linklab/providers.ts";
import { runAllStrategies, STRATEGIES } from "../../supabase/functions/_shared/linklab/strategies.ts";
import {
  aggregate,
  FieldOutcome,
  normInstagramHandle,
  normWebsiteHost,
  scoreField,
} from "../../supabase/functions/_shared/linklab/normalize.ts";

type Truth = {
  id: number;
  name: string;
  city: string;
  country?: string;
  website: string | null;
  instagram: string | null;
};

// ---- args -------------------------------------------------------------------
function arg(flag: string): string | null {
  const i = Deno.args.indexOf(flag);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : null;
}
const LIMIT = arg("--limit") ? parseInt(arg("--limit")!, 10) : Infinity;
const ONLY = arg("--only")?.split(",").map((s) => s.trim().toUpperCase()) ?? null;
const CONCURRENCY = arg("--concurrency") ? parseInt(arg("--concurrency")!, 10) : 4;
const NO_CACHE = Deno.args.includes("--no-cache");

const HERE = new URL(".", import.meta.url).pathname;
const REPO = `${HERE}../..`;

if (!NO_CACHE) Deno.env.set("LINKLAB_CACHE_DIR", `${HERE}.cache`);

// ---- keys from supabase/.env.local -----------------------------------------
function loadKeys(): Keys {
  const raw = Deno.readTextFileSync(`${REPO}/supabase/.env.local`);
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const firecrawl = env.FIRECRAWL_KEY ?? "";
  const perplexity = env.PERPLEXITY_KEY ?? "";
  const google = env.GMP_KEY ?? env.SUPA_GMP_KEY ?? "";
  if (!firecrawl || !perplexity || !google) {
    console.error("Missing keys in supabase/.env.local:", {
      firecrawl: !!firecrawl,
      perplexity: !!perplexity,
      google: !!google,
    });
    Deno.exit(1);
  }
  return { firecrawl, perplexity, google };
}

// ---- run --------------------------------------------------------------------
type VenueRow = {
  truth: Truth;
  placeIdResolved: boolean;
  results: Record<string, { website: string | null; instagram: string | null }>;
};

async function mapPool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const keys = loadKeys();
  const truthAll: Truth[] = JSON.parse(
    Deno.readTextFileSync(`${HERE}ground_truth.json`),
  );
  const truth = truthAll.slice(0, LIMIT);
  const strategyIds = STRATEGIES.map((s) => s.id).filter((id) => !ONLY || ONLY.includes(id));

  meter.reset();
  const started = performance.now();
  console.log(
    `\nlinklab — ${truth.length} venues x ${strategyIds.length} strategies` +
      `${NO_CACHE ? " (cache OFF)" : " (cache ON)"}\n`,
  );

  const rows = await mapPool(truth, CONCURRENCY, async (t) => {
    const v: VenueInput = { name: t.name, city: t.city, country: t.country };
    const ctx = await assembleContext(keys, v);
    const all = await runAllStrategies(ctx, keys);
    const results: VenueRow["results"] = {};
    for (const id of strategyIds) results[id] = { website: all[id]?.website ?? null, instagram: all[id]?.instagram ?? null };
    process_tick(t.name);
    return { truth: t, placeIdResolved: !!ctx.google, results } as VenueRow;
  });

  // ---- score ----
  const perStrat: Record<string, { web: FieldOutcome[]; ig: FieldOutcome[] }> = {};
  for (const id of strategyIds) perStrat[id] = { web: [], ig: [] };

  const misses: string[] = [];
  for (const row of rows) {
    const tW = normUrl(row.truth.website);
    const tI = normIg(row.truth.instagram);
    for (const id of strategyIds) {
      const pW = normUrl(row.results[id].website);
      const pI = normIg(row.results[id].instagram);
      const oW = scoreField(pW, tW);
      const oI = scoreField(pI, tI);
      perStrat[id].web.push(oW);
      perStrat[id].ig.push(oI);
      if (oW === "WRONG" || oW === "FN" || oI === "WRONG" || oI === "FN") {
        misses.push(
          `  [${id}] ${row.truth.name} (${row.truth.city}) ` +
            `web:${oW}(${pW ?? "∅"} vs ${tW ?? "∅"}) ig:${oI}(${pI ?? "∅"} vs ${tI ?? "∅"})`,
        );
      }
    }
  }

  // ---- leaderboard ----
  console.log("\n================= LEADERBOARD (mean F1 of website+instagram) =================");
  const board = strategyIds
    .map((id) => {
      const w = aggregate(perStrat[id].web);
      const i = aggregate(perStrat[id].ig);
      const meanF1 = (w.f1 + i.f1) / 2;
      return { id, name: STRATEGIES.find((s) => s.id === id)!.name, w, i, meanF1 };
    })
    .sort((a, b) => b.meanF1 - a.meanF1);

  for (const b of board) {
    console.log(
      `\n[${b.id}] ${b.name}  —  meanF1 ${(b.meanF1 * 100).toFixed(1)}`,
    );
    console.log(
      `     website : acc ${pct(b.w.accuracy)}  P ${pct(b.w.precision)}  R ${pct(b.w.recall)}  F1 ${pct(b.w.f1)}` +
        `  (tp${b.w.tp} wrong${b.w.wrong} fn${b.w.fn} fp${b.w.fp} tn${b.w.tn})`,
    );
    console.log(
      `     instagram: acc ${pct(b.i.accuracy)}  P ${pct(b.i.precision)}  R ${pct(b.i.recall)}  F1 ${pct(b.i.f1)}` +
        `  (tp${b.i.tp} wrong${b.i.wrong} fn${b.i.fn} fp${b.i.fp} tn${b.i.tn})`,
    );
  }

  console.log("\n================= MISSES (WRONG / FN) =================");
  console.log(misses.length ? misses.join("\n") : "  none");

  const secs = ((performance.now() - started) / 1000).toFixed(0);
  const resolved = rows.filter((r) => r.placeIdResolved).length;
  // MESITA-192: rough $ estimate for strategy C (shipped) vs full suite.
  // Rates are order-of-magnitude list prices — directional, not invoices.
  const UNIT = {
    firecrawlSearch: 0.001, // ~$1/1k searches (Firecrawl search)
    firecrawlScrape: 0.001,
    perplexitySearch: 0.005,
    perplexityAgent: 0.03, // pro-search agent dominates
    perplexitySonar: 0.006, // sonar-pro structured
    googleText: 0.032, // Places Text Search
  };
  const estUsd =
    meter.firecrawlSearch * UNIT.firecrawlSearch +
    meter.firecrawlScrape * UNIT.firecrawlScrape +
    meter.perplexitySearch * UNIT.perplexitySearch +
    meter.perplexityAgent * UNIT.perplexityAgent +
    meter.perplexitySonar * UNIT.perplexitySonar +
    meter.googleText * UNIT.googleText;
  const perVenue = rows.length ? estUsd / rows.length : 0;
  // Strategy C alone ≈ 2–3 fc-search + 1 scrape + 1 sonar (+ shared g-text once)
  const cPerVenueUsd = 3 * UNIT.firecrawlSearch + UNIT.firecrawlScrape + UNIT.perplexitySonar;

  console.log("\n================= COST / RUN =================");
  console.log(`  venues: ${rows.length}  (google-resolved ${resolved}/${rows.length})   time ${secs}s`);
  console.log(
    `  calls  fc-search ${meter.firecrawlSearch}  fc-scrape ${meter.firecrawlScrape}  ` +
      `ppx-search ${meter.perplexitySearch}  ppx-agent ${meter.perplexityAgent}  ` +
      `ppx-sonar ${meter.perplexitySonar}  g-text ${meter.googleText}  cache-hits ${meter.cacheHits}`,
  );
  console.log(
    `  est $  suite ~$${estUsd.toFixed(2)}  (~$${perVenue.toFixed(3)}/venue)  |  ` +
      `strategy C alone ~$${cPerVenueUsd.toFixed(3)}/venue (excl. shared Google resolve)`,
  );

  // persist raw results for inspection
  const out = { generatedAtNote: "stamp externally", board: board.map((b) => ({ id: b.id, name: b.name, meanF1: b.meanF1, website: b.w, instagram: b.i })), rows };
  Deno.writeTextFileSync(`${HERE}last_results.json`, JSON.stringify(out, null, 2));
  console.log(`\n  wrote ${HERE}last_results.json\n`);
}

function normUrl(u: string | null): string | null {
  return normWebsiteHost(u);
}
function normIg(u: string | null): string | null {
  return normInstagramHandle(u);
}
function pct(x: number): string {
  return (x * 100).toFixed(0).padStart(3) + "%";
}
let done = 0;
function process_tick(name: string) {
  done++;
  console.log(`  [${done}] done: ${name}`);
}

main().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
