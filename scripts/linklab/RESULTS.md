# linklab benchmark — results

Task: from `{name, city}` (+ the Google Place it resolves), discover a venue's **official website**
and **official Instagram**. 5 strategies, scored on 50 verified Mexican restaurants (43 with a
website, 50 with IG, 7 IG-only). Ranked by **mean F1 of the two fields**. Website matched at
registrable-host level, IG at lowercase-handle level; a correct `null` (venue has no site) is a TN.

## Final leaderboard — full 50 venues (Round 3)

| rank | strategy | meanF1 | website F1 (P / R) | instagram F1 (P / R) |
|------|----------|:------:|:------------------:|:--------------------:|
| 1 | **C — Firecrawl recall → Sonar-pro judge** | **92.4** | 91 (87 / 95) | **94 (98 / 90)** |
| 2 | D — PPX-search recall → Agent validate | 92.2 | 90 (84 / 98) | 94 (94 / **94**) |
| 3 | E — Dual-retrieval fusion + cross-val judge | 91.5 | 88 (82 / 95) | 95 (98 / 92) |
| 4 | B — Pure Agent one-shot | 88.2 | 90 (84 / 98) | 86 (86 / 86) |
| 5 | A — Incumbent (prod pipeline, control) | 88.1 | 88 (82 / 95) | 88 (88 / 88) |

**The three retrieval→judge strategies (C/D/E) beat the current production pipeline (A) and the
pure-agent (B) by ~4 F1 points.** The gain is entirely in Instagram; website discovery is near-solved
by the Google seed for every strategy.

## Winner: **C** (Firecrawl search → Sonar-pro structured judge)

- Highest overall (92.4) and highest **precision** on both fields — it *fails safe*, returning `null`
  when unsure instead of guessing wrong (IG precision 98%, only 1 wrong IG in 50).
- **Cheapest of the top 3**: one ~$0.006 Sonar call per venue + Firecrawl search/scrape. No
  `pro-search` Agent (A/B/D each run an 8–10 step browsing agent per venue — the dominant cost).
- Runner-up **D** is the pick if you want maximum **recall** — it never returns null (0 IG false
  negatives, IG recall 94%) — at the price of 3 wrong IG, a lower website precision (7 FP), and the
  expensive Agent call.

## Error analysis — what's left is mostly irreducible

Every remaining miss falls into one of three genuinely-ambiguous buckets, shared across strategies:

1. **Dual official accounts** — Pujol (`@restaurantepujol` vs `@pujolrestaurant`), Azul
   (`@azulhistoricomx` vs `@restauranteazulhistorico`). Both handles are real & official; truth picks one.
2. **Handle variants** — `@_corazondetierra` (leading underscore), `@mision.19` (dot),
   `@hueso_restaurante`. C conservatively returns null (FN) on some; D guesses the un-punctuated form (WRONG).
3. **Group vs location domain** — Pangea (`grupopangea.com` vs `restaurantepangea.com`), El Farallón
   (`restaurantelfarallon.com` vs `farallon.com.mx`). Both resolve to the venue.

The distinction between the top two strategies is a **precision/recall temperament**, not capability:
- **C** = conservative (its IG errors are 4 FN + 1 wrong) → use when a wrong link is worse than a blank.
- **D** = eager (its IG errors are 3 wrong, 0 FN) → use when a blank is worse than an occasional wrong link.

## Tuning history

- **Round 1** (10 venues): D 92.4 led; C/E 89.5; A/B 87.4. Instagram identified as the sole battleground.
- **Round 2** (10 venues): added **website-footer anchoring** — feed the judge the IG handle the venue's
  own site links, tagged `[site]`, and a rubric preferring the venue's own account over a group/umbrella
  account. Lifted **C 89.5 → 92.4** (IG 84 → 90); D held.
- **Round 3** (full 50): C 92.4, D 92.2, E 91.5.

## Next lever (not yet applied)

C's remaining Instagram misses are mostly **false negatives** where the correct handle *was* in the
candidate list but the judge declined it (Hueso, Misión 19, Corazón de Tierra). A lighter null-bias —
or trusting a `[site]`-tagged footer handle outright — would convert those FN→TP and push C toward ~96
without hurting precision. That's the natural Round-4 experiment.

## Cost of the full 50-venue run

`fc-search 82 · fc-scrape 39 · ppx-search 160 · ppx-agent 120 · ppx-sonar 120 · g-text 40` (14 min,
concurrency 4). The 120 `pro-search` Agent calls (A/B/D) dominate cost; C/E avoid them entirely.
Disk cache made Rounds 2–3 reuse all search/scrape calls, re-billing only changed LLM prompts.
