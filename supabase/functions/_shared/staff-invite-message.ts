/** Outbound waiter invite — natural-language WhatsApp (session or twilio/text template). */

export function buildStaffInviteWhatsAppBody(opts: { venueName: string }): string {
  const { venueName } = opts;
  return (
    `Hola — ${venueName} te invita a usar Mesita Ops por WhatsApp para tickets con descuento.\n\n` +
    `Si quieres unirte al equipo, responde sí a este mensaje.`
  );
}
