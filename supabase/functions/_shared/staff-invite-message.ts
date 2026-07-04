/** Outbound waiter invite — natural-language WhatsApp (session or twilio/text template). */

export function buildStaffInviteWhatsAppBody(opts: { placeName: string }): string {
  const { placeName } = opts;
  return (
    `Hola — ${placeName} te invita a usar Mesita Ops por WhatsApp para tickets con descuento.\n\n` +
    `Si quieres unirte al equipo, responde sí a este mensaje.`
  );
}
