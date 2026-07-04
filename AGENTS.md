# AGENTS.md — Mesita agent instructions

This repo is part of the **Mesita** multi-repo workspace. Every AI coding agent working
here — Cursor, Codex, Claude Code, Claude Cowork, subagents, scheduled cloud agents —
follows the same modus operandi: **SWARM**.

## SWARM — task coordination (Linear)

All work by AI agents is coordinated in **Linear** (workspace `canzeco`, team **Mesita**,
issue key `MESITA-`) under the **SWARM** protocol (Software Work Assignment, Review & Merge). Linear holds all
management (Initiatives → Projects → Issues); Notion holds knowledge (issues link to Notion
pages). Full protocol doc:
https://linear.app/canzeco/document/swarm-protocol-ai-agent-modus-operandi-442de3edc517

- Two task types via labels: `code` (touches a repo; one issue = one branch = one squash PR;
  done = merged) and `cowork` (research/planning/docs/ops; done = deliverable link posted in
  a comment). Keep issues thin — rich context in the description as natural text.
- **Pick & claim:** take the highest-priority unblocked Todo issue without `needs-human`.
  Move it to In Progress and immediately comment `claimed: <platform>:<session-slug>`
  (e.g. `claimed: cursor:promos-ui`, `claimed: code:dependabot-admin`). Then re-read the
  comments — if an earlier claim by someone else exists, back off and pick another issue.
- **Code flow:** branch off freshly-pulled `main` as `agent/<ISSUE-ID>-<slug>` (the issue ID
  in the branch name auto-links GitHub↔Linear). Ship via squash PR with `Closes <ISSUE-ID>`
  in the PR description — Linear moves the issue through In Review and closes it on merge
  (`gh pr merge --squash --delete-branch`).
- Ad-hoc requests get a Linear issue first, then work starts. Out-of-scope discoveries
  become new issues — never scope creep.
- Blocked, uncertain, or the decision belongs to Pato → add the `needs-human` label, assign
  Pato, comment why, and stop. Never guess.
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
