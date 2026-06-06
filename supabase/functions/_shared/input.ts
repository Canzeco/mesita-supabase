// Input normalisation helpers shared by Edge Functions that accept
// user-typed strings (profile names, phones, free-form notes, etc.).

// Trim, length-cap, and reject empty/null. Used everywhere we'd
// otherwise repeat `String(...).trim()` plus a "did the user actually
// type anything" check.
export function clean(v: unknown, max = 256): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

// Cheap "looks like an email" check. Same single-regex bar Supabase
// itself uses on signup — DNS/MX validation belongs at the SMTP
// layer, not here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailish(value: unknown): value is string {
  return typeof value === "string" && EMAIL_RE.test(value);
}

/** Resolve the operator contact email for ownership claims. */
export function resolveRequesterEmail(opts: {
  bodyEmail?: string | null;
  sessionEmail?: string | null;
  userId: string;
  /** When true, synthesize a stable placeholder if no real email exists. */
  allowMockFallback?: boolean;
}): string | null {
  const body = (opts.bodyEmail ?? "").trim().toLowerCase();
  if (isEmailish(body)) return body;

  const session = (opts.sessionEmail ?? "").trim().toLowerCase();
  if (isEmailish(session)) return session;

  if (opts.allowMockFallback) {
    const compactId = opts.userId.replace(/-/g, "");
    return `mock+${compactId}@mesita.ai`;
  }

  return null;
}
