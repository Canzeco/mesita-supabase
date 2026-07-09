#!/usr/bin/env -S deno run --allow-read --allow-write
// sync-rules.ts — regenerate BOTH agent-instruction dialects in every workspace repo
// from ONE canonical source (scripts/rules-quickstart.md).
//
// CONTRACT (one hand-edited file per repo):
//   CLAUDE.md = generated quickstart block (between the markers below) + hand-written
//               "## This repo …" tail below the END marker. Edit the tail freely.
//   AGENTS.md = FULLY GENERATED: a notice line + a byte-exact copy of the final
//               CLAUDE.md, so Cursor/Codex read the same content. NEVER hand-edit it.
//
// SOURCE OF TRUTH: the Notion **Rules** page §0 is the human master. When it changes,
// update scripts/rules-quickstart.md to match, then run (from mesita-supabase):
//     deno task sync-rules
// Pass --check to verify without writing (STRICT: drift, skips, or bad markers exit 1).
// Pass --only <label> to target one repo; --workspace <path> to override the workspace
// root (needed when running against relocated worktrees, e.g. /tmp/worktrees/<ID>).
//
// Worktree conflicts on these files: regenerate (run this script), never hand-merge.
// Adding a repo = one REPOS entry. Monorepo cutover (MESITA-341) = delete the fenced
// standalone group below.

import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const START =
  "<!-- RULES-QUICKSTART:START (generated — do not hand-edit; run: deno run -A mesita-supabase/scripts/sync-rules.ts) -->";
const END = "<!-- RULES-QUICKSTART:END -->";
const AGENTS_NOTICE =
  "<!-- GENERATED — mesita-supabase/scripts/sync-rules.ts mirrors this file from CLAUDE.md. Edit CLAUDE.md (below its END marker) or scripts/rules-quickstart.md — NEVER this file. -->";

const scriptDir = dirname(fromFileUrl(import.meta.url));
const supabaseRoot = dirname(scriptDir);

const rawArgs = [...Deno.args];
const check = rawArgs.includes("--check");
function flagValue(flag: string): string | undefined {
  const i = rawArgs.indexOf(flag);
  return i === -1 ? undefined : rawArgs[i + 1];
}
const only = flagValue("--only");
const workspaceOverride = flagValue("--workspace");
const workspace = workspaceOverride ?? dirname(supabaseRoot);

// Sanity guard (derived workspace only): the layout must look like the Mesita
// workspace — a script run from a relocated worktree would otherwise silently
// mis-derive the workspace and skip everything.
if (!workspaceOverride) {
  try {
    await Deno.stat(join(workspace, "mesita-supabase", "scripts", "rules-quickstart.md"));
  } catch {
    console.error(
      `workspace mis-derived (${workspace}) — run with --workspace <path-to-workspace-root>`,
    );
    Deno.exit(1);
  }
}

const REPOS = [
  { label: "workspace-root", dir: workspace },
  { label: "mesita-supabase", dir: join(workspace, "mesita-supabase") },
  { label: "mesita-monorepo", dir: join(workspace, "mesita-monorepo") },
  { label: "mesita-monorepo/apps/admin", dir: join(workspace, "mesita-monorepo", "apps", "admin") },
  { label: "mesita-monorepo/apps/business", dir: join(workspace, "mesita-monorepo", "apps", "business") },
  { label: "mesita-monorepo/apps/consumer", dir: join(workspace, "mesita-monorepo", "apps", "consumer") },
  { label: "mesita-monorepo/apps/landing", dir: join(workspace, "mesita-monorepo", "apps", "landing") },
  // ── STANDALONE WEB REPOS — delete this whole group at monorepo cutover (MESITA-341) ──
  { label: "mesita-web-admin", dir: join(workspace, "mesita-web-admin") },
  { label: "mesita-web-business", dir: join(workspace, "mesita-web-business") },
  { label: "mesita-web-consumer", dir: join(workspace, "mesita-web-consumer") },
  { label: "mesita-web-landing", dir: join(workspace, "mesita-web-landing") },
];

const targets = only ? REPOS.filter((r) => r.label === only) : REPOS;
if (only && targets.length === 0) {
  console.error(`unknown --only label: ${only}`);
  Deno.exit(1);
}

const canonical = (await Deno.readTextFile(join(scriptDir, "rules-quickstart.md"))).trim();
const block = `${START}\n${canonical}\n${END}`;

let updated = 0, drifted = 0, skipped = 0, failed = 0;

async function reconcile(path: string, next: string, label: string): Promise<void> {
  let current: string | null;
  try {
    current = await Deno.readTextFile(path);
  } catch {
    current = null;
  }
  if (current === next) return;
  drifted++;
  if (check) {
    console.error(`OUT OF SYNC: ${label}`);
    return;
  }
  await Deno.writeTextFile(path, next);
  updated++;
  console.log(`updated: ${label}`);
}

for (const { label, dir } of targets) {
  const claudePath = join(dir, "CLAUDE.md");
  let text: string;
  try {
    text = await Deno.readTextFile(claudePath);
  } catch {
    console.warn(`skip — no CLAUDE.md: ${label}`);
    skipped++;
    continue;
  }
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (
    s === -1 || e === -1 || s > e ||
    text.indexOf(START, s + 1) !== -1 || text.indexOf(END, e + END.length) !== -1
  ) {
    console.error(`BAD MARKERS (need exactly one START before one END): ${label}/CLAUDE.md`);
    failed++;
    continue;
  }
  const nextClaude = text.slice(0, s) + block + text.slice(e + END.length);
  await reconcile(claudePath, nextClaude, `${label}/CLAUDE.md`);
  await reconcile(join(dir, "AGENTS.md"), `${AGENTS_NOTICE}\n${nextClaude}`, `${label}/AGENTS.md`);
}

console.log(
  `\nsync-rules: ${updated} updated, ${drifted} drifted, ${skipped} skipped, ${failed} failed.`,
);
if (failed > 0 || (check && (drifted > 0 || skipped > 0))) {
  Deno.exit(1);
}
