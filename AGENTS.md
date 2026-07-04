# AGENTS.md — Mesita agent instructions

This repo is part of the **Mesita** multi-repo workspace. Every AI coding agent working
here — Cursor, Codex, Claude Code, Claude Cowork, subagents, scheduled cloud agents —
follows the same modus operandi: **SWARM**.

## SWARM — task coordination

All software development work is coordinated in the SWARM Notion database
(Software Work Assignment, Review & Merge):
https://www.notion.so/393a9bf37a528096a20efd3d5514d77c

- Two task types: `Type = Code` (touches a repo; Repo/Branch/PR required; done = PR merged)
  and `Type = Cowork` (research/planning/docs/ops; no repo params; done = output linked in
  `Deliverable` or written in the task's Notes). Claim/blocking/escalation identical for both.
  Keep columns light — rich context goes in `Description` and the task page body as text.
- Code tasks: one task = one branch = one squash PR. Before starting any task, check SWARM;
  ad-hoc requests get a SWARM row first. Out-of-scope discoveries → new rows, not scope creep.
- **Claim:** write `<platform>:<session-slug>` into `Agent` (e.g. `cursor:promos-ui`,
  `codex:refactor-x`, `code:dependabot-admin`), set Status = In progress, then re-read the
  row — if `Agent` isn't you, another agent won the race; pick a different task. Only take
  tasks whose `Blocked by` tasks are all Done.
- Record your branch name (`agent/<slug>`) in `Branch` and the squash PR URL in `PR`.
  `PR` filled + In progress = the task is in review. After merge, set Status = Done.
- Blocked, uncertain, or the decision belongs to Pato → check `Needs Human` and explain
  in a comment. Never guess.
- The full step-by-step checklist lives in SWARM's "New task" template.
- (SWARM agents are NOT Mesita's product AI agents — Enricher/Reservationist live inside
  the product; SWARM agents build it.)

## Core rules

- Reply in English, even when Pato writes in Spanish.
- **Git:** never push directly to `main`. Branch off freshly-pulled `main` → commit small →
  pull `main` back in before merging → squash PR (`gh pr merge --squash --delete-branch`).
- **No local dev servers** (no `pnpm dev` / `next dev`). Verify via Vercel auto-deploy on push.
- **DB access:** Mesita user clients never call the database directly — every read/write
  goes through a Supabase Edge Function.
- **Cloud↔repo sync:** any Supabase (schema/RLS/Edge Function) or n8n cloud change must be
  mirrored into its repo (`mesita-supabase` / `mesita-n8n`) in the same session.
- Deep project context lives in the Notion **Mesita Main** page (read-only):
  https://www.notion.so/Mesita-323a9bf37a528060987ee31c750e3dfa
