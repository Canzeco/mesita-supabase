// Venue ownership OTP (/add phone & email verify).
//
// HARD RULE: do not call, SMS, or email any venue's real listed contact until
// placeVenueOtpOutbound() is implemented and reviewed. Mock-only for now.

/** Always true until outbound is deliberately implemented (not env-toggle alone). */
export function isVenueOtpMockMode(): boolean {
  return !venueOtpOutboundImplemented();
}

/**
 * Flip to true only when business-send-phone-otp / -email-otp actually place
 * outbound traffic AND product has signed off. Until then, venues are never contacted.
 */
export function venueOtpOutboundImplemented(): boolean {
  return false;
}

/** Guard for future Twilio/Resend wiring — throws if called while still mock-only. */
export function assertVenueOtpOutboundAllowed(): void {
  if (!venueOtpOutboundImplemented()) {
    throw new Error(
      "venue_otp_outbound_disabled: mock mode only — venues must not be called or emailed yet",
    );
  }
}

/** Shown in the business app instead of the venue's real listed phone. */
export function mockVenueOtpPhone(): string {
  const fromEnv = Deno.env.get("MOCK_VENUE_OTP_PHONE")?.trim();
  if (fromEnv) return fromEnv;
  return "+1 628 555 0100";
}

export function mockVenueOtpEmail(): string {
  const fromEnv = Deno.env.get("MOCK_VENUE_OTP_EMAIL")?.trim();
  if (fromEnv) return fromEnv;
  return "verify@mesita.ai";
}
