// Atlas source — Apify Facebook page (followers + rating). Social-layer.

import { APIFY_ACTORS, runApifyActor } from "./apify.ts";
import { numOf } from "./parse-utils.ts";

export type FacebookResult = {
  fbFollowers: number | null;
  fbRating: number | null;
  diag: Record<string, unknown>;
};

export async function gatherFacebook(opts: {
  apifyKey: string;
  facebookUrl: string;
}): Promise<FacebookResult> {
  const run = await runApifyActor<Record<string, unknown>>(
    APIFY_ACTORS.facebookPages,
    { startUrls: [{ url: opts.facebookUrl }] },
    opts.apifyKey,
  );
  const p = run.items?.[0];
  if (!p) {
    return {
      fbFollowers: null,
      fbRating: null,
      diag: { ok: false, ...(run.error ? { status: run.status, error: run.error } : {}) },
    };
  }
  const fbFollowers = numOf(p.followers) ?? numOf(p.likes);
  const ratingRaw = numOf(p.rating) ?? numOf(p.overallStarRating);
  const fbRating = ratingRaw != null && ratingRaw >= 0 && ratingRaw <= 5 ? ratingRaw : null;
  return { fbFollowers, fbRating, diag: { ok: true } };
}
