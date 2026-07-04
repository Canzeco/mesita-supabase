// Place ownership OTP (/add phone & email verify).
//
// HARD RULE: do not call, SMS, or email any place's real listed contact until
// placePlaceOtpOutbound() is implemented and reviewed. Mock-only for now.

/** Always true until outbound is deliberately implemented (not env-toggle alone). */
export function isPlaceOtpMockMode(): boolean {
  return !placeOtpOutboundImplemented();
}

/**
 * Flip to true only when business-web-send-phone-otp / -email-otp actually place
 * outbound traffic AND product has signed off. Until then, places are never contacted.
 */
export function placeOtpOutboundImplemented(): boolean {
  return false;
}

/** Guard for future Twilio/Resend wiring — throws if called while still mock-only. */
export function assertPlaceOtpOutboundAllowed(): void {
  if (!placeOtpOutboundImplemented()) {
    throw new Error(
      "place_otp_outbound_disabled: mock mode only — places must not be called or emailed yet",
    );
  }
}

/** Shown in the business app instead of the place's real listed phone. */
export function mockPlaceOtpPhone(): string {
  const fromEnv = Deno.env.get("MOCK_PLACE_OTP_PHONE")?.trim();
  if (fromEnv) return fromEnv;
  return "+1 628 555 0100";
}

export function mockPlaceOtpEmail(): string {
  const fromEnv = Deno.env.get("MOCK_PLACE_OTP_EMAIL")?.trim();
  if (fromEnv) return fromEnv;
  return "verify@mesita.ai";
}
