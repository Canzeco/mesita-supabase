# Mesita — system architecture

> Cross-repo map of how Mesita fits together. Lives in `mesita-supabase` (the
> backend source of truth) because the workspace root is a pseudo-repo with no
> git remote. **Notion "Rules" wins on any conflict** — this is a stable mirror,
> not the master. Per-repo specifics live in each repo's `CLAUDE.md`.

## What Mesita is

Mesita is a dining/experiences platform for Mexico with three audiences, each its
own Next.js app, over one shared Supabase backend:

- **Consumer** (`consumer.mesita.ai`) — discovery (swipe / map / AI concierge),
  reservations, an at-the-bill instant discount, and a Free/**Premium** class.
- **Business** (`business.mesita.ai`) — the venue console: manage places, team,
  promos, tickets, and a `free`/`pro`/`ultra` **plan**.
- **Admin** (internal) — super-admin console: settings, verifications, the
  Enricher (place-intelligence) config, per-place inspection.

Plus a **landing** site. The platform sells **experiences**, never holds money
(instant discount at the bill — no cashback/wallet), and Mesita only ever earns
via subscriptions (Stripe).

## Repo topology (GitHub org: Canzeco)

| Repo | Role | Stack | Deploy |
|------|------|-------|--------|
| `mesita-supabase` | **Source of truth**: DB schema, RLS, 84 Edge Functions, migrations | Deno / SQL | Supabase cloud |
| `mesita-web-consumer` | Consumer app | Next.js (Node 22+) | Vercel |
| `mesita-web-business` | Business console | Next.js (Node 22+) | Vercel |
| `mesita-web-admin` | Admin console | Next.js (Node 22+) | Vercel |
| `mesita-web-landing` | Marketing site | Next.js | Vercel |
| `mesita-n8n` | **RETIRED** (historical reference only) | — | — |

The workspace root (`~/Desktop/Canzeco/Mesita`) is a convenience checkout of all
repos side by side; it is **not** a committable monorepo (0 commits, no remote).
Consolidating into a real pnpm/Turborepo monorepo is a tracked, **not-yet-decided**
plan (MESITA-141).

Coordination lives in **Linear** (team Mesita, `MESITA-`) = work state · **Notion**
= knowledge · **GitHub** = code.

## The one hard boundary: clients call Edge Functions, never the DB

Every web app reads and writes exclusively through Supabase Edge Functions. No app
holds direct table access — the DB is locked down (RLS enabled, EF-only) and the
service role lives only inside EFs. This is the load-bearing invariant of the
whole system.

### EF naming = the ACL: `actor-origin-verb-noun`

Each endpoint encodes exactly one authorized caller from a **closed set**. The name
*is* the access-control contract.

- **Natural callers** (a real audience): `admin` · `business` · `consumer` · `staff`.
- **Origin** segment: usually `web` (e.g. `consumer-web-get-profile`).
- **Artificial callers** (machine origins): `supabase-cron-*` (the Enricher
  pipeline), `supabase-edgefunc-*` (internal EF→EF, gated by `X-Internal-Caller`),
  plus vendor webhooks like `stripe-webhook-*` and `twilio-*`.
- Natural callers may invoke artificial ones, never the reverse.

Roughly 84 EFs today: business 34 · consumer 24 · admin 18 · plus staff / stripe /
twilio / supabase-cron. `_shared/` holds internal helpers (free-form naming).

## Data layer (Postgres)

Base tables were renamed in the 2026 "R2" pass — the current canonical names:

- **`accounts`** (was businesses) → **`projects`** (was units) → **`places`** (was
  venues). `projects_view` is the consumer-facing browse view and is intentionally
  `SECURITY DEFINER` (accepted advisor exception — do not flip to invoker).
- **Consumers** carry a **class** (`classes` table + `consumers.class_*`);
  **accounts** carry a **plan**. Enum type `membership` is retained.
- Per-place member roles: `owner` / `editor` / `viewer` (enum `member_role`).
- Other domains: tickets (the at-the-bill discount workflow, the only Realtime
  consumer), billing (Stripe subscriptions), verifications, invites, and the
  Enricher's `place_research` staging + `app_settings` config singleton.

RLS note: many tables are deliberately `rls_enabled_no_policy` — that is the
EF-only lockdown, *not* a missing-policy bug. Adding policies would *open* access.

## The Enricher (place intelligence)

Legacy-branded "Atlas" (hence `atlas_*` columns / `atlas-config` routes). It is a
**process, not an agent** — a cron-driven pipeline of three EFs over the
`place_research` stage table, judged by DB effects (not green beacons):

1. **`supabase-cron-enrich-place-research`** — S1 Google identity gate → S2 Apify
   Google Maps reviews/images ‖ Perplexity SERP summary (**Agent X**) → S3 channel
   discovery: per-source Firecrawl **Search** gather (S4) → single Perplexity
   **Agent Y** "Review & Select Links" pass (S5), leniency FP > FN, phone/email
   folded in → Instagram/Facebook gather.
2. **`supabase-cron-enrich-place-contents`** — download verified links' material
   (Apify) + mirror images to storage.
3. **`supabase-cron-enrich-place-analysis`** — vision-describe → rank → synthesize
   the About / category / tags.

A `pg_cron` poller claims staged rows and fires each EF. Config knobs live in
`app_settings` (`atlas_*`), edited from the admin console. **Full runs burn real
Apify/Perplexity/Firecrawl budget** — deploying/arming the cron is money-gated.

## Agents (distinct from the Enricher process)

- **Memo** — consumer AI concierge (`consumer-web-ask-memo`), the Home "Ask AI"
  tab. Perplexity `sonar-pro` + Google Places + the Mesita catalog. Persona
  "Don Memo" (Spanish-first voice).
- **Reservationist** — voice reservations on ElevenLabs (config under
  `integrations/elevenlabs`).

## Billing

Stripe subscriptions only (no money held). Business `pro` / `ultra`, consumer
`premium`. Webhook handled by `stripe-webhook-handle-event`. Going fully live
(real charges, live-mode) is human-gated.

## Working conventions (see the Rules quickstart in every CLAUDE.md)

- **Reply in English.** Branch off fresh `main`; never push to `main`; squash-PR.
- **Mirror every Supabase cloud change into `mesita-supabase` the same session**;
  after any EF deploy verify cloud == repo (a smoke-test stub once clobbered prod).
- Run all `supabase` commands from inside `mesita-supabase` (single migration
  ledger). Prod EF deploys + sensitive DDL are gated.
- **No local dev servers** — verify web apps via their Vercel deploy.
- Light theme + semantic tokens across every web app.
- CI: web apps `lint · typecheck · build` (Node 22+); supabase `deno lint · test`.
