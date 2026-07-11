// Follower-count refresh on manual social-account edits (MESITA-416).
//
// Follower counts are only INDIRECTLY editable: nobody types a number — an
// admin/business picks the Instagram/Facebook account, and the counts follow
// the account. When business-web-update-project lands a changed
// instagram_url / facebook_url, this module scrapes the newly chosen account
// via Apify and rewrites the signal columns; clearing the account clears
// them (the old account's numbers would be stale lies).
//
// Best-effort like every Apify call: a failed scrape writes null rather than
// keeping the previous account's count. No identity judging here — the
// account was chosen explicitly by a human, unlike the Enricher's discovery.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { APIFY_ACTORS, instagramHandleFromUrl, runApifyActor } from "./apify.ts";
import { gatherFacebook } from "./enrich-facebook.ts";
import { numOf } from "./parse-utils.ts";

export type SocialFollowersRefresh = {
  admin: SupabaseClient;
  apifyKey: string;
  placeId: string;
  /** undefined = field untouched; null = account cleared; string = new URL. */
  instagramUrl?: string | null;
  facebookUrl?: string | null;
};

export async function refreshSocialFollowers(opts: SocialFollowersRefresh): Promise<void> {
  const { admin, apifyKey, placeId } = opts;
  const update: Record<string, unknown> = {};

  const [ig, fb] = await Promise.all([
    opts.instagramUrl === undefined
      ? Promise.resolve(null)
      : scrapeInstagramFollowers(apifyKey, opts.instagramUrl),
    opts.facebookUrl === undefined
      ? Promise.resolve(null)
      : opts.facebookUrl === null
        ? Promise.resolve({ fbFollowers: null, fbRating: null })
        : gatherFacebook({ apifyKey, facebookUrl: opts.facebookUrl }),
  ]);

  if (opts.instagramUrl !== undefined) update.instagram_followers_count = ig;
  if (opts.facebookUrl !== undefined) {
    update.facebook_followers = fb?.fbFollowers ?? null;
    update.facebook_rating = fb?.fbRating ?? null;
  }
  if (Object.keys(update).length === 0) return;

  await admin.from("places").update(update).eq("id", placeId);
}

async function scrapeInstagramFollowers(
  apifyKey: string,
  instagramUrl: string | null,
): Promise<number | null> {
  const handle = instagramHandleFromUrl(instagramUrl);
  if (!handle) return null;
  const run = await runApifyActor<Record<string, unknown>>(
    APIFY_ACTORS.instagramProfile,
    { usernames: [handle] },
    apifyKey,
  );
  const p = run.items?.[0];
  if (!p) return null;
  return numOf(p.followersCount);
}

/** Ack-early: run the refresh after the response, same pattern as the Enricher. */
export function runFollowersRefreshInBackground(task: Promise<unknown>): void {
  const edgeRuntime = (globalThis as unknown as {
    EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(task);
  else void task;
}
