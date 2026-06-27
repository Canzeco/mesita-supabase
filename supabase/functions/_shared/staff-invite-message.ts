/** Outbound waiter invite — natural-language WhatsApp (session or twilio/text template). */

export function buildStaffInviteWhatsAppBody(opts: { placeName: string }): string {
  const { placeName } = opts;
  return (
    `Hola — ${placeName} te invita a usar Mesita Ops por WhatsApp para tickets con descuento.\n\n` +
    `Si quieres unirte al equipo, responde sí a este mensaje.`
  );
}

// Single source of truth for the Twilio Content API "staff-invite" template
// body. Built from the same copy as the runtime message, with the place name
// rendered as Twilio's `{{1}}` positional placeholder so the two can never
// drift. Consumed by twilio-bootstrap-staff-invite.
export const STAFF_INVITE_TEMPLATE_BODY = buildStaffInviteWhatsAppBody({
  placeName: "{{1}}",
});
