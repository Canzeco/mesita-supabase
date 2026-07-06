// linklab — URL/handle normalization + scoring.
// Pure, dependency-free so both the EF and the local benchmark runner can import it.

/** Lowercase registrable host of a URL, sans scheme / `www.` / path / query / hash.
 *  Returns null for junk / non-http. Used as the website match key. */
export function normWebsiteHost(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  // reject obvious non-official aggregators / socials as a "website"
  if (BLOCKED_WEBSITE_HOSTS.some((h) => host === h || host.endsWith("." + h))) return null;
  return host || null;
}

const BLOCKED_WEBSITE_HOSTS = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "m.facebook.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "linktr.ee",
  "linktree.com",
  "tripadvisor.com",
  "tripadvisor.com.mx",
  "yelp.com",
  "ubereats.com",
  "rappi.com",
  "rappi.com.mx",
  "didiglobal.com",
  "opentable.com",
  "opentable.com.mx",
  "resy.com",
  "google.com",
  "goo.gl",
  "maps.app.goo.gl",
  "wa.me",
  "whatsapp.com",
  "menu.com",
  "sircreated.com",
  "foursquare.com",
  "youtube.com",
  // NOTE: builder domains (wixsite.com, mystrikingly.com, etc.) are NOT blocked —
  // small venues genuinely host their official site there.
];

/** Instagram handle (lowercase) from any instagram URL, or null.
 *  Rejects post/reel/explore/tag paths — we only want profile handles. */
export function normInstagramHandle(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  // allow bare "@handle" or "handle"
  if (/^@?[a-z0-9._]+$/i.test(s) && !s.includes("/") && !s.includes(".com")) {
    const h = s.replace(/^@/, "").toLowerCase();
    return isReservedIgWord(h) ? null : h;
  }
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  if (!seg.length) return null;
  const first = seg[0].toLowerCase();
  if (isReservedIgWord(first)) return null;
  if (!/^[a-z0-9._]+$/.test(first)) return null;
  return first;
}

function isReservedIgWord(h: string): boolean {
  return [
    "p",
    "reel",
    "reels",
    "explore",
    "tags",
    "tag",
    "stories",
    "tv",
    "accounts",
    "about",
    "directory",
    "developer",
    "legal",
    "privacy",
  ].includes(h);
}

/** Canonical instagram URL from a handle, for reporting. */
export function igUrlFromHandle(h: string | null): string | null {
  return h ? `https://www.instagram.com/${h}` : null;
}

export type FieldOutcome = "TP" | "TN" | "FP" | "FN" | "WRONG";

/** Compare one predicted value against truth for a field.
 *  TP  predicted correct non-null
 *  TN  correctly predicted null (venue truly has none)
 *  FP  predicted a value where truth is null
 *  FN  predicted null where truth has a value
 *  WRONG predicted a value but it disagrees with truth (counts against precision AND recall) */
export function scoreField(
  pred: string | null,
  truth: string | null,
): FieldOutcome {
  if (truth === null && pred === null) return "TN";
  if (truth === null && pred !== null) return "FP";
  if (truth !== null && pred === null) return "FN";
  return pred === truth ? "TP" : "WRONG";
}

export type FieldStats = {
  n: number;
  tp: number;
  tn: number;
  fp: number;
  fn: number;
  wrong: number;
  accuracy: number; // (tp+tn)/n
  precision: number; // tp/(tp+fp+wrong)
  recall: number; // tp/(tp+fn+wrong)
  f1: number;
};

export function aggregate(outcomes: FieldOutcome[]): FieldStats {
  const c = { TP: 0, TN: 0, FP: 0, FN: 0, WRONG: 0 };
  for (const o of outcomes) c[o]++;
  const n = outcomes.length || 1;
  const predictedPos = c.TP + c.FP + c.WRONG;
  const truthPos = c.TP + c.FN + c.WRONG;
  const precision = predictedPos ? c.TP / predictedPos : 0;
  const recall = truthPos ? c.TP / truthPos : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    n: outcomes.length,
    tp: c.TP,
    tn: c.TN,
    fp: c.FP,
    fn: c.FN,
    wrong: c.WRONG,
    accuracy: (c.TP + c.TN) / n,
    precision,
    recall,
    f1,
  };
}
