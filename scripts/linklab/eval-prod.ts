// Agent Y prompt eval (MESITA-204) — scores the PRODUCTION discovery pipeline.
//
// Unlike run.ts (which benchmarks the linklab reimplemented strategies), this
// runner calls the SHIPPED `resolveChannels` — S4 Firecrawl-Search gather → S5
// Perplexity Agent Y "Review & Select Links" — against the ground-truth set and
// scores website + instagram. Use it to iterate the Agent Y (and Agent X) prompts
// in `_shared/enrich-channel-discovery.ts` with a scorecard instead of by feel.
//
//   deno run --allow-env --allow-net --allow-read --allow-write \
//     scripts/linklab/eval-prod.ts [--limit N] [--concurrency 3]
//
// ⚠️ BUDGET: this is UN-CACHED — every run spends real Firecrawl + Perplexity on
// every venue (resolveChannels calls the providers directly, no cache layer).
// Keep --limit small while iterating a prompt. Needs a Pato go-ahead like any
// live-budget run (MESITA-192).
//
// Leniency lens (the whole point of the rebuild): FALSE POSITIVES > FALSE
// NEGATIVES. The summary breaks out WRONG (wrong-entity) vs FN (killed a correct
// one) separately — a good prompt drives FN toward zero even if WRONG ticks up.

import { resolveChannels } from "../../supabase/functions/_shared/enrich-channel-discovery.ts";
import {
  aggregate,
  type FieldOutcome,
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

// Mirror the app_settings defaults from 20260707000000_enricher_discovery_knobs.sql
// so the eval reflects the shipped per-source gather depth.
const DISCOVER_DEFAULTS = {
  website_url: 5,
  instagram_url: 5,
  facebook_url: 5,
  opentable_url: 3,
  uber_eats_url: 2,
};

function arg(flag: string): string | null {
  const i = Deno.args.indexOf(flag);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : null;
}
const LIMIT = arg("--limit") ? parseInt(arg("--limit")!, 10) : Infinity;
const CONCURRENCY = arg("--concurrency") ? parseInt(arg("--concurrency")!, 10) : 3;

const HERE = new URL(".", import.meta.url).pathname;
const REPO = `${HERE}../..`;

function loadKeys(): { firecrawl: string; perplexity: string } {
  const raw = Deno.readTextFileSync(`${REPO}/supabase/.env.local`);
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const firecrawl = env.FIRECRAWL_KEY ?? "";
  const perplexity = env.PERPLEXITY_KEY ?? "";
  if (!firecrawl || !perplexity) {
    console.error("Missing keys in supabase/.env.local:", {
      firecrawl: !!firecrawl,
      perplexity: !!perplexity,
    });
    Deno.exit(1);
  }
  return { firecrawl, perplexity };
}

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

function pct(x: number): string {
  return (x * 100).toFixed(0).padStart(3) + "%";
}

async function main() {
  const keys = loadKeys();
  const truthAll: Truth[] = JSON.parse(Deno.readTextFileSync(`${HERE}ground_truth.json`));
  const truth = truthAll.slice(0, LIMIT);

  console.log(
    `\nAgent Y prod eval — ${truth.length} venues (UN-CACHED, spends budget)\n`,
  );
  const started = performance.now();

  let done = 0;
  const rows = await mapPool(truth, CONCURRENCY, async (t) => {
    const resolved = await resolveChannels({
      firecrawlKey: keys.firecrawl,
      perplexityKey: keys.perplexity,
      name: t.name,
      city: t.city,
      locationLine: [t.city, t.country].filter(Boolean).join(", "),
      category: null,
      discoverCandidates: DISCOVER_DEFAULTS,
      // Nothing seeded — force full discovery so we score the gather + Agent Y.
      have: {
        instagram: null,
        facebook: null,
        website: null,
        opentable: null,
        uberEats: null,
      },
    });
    console.log(`  [${++done}] ${t.name}`);
    return { truth: t, website: resolved.website_url, instagram: resolved.instagram_url };
  });

  const web: FieldOutcome[] = [];
  const ig: FieldOutcome[] = [];
  const misses: string[] = [];
  for (const r of rows) {
    const tW = normWebsiteHost(r.truth.website);
    const tI = normInstagramHandle(r.truth.instagram);
    const pW = normWebsiteHost(r.website);
    const pI = normInstagramHandle(r.instagram);
    const oW = scoreField(pW, tW);
    const oI = scoreField(pI, tI);
    web.push(oW);
    ig.push(oI);
    if (oW === "WRONG" || oW === "FN" || oI === "WRONG" || oI === "FN") {
      misses.push(
        `  ${r.truth.name} (${r.truth.city})  web:${oW}(${pW ?? "∅"} vs ${tW ?? "∅"})  ig:${oI}(${pI ?? "∅"} vs ${tI ?? "∅"})`,
      );
    }
  }

  const w = aggregate(web);
  const i = aggregate(ig);
  console.log("\n================= AGENT Y — PROD PIPELINE =================");
  console.log(`  meanF1 ${(((w.f1 + i.f1) / 2) * 100).toFixed(1)}`);
  console.log(
    `  website : acc ${pct(w.accuracy)}  P ${pct(w.precision)}  R ${pct(w.recall)}  F1 ${pct(w.f1)}` +
      `  (tp${w.tp} WRONG${w.wrong} FN${w.fn} fp${w.fp} tn${w.tn})`,
  );
  console.log(
    `  instagram: acc ${pct(i.accuracy)}  P ${pct(i.precision)}  R ${pct(i.recall)}  F1 ${pct(i.f1)}` +
      `  (tp${i.tp} WRONG${i.wrong} FN${i.fn} fp${i.fp} tn${i.tn})`,
  );
  // FP > FN lens: a well-tuned prompt keeps FN (killed-a-correct-link) near zero.
  console.log(
    `\n  FP>FN check — killed-correct (FN): web ${w.fn} · ig ${i.fn}   |   wrong-entity (WRONG): web ${w.wrong} · ig ${i.wrong}`,
  );

  console.log("\n================= MISSES (WRONG / FN) =================");
  console.log(misses.length ? misses.join("\n") : "  none");

  const secs = ((performance.now() - started) / 1000).toFixed(0);
  console.log(`\n  venues ${rows.length}   time ${secs}s`);
  Deno.writeTextFileSync(
    `${HERE}last_eval_prod.json`,
    JSON.stringify({ note: "stamp externally", website: w, instagram: i, rows }, null, 2),
  );
  console.log(`  wrote ${HERE}last_eval_prod.json\n`);
}

main().catch((e) => {
  console.error(e);
  Deno.exit(1);
});
