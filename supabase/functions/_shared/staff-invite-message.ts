/** One-shot WhatsApp body for waiter / staff invite (session message). */

export function buildStaffInviteWhatsAppBody(opts: {
  venueName: string;
  shareUrl: string;
}): string {
  const { venueName, shareUrl } = opts;
  return (
    `Mesita · team invite\n\n` +
    `${venueName} invited you as floor staff (waiter).\n\n` +
    `Accept on this phone:\n${shareUrl}\n\n` +
    `Open the link, sign in with the same WhatsApp number, and you're set.`
  );
}
