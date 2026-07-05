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
import { numOf, safeParseJson } from "./parse-utils.ts";
import { domainOf, fbSlugCandidate } from "./channels.ts";
import { OPENAI_URL, VISION_MODEL } from "./atlas-config.ts";
import { fillMissingChannels } from "./atlas-channel-discovery.ts";

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
    const pp = await fillMissingChannels(
      perplexityKey,
      { name: venue.name, locationLine: venue.locationLine, category: venue.category },
      new Set(["instagram_url"]),
      {},
    );
    const alt = await attempt(instagramHandleFromUrl(pp.instagram_url ?? null));
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

// ── Instagram identity verification (used only by gatherInstagram above) ──────

// The Instagram profile scraper returns a non-null object even for a handle
// that DOESN'T EXIST: the requested username echoed back with every data field
// null/empty. That empty stub must be rejected before identity verification, or
// a guessed handle (e.g. a Facebook slug reused as an IG handle) could be
// "verified" against nothing. A real account always carries at least followers,
// a display name, a bio, or recent posts — a stub carries none of these.
function isDeadIgStub(p: Record<string, unknown>): boolean {
  if (typeof p.error === "string" && p.error.length > 0) return true;
  const hasFollowers = numOf(p.followersCount) != null;
  const hasName = typeof p.fullName === "string" && p.fullName.trim().length > 0;
  const hasBio = typeof p.biography === "string" && p.biography.trim().length > 0;
  const hasPosts = Array.isArray(p.latestPosts) && p.latestPosts.length > 0;
  return !hasFollowers && !hasName && !hasBio && !hasPosts;
}

// Does this scraped Instagram profile belong to THIS venue or its brand? We
// confirm before trusting it, but lean GENEROUS — a missing IG is a worse miss
// than a brand-level one. Instant yes on a bio link to the venue's website
// domain, agreement with the Facebook page slug, or a handle/name carrying the
// venue's brand (so franchises resolve to their one brand account). Otherwise
// an LLM judge decides, biased toward TRUE, rejecting only a clearly different
// business. No OpenAI key → fall back to the brand/slug signals above only.
async function igProfileMatchesVenue(
  p: Record<string, unknown>,
  venue: {
    name: string;
    locationLine: string;
    website: string | null;
    facebook: string | null;
    category: string | null;
  },
  openaiKey: string | undefined,
  corroborateFb = true,
): Promise<boolean> {
  const username = typeof p.username === "string" ? p.username : "";
  const fullName = typeof p.fullName === "string" ? p.fullName : "";
  const bio = typeof p.biography === "string" ? p.biography : "";
  const links: string[] = [];
  if (typeof p.externalUrl === "string") links.push(p.externalUrl);
  if (Array.isArray(p.externalUrls)) {
    for (const e of p.externalUrls) {
      const u = (e as { url?: unknown })?.url;
      if (typeof u === "string") links.push(u);
    }
  }

  // Strong signal: the IG bio link points to the venue's own website domain.
  const wd = domainOf(venue.website);
  if (wd && links.some((l) => domainOf(l) === wd)) return true;

  const fold = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const norm = (s: string) => fold(s).replace(/[^a-z0-9]/g, "");
  const uname = norm(username);
  const fname = norm(fullName);

  // Strong signal: an INDEPENDENTLY-discovered IG handle/name lines up with the
  // venue's Facebook page slug (venues reuse handles across networks, so
  // fb.com/Stranasanpedro + ig handle "stranasanpedro" is the same brand). Skip
  // when the candidate was derived FROM that slug — then it'd vouch for itself.
  const fbKey = corroborateFb ? norm(fbSlugCandidate(venue.facebook) ?? "") : "";
  if (fbKey.length >= 5 && (uname === fbKey || fname === fbKey)) return true;

  // Strong signal: the handle/name carries the venue's BRAND — its name minus
  // the city/location words. Franchises and multi-location brands run ONE
  // account for the whole brand, so "Mochomos Monterrey" → @mochomos is the
  // right match even though the handle isn't location-specific. We'd rather
  // attach the brand account than show nothing — a missing IG is the worse miss.
  const locTokens = new Set(
    fold(venue.locationLine)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
  const brandKey = norm(
    fold(venue.name)
      .split(/[^a-z0-9]+/)
      .filter((w) => w && !locTokens.has(w))
      .join(""),
  );
  if (brandKey.length >= 5 && (uname.includes(brandKey) || fname.includes(brandKey))) {
    return true;
  }

  if (!openaiKey) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 80,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content:
              `Decide if an Instagram profile belongs to the venue below OR to the ` +
              `brand/chain it is part of. For a franchise or multi-location business ` +
              `the brand's MAIN account counts as a match even when it isn't specific ` +
              `to this location. Answer false ONLY when the profile is clearly a ` +
              `DIFFERENT, unrelated business; when the name plausibly matches the ` +
              `venue or its brand, prefer true.\n\n` +
              `Venue: "${venue.name}"` +
              (venue.locationLine ? `, ${venue.locationLine}` : "") +
              (venue.category ? `, category: ${venue.category}` : "") +
              (venue.website ? `, website: ${venue.website}` : "") +
              (venue.facebook ? `, facebook: ${venue.facebook}` : "") +
              `\nInstagram: @${username}, name: "${fullName}", bio: "${bio.slice(0, 500)}", ` +
              `links: ${links.join(", ") || "none"}\n\n` +
              `Reply JSON {"match": true} or {"match": false}.`,
          },
        ],
      }),
    });
    if (!r.ok) return false;
    const data = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    const obj = safeParseJson(data.choices?.[0]?.message?.content ?? "") as
      | { match?: unknown }
      | null;
    return obj?.match === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
