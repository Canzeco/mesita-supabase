/** Session fallback when Content template (whatsapp/flows) is not configured. */

export function buildStaffInviteWhatsAppBody(opts: { venueName: string }): string {
  const { venueName } = opts;
  return `${venueName} te invita a Mesita Ops. Responde SI para unirte.`;
}
