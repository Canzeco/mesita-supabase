// Mesita Ops (Staff WhatsApp) — venue eligibility + guest reward copy.
// Type A = informal discount tickets only (see docs/whatsapp.md).

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { isConsumerFirstVisit, type VenueRates } from "./membership.ts";
import type { VenueRateRow } from "./ticket-informal.ts";
import { venueHasVerifiedOwner } from "./venue-ownership.ts";

export type VenueOpsRow = VenueRateRow & {
  plan: string | null;
};

const INFORMAL_DISCOUNT_PLANS = new Set(["informal_pro", "informal_ultra"]);

export type DiscountOpsBlock = {
  ok: false;
  code:
    | "not_claimed"
    | "formal_venue"
    | "free_plan"
    | "wrong_plan"
    | "no_rates_configured";
  staffMessage: string;
};

export type DiscountOpsOk = {
  ok: true;
};

export type DiscountOpsEligibility = DiscountOpsBlock | DiscountOpsOk;

/** Highest configured promo % across welcome + returning, free + premium. */
export function maxConfiguredPromoRate(venue: VenueRates): number {
  const candidates = [
    venue.welcome_free_rate,
    venue.welcome_premium_rate,
    venue.free_rate,
    venue.premium_rate,
  ];
  let max = 0;
  for (const r of candidates) {
    if (r != null && r > max) max = r;
  }
  return Math.max(0, Math.min(100, max));
}

/** Discount % from Promos toggles only (null/Off = 0). Ignores legacy cashback_percent. */
export function selectDiscountPromoRate(
  venue: VenueRates,
  tier: string | null | undefined,
  isFirstVisit: boolean,
): number {
  const isPremium = tier === "premium";
  let rate: number | null = null;
  if (isFirstVisit) {
    rate = isPremium
      ? venue.welcome_premium_rate ?? venue.welcome_free_rate
      : venue.welcome_free_rate;
  } else {
    rate = isPremium
      ? venue.premium_rate ?? venue.free_rate
      : venue.free_rate;
  }
  return Math.max(0, Math.min(100, rate ?? 0));
}

export function assessDiscountTicketOps(
  venue: VenueOpsRow,
  hasVerifiedOwner: boolean,
): DiscountOpsEligibility {
  if (venue.fiscal_type !== "informal") {
    return {
      ok: false,
      code: "formal_venue",
      staffMessage:
        "Este local usa Cashback (plan formal), no descuentos en cuenta.\n\n" +
        "Mesita Ops por WhatsApp solo abre tickets con descuento (tipo A).\n" +
        "Para usar este canal: Mesita Business → Promos → elige «Pro/Ultra con Descuentos» y configura porcentajes.",
    };
  }

  const plan = (venue.plan ?? "free").toLowerCase();
  if (plan === "free") {
    return {
      ok: false,
      code: "free_plan",
      staffMessage:
        "Este local está en plan Free — las promos están bloqueadas en 0%.\n\n" +
        "En Mesita Business → Promos activa «Pro o Ultra con Descuentos» y configura los porcentajes (Free / Premium, primera visita y recurrente).",
    };
  }

  if (!INFORMAL_DISCOUNT_PLANS.has(plan)) {
    return {
      ok: false,
      code: "wrong_plan",
      staffMessage:
        "El plan de este local no incluye tickets con descuento por WhatsApp.\n\n" +
        "En Mesita Business → Promos elige una suscripción «con Descuentos» (Pro o Ultra).",
    };
  }

  if (maxConfiguredPromoRate(venue) === 0) {
    return {
      ok: false,
      code: "no_rates_configured",
      staffMessage:
        "Este local ya tiene plan con descuentos, pero todos los porcentajes están en Off (0%).\n\n" +
        "Actívalos en Mesita Business → Promos (Free / Premium, primera visita y visitas recurrentes).",
    };
  }

  if (!hasVerifiedOwner) {
    return {
      ok: false,
      code: "not_claimed",
      staffMessage:
        "Este local aún no tiene dueño verificado en Mesita (reclamar el local en la app).\n" +
        "Sin eso no puedes abrir tickets con descuento por WhatsApp.",
    };
  }

  return { ok: true };
}

export function tierLabelEs(tierKey: string | null | undefined): string {
  if (tierKey === "premium") return "Premium";
  return "Free";
}

/** What this guest would get at this venue right now (for staff WhatsApp). */
export function formatGuestRewardLine(opts: {
  ratePercent: number;
  firstVisit: boolean;
  tierKey: string | null | undefined;
  ops: DiscountOpsEligibility;
}): string {
  const tier = tierLabelEs(opts.tierKey);
  const visit = opts.firstVisit ? "primera visita en este local" : "visita recurrente";

  if (!opts.ops.ok) {
    if (opts.ops.code === "not_claimed") {
      return (
        `Recompensa para este comensal (${tier}, ${visit}): ${opts.ratePercent}% de descuento ` +
        `(aplica cuando el local tenga dueño verificado y promos activas).`
      );
    }
    return (
      `Recompensa para este comensal (${tier}, ${visit}): sin descuento activo (0%) — ` +
      `activa porcentajes en Mesita Business → Promos.`
    );
  }

  if (opts.ratePercent <= 0) {
    return (
      `Recompensa para este comensal (${tier}, ${visit}): 0% de descuento en este local. ` +
      `Revisa los porcentajes en Promos.`
    );
  }

  return (
    `Recompensa para este comensal (${tier}, ${visit}): ${opts.ratePercent}% de descuento en la cuenta.`
  );
}

export async function loadVenueOpsRow(
  admin: SupabaseClient,
  venueId: string,
): Promise<VenueOpsRow | null> {
  const res = await admin
    .from("venues")
    .select(
      "id, name, slug, photos, cashback_percent, welcome_free_rate, welcome_premium_rate, free_rate, premium_rate, monthly_promo_cap, listing_type, status, fiscal_type, plan",
    )
    .eq("id", venueId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return res.data as VenueOpsRow;
}

export async function guestRewardContext(
  admin: SupabaseClient,
  venue: VenueOpsRow,
  consumerId: string,
  tierKey: string | null | undefined,
): Promise<{
  ops: DiscountOpsEligibility;
  ratePercent: number;
  firstVisit: boolean;
  rewardLine: string;
}> {
  const firstVisit = await isConsumerFirstVisit(admin, consumerId, venue.id);
  const hasOwner = await venueHasVerifiedOwner(admin, venue.id);
  const ops = assessDiscountTicketOps(venue, hasOwner);
  const ratePercent = selectDiscountPromoRate(venue, tierKey, firstVisit);
  const rewardLine = formatGuestRewardLine({
    ratePercent,
    firstVisit,
    tierKey,
    ops,
  });
  return { ops, ratePercent, firstVisit, rewardLine };
}

/** Short note when staff picks a unit that cannot run discount tickets yet. */
export async function venueOpsShortWarning(
  admin: SupabaseClient,
  venueId: string,
): Promise<string> {
  const venue = await loadVenueOpsRow(admin, venueId);
  if (!venue) return "";
  const hasOwner = await venueHasVerifiedOwner(admin, venueId);
  const ops = assessDiscountTicketOps(venue, hasOwner);
  if (ops.ok) return "";
  return (
    "\n\n⚠️ Este local no puede abrir tickets con descuento por WhatsApp todavía. " +
    "Configura Promos en Mesita Business."
  );
}
