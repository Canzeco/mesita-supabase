/** One-shot WhatsApp body for waiter / staff invite (session message, no links). */

export function buildStaffInviteWhatsAppBody(opts: { venueName: string }): string {
  const { venueName } = opts;
  return (
    `Mesita · equipo\n\n` +
    `${venueName} te invita como mesero/a (staff).\n\n` +
    `Para unirte, responde aquí mismo:\n` +
    `SI\n\n` +
    `(mismo número de WhatsApp — sin links ni app)\n\n` +
    `Después podrás validar tickets desde este chat.`
  );
}
