# linklab — link-discovery strategy benchmark

Finds the best way to discover a venue's **official website** and **official Instagram** from just
`{name, city}` (+ the Google Place profile it resolves). Five strategies compete; we score each on a
ground-truth set and rank by mean F1 of the two fields.

## Layout

- `supabase/functions/_shared/linklab/` — the reusable engine (imported by BOTH the runner and the EF)
  - `normalize.ts` — URL→host / IG→handle normalization + scoring (TP/TN/FP/FN/WRONG → precision/recall/F1)
  - `providers.ts` — Firecrawl v2 (search+scrape), Perplexity (`/search`, `/v1/agent`, `/v1/chat/completions` sonar-pro), Google Places v1; opt-in disk cache via `LINKLAB_CACHE_DIR`
  - `context.ts` — per-venue context: Google resolve + seed website + one Perplexity SERP summary
  - `strategies.ts` — the 5 strategies + `runAllStrategies`
- `scripts/linklab/run.ts` — local benchmark runner (loads keys from `supabase/.env.local`)
- `scripts/linklab/ground_truth.json` — verified 50-venue truth set
- `supabase/functions/staff-web-benchmark-link-strategies/` — EF wrapper over the same engine

## The strategies

| id | name | retrieval | reasoner | tests |
|----|------|-----------|----------|-------|
| A | Incumbent (control) | Firecrawl search + footer scrape | Perplexity Agent fill | current prod pipeline; baseline |
| B | Pure Agent one-shot | agent-internal browse | Perplexity Agent (`pro-search`) | can the agent alone win? |
| C | FC recall → Sonar judge | Firecrawl search (+ IG `site:` alt) + footer | sonar-pro JSON-schema | cheap retrieval + cheap structured judge (**shipped**) |
| D | PPX-search → Agent validate | Perplexity `/search` | Perplexity Agent | retrieval-provider swap |
| E | Dual fusion + cross-val judge | Firecrawl + PPX-search + footer | sonar-pro cross-validating | kitchen sink |
| F | Pure Sonar judge (`disable_search`) | none (blind) | sonar-pro + `disable_search` | MESITA-192 pure-judge cost/quality variant |

Strategy **C** is production. Run F alone with `--only F` (money-gated; burns Sonar budget).

All strategies skip searching for the website when Google already provides one (like Mesita input),
per the "don't search what you already know" rule.

## Run

```bash
cd mesita-supabase

# small subset while iterating (cache ON by default → re-runs don't re-bill)
deno run --allow-env --allow-net --allow-read --allow-write scripts/linklab/run.ts --limit 10

# full 50 for final numbers
deno run --allow-env --allow-net --allow-read --allow-write scripts/linklab/run.ts

# only some strategies / force live calls
deno run -A scripts/linklab/run.ts --only A,E --no-cache
```

Outputs a leaderboard (per-field accuracy/P/R/F1), the WRONG/FN miss list, a cost line
(per-provider call counts + cache hits), and writes `scripts/linklab/last_results.json`.

## Scoring

Website compared at registrable-host level; Instagram at lowercase-handle level. Correctly
returning `null` for a venue that genuinely has no website counts as correct (TN). A confident-but-
wrong answer is `WRONG` and counts against both precision and recall.

## Scoring the PRODUCTION pipeline (`eval-prod.ts`)

`run.ts` benchmarks the linklab *reimplemented* strategies. To score the **shipped** discovery
pipeline instead — S4 Firecrawl-Search gather → S5 Perplexity **Agent Y** select (`resolveChannels`)
— run `eval-prod.ts`. Use it to iterate the Agent X/Y prompts (MESITA-204) with a scorecard:

```
deno run --allow-env --allow-net --allow-read --allow-write \
  scripts/linklab/eval-prod.ts --limit 5 --concurrency 3
```

It reuses this ground truth + scoring, and breaks out **WRONG (wrong-entity)** vs **FN (killed a
correct link)** separately so you can tune to the rebuild's FP > FN leniency. ⚠️ **Un-cached** —
every run spends real Firecrawl + Perplexity budget, so keep `--limit` small (money-gated per
MESITA-192). Note the ground-truth set is small (n≈50) and famous-venue-optimistic — directional only.
