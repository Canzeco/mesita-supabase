// Venue selection + session persistence for staff WhatsApp Type A.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { displayConsumerCode } from "./consumer-code.ts";
import type {
  SessionRow,
  StaffContext,
  StaffIdentity,
  StaffVenue,
  VenueOption,
} from "./staff-whatsapp-types.ts";

export async function loadSession(
  admin: SupabaseClient,
  phoneE164: string,
): Promise<SessionRow | null> {
  const existing = await admin
    .from("staff_whatsapp_sessions")
    .select("*")
    .eq("phone_e164", phoneE164)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  return existing.data ? (existing.data as SessionRow) : null;
}

export async function enterVenueSelection(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
  venues: StaffVenue[],
): Promise<SessionRow> {
  const options: VenueOption[] = venues.map((v) => ({
    venue_id: v.venueId,
    name: v.venueName,
  }));

  if (session) {
    const updated = await admin
      .from("staff_whatsapp_sessions")
      .update({
        state: "selecting_venue",
        venue_id: null,
        consumer_id: null,
        ticket_id: null,
        pending_consumer_code: null,
        context: { venue_options: options },
      })
      .eq("id", session.id)
      .select("*")
      .single();
    if (updated.error) throw new Error(updated.error.message);
    return updated.data as SessionRow;
  }

  const inserted = await admin
    .from("staff_whatsapp_sessions")
    .insert({
      phone_e164: identity.phoneE164,
      staff_user_id: identity.staffUserId,
      venue_id: null,
      state: "selecting_venue",
      context: { venue_options: options },
    })
    .select("*")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data as SessionRow;
}

export async function applyActiveVenue(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
  venue: StaffVenue,
): Promise<SessionRow> {
  if (session) {
    const updated = await admin
      .from("staff_whatsapp_sessions")
      .update({
        venue_id: venue.venueId,
        state: "idle",
        staff_user_id: identity.staffUserId,
        consumer_id: null,
        ticket_id: null,
        pending_consumer_code: null,
        context: {},
      })
      .eq("id", session.id)
      .select("*")
      .single();
    if (updated.error) throw new Error(updated.error.message);
    return updated.data as SessionRow;
  }

  const inserted = await admin
    .from("staff_whatsapp_sessions")
    .insert({
      phone_e164: identity.phoneE164,
      staff_user_id: identity.staffUserId,
      venue_id: venue.venueId,
      state: "idle",
    })
    .select("*")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data as SessionRow;
}

export async function resolveActiveVenue(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
): Promise<
  | { kind: "ok"; staff: StaffContext; session: SessionRow }
  | { kind: "need_selection"; session: SessionRow }
> {
  const venues = identity.venues;
  if (venues.length === 0) {
    throw new Error("staff has no venue_roles");
  }

  if (venues.length === 1) {
    const sessionOut = await applyActiveVenue(admin, identity, session, venues[0]);
    return {
      kind: "ok",
      staff: { ...identity, ...venues[0] },
      session: sessionOut,
    };
  }

  if (!session) {
    const created = await enterVenueSelection(admin, identity, null, venues);
    return { kind: "need_selection", session: created };
  }

  if (session.state === "selecting_venue" || !session.venue_id) {
    return { kind: "need_selection", session };
  }

  const active = venues.find((v) => v.venueId === session.venue_id);
  if (!active) {
    const created = await enterVenueSelection(admin, identity, session, venues);
    return { kind: "need_selection", session: created };
  }

  if (session.staff_user_id !== identity.staffUserId) {
    await admin
      .from("staff_whatsapp_sessions")
      .update({ staff_user_id: identity.staffUserId })
      .eq("id", session.id);
  }

  return {
    kind: "ok",
    staff: { ...identity, ...active },
    session,
  };
}

export async function resetSession(
  admin: SupabaseClient,
  sessionId: string,
  venueId: string | null,
) {
  await admin
    .from("staff_whatsapp_sessions")
    .update({
      state: venueId ? "idle" : "selecting_venue",
      consumer_id: null,
      ticket_id: null,
      pending_consumer_code: null,
      context: {},
    })
    .eq("id", sessionId);
}

