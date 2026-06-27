// Place selection + session persistence for staff WhatsApp Type A.

import { type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { displayConsumerCode } from "./consumer-code.ts";
import type {
  SessionRow,
  StaffContext,
  StaffIdentity,
  StaffPlace,
  PlaceOption,
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

export async function enterPlaceSelection(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
  places: StaffPlace[],
): Promise<SessionRow> {
  const options: PlaceOption[] = places.map((v) => ({
    project_id: v.projectId,
    name: v.placeName,
  }));

  if (session) {
    const updated = await admin
      .from("staff_whatsapp_sessions")
      .update({
        state: "selecting_project",
        project_id: null,
        consumer_id: null,
        ticket_id: null,
        pending_consumer_code: null,
        context: { place_options: options },
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
      project_id: null,
      state: "selecting_project",
      context: { place_options: options },
    })
    .select("*")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data as SessionRow;
}

export async function applyActivePlace(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
  place: StaffPlace,
): Promise<SessionRow> {
  if (session) {
    const updated = await admin
      .from("staff_whatsapp_sessions")
      .update({
        project_id: place.projectId,
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
      project_id: place.projectId,
      state: "idle",
    })
    .select("*")
    .single();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data as SessionRow;
}

export async function resolveActivePlace(
  admin: SupabaseClient,
  identity: StaffIdentity,
  session: SessionRow | null,
): Promise<
  | { kind: "ok"; staff: StaffContext; session: SessionRow }
  | { kind: "need_selection"; session: SessionRow }
> {
  const places = identity.places;
  if (places.length === 0) {
    throw new Error("staff has no project_roles");
  }

  if (places.length === 1) {
    const sessionOut = await applyActivePlace(admin, identity, session, places[0]);
    return {
      kind: "ok",
      staff: { ...identity, ...places[0] },
      session: sessionOut,
    };
  }

  if (!session) {
    const created = await enterPlaceSelection(admin, identity, null, places);
    return { kind: "need_selection", session: created };
  }

  if (session.state === "selecting_project" || !session.project_id) {
    return { kind: "need_selection", session };
  }

  const active = places.find((v) => v.projectId === session.project_id);
  if (!active) {
    const created = await enterPlaceSelection(admin, identity, session, places);
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
  projectId: string | null,
) {
  await admin
    .from("staff_whatsapp_sessions")
    .update({
      state: projectId ? "idle" : "selecting_project",
      consumer_id: null,
      ticket_id: null,
      pending_consumer_code: null,
      context: {},
    })
    .eq("id", sessionId);
}

export function prefixActivePlace(staff: StaffContext): string {
  return `Unidad: ${staff.placeName}\n`;
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
  let msg = `Unidad: ${staff.placeName}\n`;
  if (code && name) msg += `Último comensal: ${name} (${code})\n`;
  msg +=
    `\nNo puedes abrir ticket con descuento todavía:\n${opsMessage}\n\n` +
    `Manda otro código cuando esté listo, o escribe ayuda.`;
  return msg;
}

export function helpText(
  state: string,
  staff: StaffContext,
  places: StaffPlace[],
  canSwitch: boolean,
): string {
  const switchLine = canSwitch
    ? "cambiar unidad — otro local (solo sin comensal activo)\n"
    : "";
  switch (state) {
    case "selecting_project":
      return placePickerText(places);
    case "consumer_identified":
      return (
        prefixActivePlace(staff) +
        "Manda la cuenta en un mensaje o en varios:\n" +
        "• SUBTOTAL 850 y después PROPINA 100\n" +
        "• o 850 y luego 100\n" +
        "Montos en pesos. Escribe cancelar para empezar de nuevo."
      );
    case "awaiting_staff_payment_confirm":
      return prefixActivePlace(staff) +
        "Cuando el comensal haya pagado su parte, responde listo o sí.";
    default:
      return (
        prefixActivePlace(staff) +
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

export function placePickerText(places: StaffPlace[]): string {
  const lines = places.map((v, i) => `${i + 1}) ${v.placeName}`);
  return (
    "Trabajas en varios locales de Mesita.\n" +
    "¿En cuál estás hoy? (un WhatsApp = una unidad activa):\n\n" +
    lines.join("\n") +
    "\n\nResponde con el número (ej. 1) o el nombre del lugar.\n" +
    "Después puedes escribir cambiar unidad cuando no tengas un comensal activo."
  );
}

export function isSwitchPlaceCommand(body: string): boolean {
  return /^(switch|cambiar(\s+unidad)?|unidad|sucursal|place|unit)\b/i.test(
    body.trim(),
  );
}

export function parsePlaceSelection(body: string, places: StaffPlace[]): string | null {
  const t = body.trim();
  if (!t) return null;

  const numOnly = t.match(/^(\d+)$/);
  if (numOnly) {
    const idx = Number(numOnly[1]) - 1;
    if (idx >= 0 && idx < places.length) return places[idx].projectId;
  }

  const numPrefix = t.match(/^(?:place|unidad|sucursal|unit)\s*#?\s*(\d+)/i);
  if (numPrefix) {
    const idx = Number(numPrefix[1]) - 1;
    if (idx >= 0 && idx < places.length) return places[idx].projectId;
  }

  const lower = t.toLowerCase();
  for (const v of places) {
    const name = v.placeName.toLowerCase();
    if (lower === name || lower.includes(name) || name.includes(lower)) {
      return v.projectId;
    }
  }
  return null;
}
