// Selected Reservation Endpoint — Notion Enricher Enrich-Analysis S4.
//
// Picks the single best contact channel for the Reservationist among
// Phone / WhatsApp / Instagram (admin Place → Reservations box shape:
// products.reservations = { channel, value }). Strongly prefers phone when
// available; WhatsApp / Instagram only when they are clearly better or the
// only option. Runs in the contents stage alongside category + tags.

import { safeParseJson } from "./parse-utils.ts";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const SELECTOR_MODEL = "gpt-4o-mini";

export type ReservationChannel = "phone" | "whatsapp" | "instagram";

export type ReservationTarget = {
  channel: ReservationChannel;
  value: string | null;
};

export type ReservationCandidates = {
  phone?: string | null;
  whatsapp_url?: string | null;
  instagram_url?: string | null;
};

const CHANNELS: ReservationChannel[] = ["phone", "whatsapp", "instagram"];

function trimOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

/** Non-empty contact values the selector may choose from. */
export function availableReservationChannels(
  candidates: ReservationCandidates,
): ReservationChannel[] {
  const out: ReservationChannel[] = [];
  if (trimOrNull(candidates.phone)) out.push("phone");
  if (trimOrNull(candidates.whatsapp_url)) out.push("whatsapp");
  if (trimOrNull(candidates.instagram_url)) out.push("instagram");
  return out;
}

/** Deterministic phone-first fallback (≈80% phone bias when phone exists). */
export function preferReservationChannel(
  available: ReservationChannel[],
): ReservationChannel | null {
  if (available.includes("phone")) return "phone";
  if (available.includes("whatsapp")) return "whatsapp";
  if (available.includes("instagram")) return "instagram";
  return null;
}

export function valueForReservationChannel(
  candidates: ReservationCandidates,
  channel: ReservationChannel,
): string | null {
  if (channel === "phone") return trimOrNull(candidates.phone);
  if (channel === "whatsapp") return trimOrNull(candidates.whatsapp_url);
  return trimOrNull(candidates.instagram_url);
}

export function buildReservationTarget(
  channel: ReservationChannel,
  candidates: ReservationCandidates,
): ReservationTarget | null {
  const value = valueForReservationChannel(candidates, channel);
  if (!value) return null;
  return { channel, value };
}

/** True when products.reservations already has a selected channel (admin override). */
export function hasReservationTarget(products: unknown): boolean {
  if (!products || typeof products !== "object" || Array.isArray(products)) {
    return false;
  }
  const raw = (products as Record<string, unknown>).reservations;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const channel = (raw as Record<string, unknown>).channel;
  return channel === "phone" || channel === "whatsapp" || channel === "instagram";
}

/** Merge a reservation target into products without wiping menu / other keys. */
export function mergeProductsReservations(
  products: unknown,
  target: ReservationTarget,
): Record<string, unknown> {
  const base =
    products && typeof products === "object" && !Array.isArray(products)
      ? { ...(products as Record<string, unknown>) }
      : {};
  base.reservations = { channel: target.channel, value: target.value };
  return base;
}

function parseChannel(raw: unknown, available: ReservationChannel[]): ReservationChannel | null {
  if (typeof raw !== "string") return null;
  const channel = raw.trim().toLowerCase() as ReservationChannel;
  if (!CHANNELS.includes(channel)) return null;
  return available.includes(channel) ? channel : null;
}

/**
 * Select the best reservation contact channel for a place.
 * - 0 candidates → null
 * - 1 candidate → that channel (no LLM)
 * - 2+ → OpenAI pick with strong phone preference; deterministic fallback on error
 */
export async function selectReservationEndpoint(input: {
  openaiKey: string;
  candidates: ReservationCandidates;
  name?: string | null;
  about?: string | null;
}): Promise<{ target: ReservationTarget | null; diag: Record<string, unknown> }> {
  const available = availableReservationChannels(input.candidates);
  if (available.length === 0) {
    return { target: null, diag: { ok: false, reason: "no_candidates" } };
  }
  if (available.length === 1) {
    const channel = available[0];
    const target = buildReservationTarget(channel, input.candidates);
    return {
      target,
      diag: { ok: !!target, channel, via: "sole_candidate" },
    };
  }

  const preferred = preferReservationChannel(available);
  const candidateLines = available.map((channel) => {
    const value = valueForReservationChannel(input.candidates, channel);
    return `- ${channel}: ${value}`;
  }).join("\n");

  const systemContent =
    "You pick the single best reservation contact method for an AI booking agent. " +
    "Options are only the channels listed by the user (phone, whatsapp, instagram). " +
    "Strongly prefer phone whenever it is available — roughly 80% of selections should " +
    "be phone. Choose whatsapp or instagram ONLY when they are clearly the better or " +
    "only workable option (e.g. phone missing/unusable, or sources say reservations " +
    "are taken exclusively via DM/WhatsApp). " +
    'Respond with a single JSON object {"channel":"phone"|"whatsapp"|"instagram"}.';

  const userPrompt =
    (input.name ? `Place: ${input.name}\n` : "") +
    (input.about ? `About (context only):\n${input.about.slice(0, 800)}\n\n` : "") +
    `Available reservation channels:\n${candidateLines}\n\n` +
    `Return {"channel":"<one of: ${available.join("|")}>"}. Prefer phone when listed.`;

  try {
    const r = await fetch(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: SELECTOR_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (r.ok) {
      const data = (await r.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const parsed = safeParseJson(data.choices?.[0]?.message?.content ?? "") as
        | { channel?: unknown }
        | null;
      const channel = parseChannel(parsed?.channel, available) ?? preferred;
      if (channel) {
        const target = buildReservationTarget(channel, input.candidates);
        return {
          target,
          diag: {
            ok: !!target,
            channel,
            via: parseChannel(parsed?.channel, available) ? "openai" : "fallback_prefer",
            model: SELECTOR_MODEL,
          },
        };
      }
    }
  } catch {
    // fall through to deterministic preference
  }

  if (!preferred) return { target: null, diag: { ok: false, reason: "fallback_empty" } };
  const target = buildReservationTarget(preferred, input.candidates);
  return {
    target,
    diag: { ok: !!target, channel: preferred, via: "fallback_prefer", model: SELECTOR_MODEL },
  };
}
