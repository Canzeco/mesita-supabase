<!-- GENERATED — mesita-supabase/scripts/sync-rules.ts mirrors this file from CLAUDE.md. Edit CLAUDE.md (below its END marker) or scripts/rules-quickstart.md — NEVER this file. -->
<!-- RULES-QUICKSTART:START (generated — do not hand-edit; run: deno run -A mesita-supabase/scripts/sync-rules.ts) -->
# Mesita — agent quickstart (you're ~90% correct after this)

Stable mirror of the top of the Notion **Rules** page (the master — Notion wins on any conflict). Full page + appendix: https://www.notion.so/Rules-395a9bf37a528081b2c1dacc445bb6c8

Same rules, one Linear ledger, on every platform — only your **platform protocol** (isolation, branch naming, connectors) differs. Find yours: Rules appendix §K "Platform protocols".

| You're reading | You are |
| --- | --- |
| `CLAUDE.md` | Claude Code (local · cloud · subagent) or Claude Cowork |
| `AGENTS.md` | Cursor, Codex, or any open-standard agent — generated from `CLAUDE.md`; hand edits go there |

- **Alone + small fix?** → branch off fresh main, work, PR, merge it yourself, create the one-line issue at merge time (Ops & maintenance). That's the whole loop.
- **Other agents live on the repo?** → full SWARM: pick → claim (`claimed: <platform>:<session-slug> · branch:<actual-branch>`) → isolated checkout → merge.
- **One issue can span repos:** use the SAME branch name `agent/<ISSUE-ID>-<slug>` in every repo it touches, one squash PR per repo (each says `Closes <ID>` or `Part of <ID>`); the issue closes when the last PR merges. No child-issue ceremony for small cross-repo changes.
- **One agent = one isolated checkout = one branch.** Platform-native isolation counts (Desktop/Cursor worktrees, cloud clones). Canonical branch `agent/<ISSUE-ID>-<slug>`; if your platform forces another name (e.g. `cursor/*`), declare it in your claim.
- **Cowork never opens a live repo checkout** — `cowork`-label issues (docs/research/analysis) in non-repo folders only.
- **ALWAYS:** reply in English · clients call Edge Functions, never the DB · never push to `main` · mirror every Supabase cloud change into `mesita-supabase` same session · set terminal status same session · no local dev servers (verify via Vercel).
- **NEVER ask.** Reversible → decide, log a `decision:` comment, ship. Only two `needs-human` cases: a secret you can't enter, or one irreversible money/publish trigger.
- **When in doubt**, hierarchy wins: Pato's live instruction > the Linear issue > Notion > memory.

Where things live: **Linear** (team Mesita, `MESITA-`) = work state · **Notion** = knowledge · **GitHub Canzeco** = code.
<!-- RULES-QUICKSTART:END -->

## This repo — mesita-supabase (DB · RLS · Edge Functions · source of truth)

- **New here? Read [`ARCHITECTURE.md`](./ARCHITECTURE.md)** — the cross-repo system map (audiences, repo topology, EF caller taxonomy, data layer, the Enricher pipeline, agents, billing).
- Run every `supabase` command from **inside this repo**. All Supabase files live only here — kill stray `supabase/` stubs elsewhere (a stray stub links against a divergent migration ledger).
- **EF name = the ACL:** `actor-origin-verb-noun`, exactly one caller per endpoint from the closed set. `_shared/` holds shared code (internal naming free-form). Only `supabase-edgefunc-*` endpoints accept the internal caller; the origin propagates via `X-Internal-Caller`.
- **Mirror + verify:** every cloud change (schema/RLS/EF) mirrors into this repo the same session. After any EF deploy, confirm cloud == repo (`get_edge_function`) — a smoke-test stub once silently clobbered prod.
- **Migrations:** MCP `apply_migration` stamps its own server-side timestamp ≠ the repo filename — reconcile `schema_migrations` after, or the next `db push` re-runs those files. Prod EF deploys + security-sensitive DDL are gated by the harness classifier — attempt a `supabase …` command once cleanly, else hand off a `deploy:` step.
- **Don't "fix" these:** `projects_view` is intentionally `SECURITY DEFINER` (accepted advisor 0010 exception — flipping to invoker hides non-active places from consumer browse); `rls_enabled_no_policy` tables are the deliberate EF-only lockdown (adding policies OPENS access).
- Supabase Realtime is for ticket workflows only. After architectural changes, update `admin_reset_database`. The Enricher is a **cron EF pipeline** (`supabase-cron-enrich-place-{research,analysis,contents}`), not an agent — judge it by DB effects, not green beacons.
- CI: `deno lint · test`. Deno toolchain (no Node build).