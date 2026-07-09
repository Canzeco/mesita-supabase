# Mesita — agent quickstart (you're ~90% correct after this)

Stable mirror of the top of the Notion **Rules** page (the master — Notion wins on any conflict). Full page + appendix: https://www.notion.so/Rules-395a9bf37a528081b2c1dacc445bb6c8

Same rules, one Linear ledger, on every platform — only your **platform protocol** (isolation, branch naming, connectors) differs. Find yours: **Rules — Development §K**. What Mesita IS (product, schema, design): **Rules — Architecture** (Pato owns it; mirror shipped architecture changes there same session).

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
