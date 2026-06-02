/** Session fallback when Content template (whatsapp/flows) is not configured. */

export function buildStaffInviteWhatsAppBody(opts: { venueName: string }): string {
  const { venueName } = opts;
  return (
    `Mesita · equipo\n\n` +
    `${venueName} te invita como mesero/a.\n\n` +
    `Si recibes el botón «Unirme», úsalo. Si no, responde SI aquí.\n\n` +
    `Todo en este chat — sin links.`
  );
}
