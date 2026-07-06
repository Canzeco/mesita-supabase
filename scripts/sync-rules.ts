#!/usr/bin/env -S deno run --allow-read --allow-write
// sync-rules.ts — regenerate the marker-delimited quickstart block in every
// workspace CLAUDE.md from ONE canonical source (scripts/rules-quickstart.md).
//
// WHY: the quickstart block is mirrored into each repo's CLAUDE.md so agents orient
// with zero fetches. Hand-syncing N copies drifts (MESITA-149). This makes the block
// GENERATED, not hand-kept: edit the canonical file once, run this, every copy updates.
//
// SOURCE OF TRUTH: the Notion **Rules** page §0 is the human master. When it changes,
// update scripts/rules-quickstart.md to match, then run:
//     deno run --allow-read --allow-write scripts/sync-rules.ts
// The text BETWEEN the two markers in every CLAUDE.md is generated — NEVER hand-edit it.
// Edit the per-repo "## This repo …" section below the END marker freely.
//
// Pass --check to exit 1 (without writing) if any CLAUDE.md is out of sync — use it in a
// pre-commit hook. (CI can't enforce cross-repo until the monorepo lands, MESITA-141:
// in a single-repo CI checkout the sibling repos aren't present, so they're skipped.)
//
// Requires the standard local workspace layout: this repo and its siblings all live
// directly under ~/Desktop/Canzeco/Mesita/.

import { dirname, fromFileUrl, join } from "jsr:@std/path@1";

const START =
  "<!-- RULES-QUICKSTART:START (generated — do not hand-edit; run: deno run -A mesita-supabase/scripts/sync-rules.ts) -->";
const END = "<!-- RULES-QUICKSTART:END -->";

// scriptDir = mesita-supabase/scripts ; supabaseRoot = mesita-supabase ; workspace = the parent
const scriptDir = dirname(fromFileUrl(import.meta.url));
const workspace = dirname(dirname(scriptDir));

// Every CLAUDE.md that mirrors the quickstart: the workspace root + each repo.
const TARGETS = [
  { label: "(workspace root)", path: join(workspace, "CLAUDE.md") },
  { label: "mesita-supabase", path: join(workspace, "mesita-supabase", "CLAUDE.md") },
  { label: "mesita-web-consumer", path: join(workspace, "mesita-web-consumer", "CLAUDE.md") },
  { label: "mesita-web-business", path: join(workspace, "mesita-web-business", "CLAUDE.md") },
  { label: "mesita-web-admin", path: join(workspace, "mesita-web-admin", "CLAUDE.md") },
  { label: "mesita-web-landing", path: join(workspace, "mesita-web-landing", "CLAUDE.md") },
  { label: "mesita-n8n", path: join(workspace, "mesita-n8n", "CLAUDE.md") },
];

const canonical = (await Deno.readTextFile(join(scriptDir, "rules-quickstart.md"))).trim();
const block = `${START}\n${canonical}\n${END}`;

const check = Deno.args.includes("--check");
let updated = 0, drifted = 0, skipped = 0;

for (const { label, path } of TARGETS) {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    console.warn(`skip — no CLAUDE.md: ${label}`);
    skipped++;
    continue;
  }
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 || e === -1) {
    console.warn(`skip — no markers: ${label}/CLAUDE.md`);
    skipped++;
    continue;
  }
  const next = text.slice(0, s) + block + text.slice(e + END.length);
  if (next === text) continue; // already in sync
  drifted++;
  if (check) {
    console.error(`OUT OF SYNC: ${label}/CLAUDE.md`);
    continue;
  }
  await Deno.writeTextFile(path, next);
  updated++;
  console.log(`updated: ${label}/CLAUDE.md`);
}

if (check && drifted > 0) {
  console.error(`\n${drifted} file(s) out of sync — run without --check to fix.`);
  Deno.exit(1);
}
console.log(`\nsync-rules: ${updated} updated, ${drifted} drifted, ${skipped} skipped.`);