export function prefixActiveVenue(staff: StaffContext): string {
  return `Unidad: ${staff.venueName}\n`;
}

export function idleOpsBlockedReminder(
  staff: StaffContext,
  session: SessionRow,
  opsMessage: string,
): string {
  const code = session.pending_consumer_code
    ? displayConsumerCode(session.pending_consumer_code)
    : null;
  const preview = session.context?.consumer_preview as
    | { name?: string }
    | undefined;
  const name = preview?.name;
  let msg = `Unidad: ${staff.venueName}\n`;
  if (code && name) msg += `Último comensal: ${name} (${code})\n`;
  msg +=
    `\nNo puedes abrir ticket con descuento todavía:\n${opsMessage}\n\n` +
    `Manda otro código cuando esté listo, o escribe ayuda.`;
  return msg;
}

export function helpText(
  state: string,
  staff: StaffContext,
  venues: StaffVenue[],
  canSwitch: boolean,
): string {
  const switchLine = canSwitch
    ? "cambiar unidad — otro local (solo sin comensal activo)\n"
    : "";
  switch (state) {
    case "selecting_venue":
      return venuePickerText(venues);
    case "consumer_identified":
      return (
        prefixActiveVenue(staff) +
        "Manda la cuenta en un mensaje o en varios:\n" +
        "• SUBTOTAL 850 y después PROPINA 100\n" +
        "• o 850 y luego 100\n" +
        "Montos en pesos. Escribe cancelar para empezar de nuevo."
      );
    case "awaiting_staff_payment_confirm":
      return prefixActiveVenue(staff) +
        "Cuando el comensal haya pagado su parte, responde listo o sí.";
    default:
      return (
        prefixActiveVenue(staff) +
        "Mesita Ops — ticket con descuento (tipo A)\n" +
        "1) Código del comensal (0000-0000)\n" +
        "2) SUBTOTAL y PROPINA por WhatsApp\n" +
        "3) El comensal recibe la cuenta en la app → Pay y confirma ahí\n" +
        "4) Tú respondes listo cuando cobres\n" +
        switchLine +
        "cancelar — reinicia la sesión del comensal (mantienes esta unidad)."
      );
  }
}

export function venuePickerText(venues: StaffVenue[]): string {
  const lines = venues.map((v, i) => `${i + 1}) ${v.venueName}`);
  return (
    "Trabajas en varios locales de Mesita.\n" +
    "¿En cuál estás hoy? (un WhatsApp = una unidad activa):\n\n" +
    lines.join("\n") +
    "\n\nResponde con el número (ej. 1) o el nombre del lugar.\n" +
    "Después puedes escribir cambiar unidad cuando no tengas un comensal activo."
  );
}

export function isSwitchVenueCommand(body: string): boolean {
  return /^(switch|cambiar(\s+unidad)?|unidad|sucursal|venue|unit)\b/i.test(
    body.trim(),
  );
}

export function parseVenueSelection(body: string, venues: StaffVenue[]): string | null {
  const t = body.trim();
  if (!t) return null;

  const numOnly = t.match(/^(\d+)$/);
  if (numOnly) {
    const idx = Number(numOnly[1]) - 1;
    if (idx >= 0 && idx < venues.length) return venues[idx].venueId;
  }

  const numPrefix = t.match(/^(?:venue|unidad|sucursal|unit)\s*#?\s*(\d+)/i);
  if (numPrefix) {
    const idx = Number(numPrefix[1]) - 1;
    if (idx >= 0 && idx < venues.length) return venues[idx].venueId;
  }

  const lower = t.toLowerCase();
  for (const v of venues) {
    const name = v.venueName.toLowerCase();
    if (lower === name || lower.includes(name) || name.includes(lower)) {
      return v.venueId;
    }
  }
  return null;
}
