// Atlas source — Apify Instagram: followers + bio + post IMAGES (top by likes).
//
// IDENTITY-CHECKED but GENEROUS: scrape the candidate and confirm it's this
// venue's OR its brand's account (website-domain match, FB-slug agreement,
// brand-name match, else a true-biased LLM judge) — a franchise's single brand
// account is a valid result. Candidates are tried in order — the Firecrawl/
// Google handle, then the Facebook slug reused as a handle, then a Perplexity-
// resolved handle — keeping the first that passes. Only a genuinely dead/
// nonexistent handle is dropped: a missing IG is the worse miss, so when in
// doubt we attach the brand account rather than nothing.

import { APIFY_ACTORS, instagramHandleFromUrl, runApifyActor } from "./apify.ts";
import { numOf } from "./parse-utils.ts";
import {
  discoverChannelsPerplexity,
  igProfileMatchesVenue,
  isDeadIgStub,
} from "./atlas-channel-discovery.ts";

export type InstagramVenueCtx = {
  name: string;
  locationLine: string;
  website: string | null;
  facebook: string | null;
  category: string | null;
};

export type InstagramAssetMeta = {
  likes_count: number | null;
  caption: string | null;
  source_metadata: Record<string, unknown>;
};

export type InstagramResult = {
  verifiedInstagramUrl: string | null;
  igBio: string;
  igFollowers: number | null;
  instagramImages: string[];
  instagramAssetMeta: Map<string, InstagramAssetMeta>;
  diag: Record<string, unknown>;
};

export async function gatherInstagram(opts: {
  apifyKey: string;
  openaiKey: string | undefined;
  perplexityKey: string | undefined;
  venue: InstagramVenueCtx;
  igHandle: string | null;
  fbHandleCandidate: string | null;
  gatherInstagramPosts: number;
}): Promise<InstagramResult> {
  const {
    apifyKey,
    openaiKey,
    perplexityKey,
    venue,
    igHandle,
    fbHandleCandidate,
    gatherInstagramPosts,
  } = opts;
  const instagramAssetMeta = new Map<string, InstagramAssetMeta>();
  const tried = new Set<string>();

  // corroborateFb=true means the candidate was found INDEPENDENTLY (Firecrawl/
  // Google/Perplexity), so agreement with the Facebook slug is real corroboration.
  // The candidate we DERIVE from the Facebook slug can't use FB to vouch for
  // itself (circular), so that one must clear the website match or the LLM judge.
  const attempt = async (handle: string | null, corroborateFb = true) => {
    if (!handle || tried.has(handle.toLowerCase())) return null;
    tried.add(handle.toLowerCase());
    const items = await runApifyActor<Record<string, unknown>>(
      APIFY_ACTORS.instagramProfile,
      { usernames: [handle] },
      apifyKey,
    );
    const p = items?.[0];
    // A NONEXISTENT handle still returns a non-null object — the username echoed
    // back with every field null/empty. Treat that empty stub as not-found so a
    // dead handle (e.g. a guessed FB-slug) never reaches the identity judge.
    if (!p || isDeadIgStub(p)) return null;
    const ok = await igProfileMatchesVenue(p, venue, openaiKey, corroborateFb);
    return { handle, p, ok };
  };

  // 1) Firecrawl/Google candidate (independent → FB corroboration ok).
  let chosen = await attempt(igHandle);
  // 2) Facebook slug reused as an IG handle (derived from FB → no FB corroboration).
  if (!chosen?.ok) {
    const alt = await attempt(fbHandleCandidate, false);
    chosen = alt?.ok ? alt : (chosen ?? alt);
  }
  // 3) Last resort: ask Perplexity for the right account + verify it.
  if (!chosen?.ok && perplexityKey) {
    const pp = await discoverChannelsPerplexity(
      perplexityKey,
      venue.name,
      venue.locationLine,
      venue.category,
    );
    const alt = await attempt(instagramHandleFromUrl(pp?.instagram_url ?? null));
    chosen = alt?.ok ? alt : (chosen ?? alt);
  }

  if (!chosen?.ok) {
    // No account passed identity verification — attach nothing.
    return {
      verifiedInstagramUrl: null,
      igBio: "",
      igFollowers: null,
      instagramImages: [],
      instagramAssetMeta,
      diag: {
        ok: false,
        reason: chosen ? "unverified" : "not_found",
        candidate: igHandle ?? fbHandleCandidate,
        tried: [...tried],
      },
    };
  }

  const p = chosen.p;
  const igFollowers = numOf(p.followersCount);
  const igBio = typeof p.biography === "string" ? p.biography : "";
  const posts = Array.isArray(p.latestPosts) ? (p.latestPosts as Record<string, unknown>[]) : [];
  const orderedPosts = posts
    // Videos are kept: their displayUrl is the cover frame, analyzed as a photo.
    .filter(
      (po) => typeof po.displayUrl === "string" && (po.displayUrl as string).startsWith("http"),
    )
    .sort((a, b) => (numOf(b.likesCount) ?? 0) - (numOf(a.likesCount) ?? 0))
    .slice(0, gatherInstagramPosts);
  const instagramImages = orderedPosts.map((po) => po.displayUrl as string);
  for (const po of orderedPosts) {
    const url = po.displayUrl as string;
    instagramAssetMeta.set(url, {
      likes_count: numOf(po.likesCount),
      caption: typeof po.caption === "string" ? po.caption : null,
      source_metadata: {
        comments_count: numOf(po.commentsCount),
        is_video: !!po.isVideo,
        shortcode: typeof po.shortCode === "string" ? po.shortCode : null,
        timestamp:
          typeof po.timestamp === "string" || typeof po.timestamp === "number"
            ? po.timestamp
            : null,
      },
    });
  }
  return {
    verifiedInstagramUrl: `https://www.instagram.com/${chosen.handle}`,
    igBio,
    igFollowers,
    instagramImages,
    instagramAssetMeta,
    diag: {
      handle: chosen.handle,
      ok: true,
      verified: true,
      posts: posts.length,
      images: instagramImages.length,
    },
  };
}
