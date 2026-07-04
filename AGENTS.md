# AGENTS.md — Mesita agent instructions

This repo is part of the **Mesita** multi-repo workspace. Every AI coding agent working
here — Cursor, Codex, Claude Code, Claude Cowork, subagents, scheduled cloud agents —
follows the same orchestration protocol: **SWARM v3** (a blackboard system: agents never
talk to each other; they coordinate through the Linear work ledger and git).

## SWARM v3 — orchestration (Linear)

Work ledger: **Linear**, workspace `canzeco`, team **Mesita**, issue key `MESITA-`.
Full protocol: https://linear.app/canzeco/document/swarm-protocol-ai-agent-modus-operandi-442de3edc517

- **Pato never opens Linear.** You are the interface; Linear is the database. Never ask
  him to check or update it — summarize in chat instead.
- **If it writes to a repo or a cloud service, it has an issue — and every issue lives in
  a project.** Ad-hoc request → silently create/attach the project, create the issue
  (title, repo label, footprint = paths you expect to touch), claim it, work it. Pure Q&A
  needs no issue. Don't narrate the bookkeeping.
- **Projects = goals, not sessions.** One project = one outcome, named after the outcome,
  linking its Notion spec. New goal → new project by default, but check existing projects
  first and attach if the goal continues one. Sessions may span several projects; several
  sessions may share one. One-off chores → the standing **Ops & maintenance** project.
  Keep project status current; mark Completed when the outcome ships.
- **Boot** (before touching any repo): resume your own open claims; scan `needs-human`
  issues and surface a one-line summary to Pato if any exist.
- **Pick:** highest-priority unblocked Todo without `needs-human` whose footprint doesn't
  overlap an active claim. **Claim:** move to In Progress + comment
  `claimed: <platform>:<session-slug>`; re-read comments — an earlier claim wins, back off.
- **Lease:** claims with no comment/commit for 4h are stale — take over with a
  `takeover: <your-id> (stale >4h)` comment. Post progress comments on long tasks.
- **Code flow:** branch `agent/<ISSUE-ID>-<slug>` off freshly-pulled `main` → small
  commits, push early → pull `main` back in, resolve, re-test → squash PR with
  `Closes <ISSUE-ID>` → **merge it yourself** (`gh pr merge --squash --delete-branch`).
  Don't wait for Pato. Whoever merges second resolves conflicts. Never push `main`.
- **Cowork flow:** do the work, post the deliverable link/results in a comment, Done.
- **Fan-out:** ≥3 independent units or >1 repo → split into child issues (blocked-by
  wiring) and run parallel subagents in isolated git worktrees, one issue each (≤5).
- **Escalate to Pato ONLY for:** contradictory high-level instructions; irreversible or
  destructive ops (prod data, deletions, spend, external publishing); credentials/OAuth;
  undocumented product decisions. Then: label `needs-human`, assign Pato, comment — and
  ask him in chat if he's present. Everything else: decide, log a `decision:` comment,
  proceed.
- **Hierarchy:** Pato live > Linear issue > Notion specs > memory/conventions.
- Out-of-scope discoveries → new issues, never scope creep.

## Core rules

- Reply in English, even when Pato writes in Spanish.
- **No local dev servers** (no `pnpm dev` / `next dev`). Verify via Vercel auto-deploy on push.
- **DB access:** Mesita user clients never call the database directly — every read/write
  goes through a Supabase Edge Function.
- **Cloud↔repo sync:** any Supabase (schema/RLS/Edge Function) or n8n cloud change must be
  mirrored into its repo (`mesita-supabase` / `mesita-n8n`) in the same session.
- Deep project context lives in the Notion **Mesita Main** page (read-only):
  https://www.notion.so/Mesita-323a9bf37a528060987ee31c750e3dfa
- (SWARM agents build Mesita; Enricher/Reservationist are product agents inside Mesita.)
