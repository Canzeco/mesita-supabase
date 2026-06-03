// Venue URL slug generation + uniqueness check (service-role client).

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function ensureUniqueSlug(
  admin: SupabaseClient,
  base: string,
): Promise<string> {
  let candidate = base || `venue-${Date.now()}`;
  for (let i = 0; i < 5; i += 1) {
    const { data } = await admin.from("venues").select("id").eq("slug", candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
  }
  return `${base}-${Date.now()}`;
}
