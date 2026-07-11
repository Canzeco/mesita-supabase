// Unit tests for Selected Reservation Endpoint helpers (no network).
//   deno test supabase/functions/_shared/enrich-reservation-endpoint.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import {
  availableReservationChannels,
  buildReservationTarget,
  hasReservationTarget,
  mergeProductsReservations,
  preferReservationChannel,
  valueForReservationChannel,
} from "./enrich-reservation-endpoint.ts";

Deno.test("availableReservationChannels: only non-empty values", () => {
  assertEquals(
    availableReservationChannels({
      phone: "  +1 703-858-1102 ",
      whatsapp_url: "",
      instagram_url: null,
    }),
    ["phone"],
  );
  assertEquals(
    availableReservationChannels({
      phone: null,
      whatsapp_url: "https://wa.me/52155",
      instagram_url: "https://instagram.com/cafe",
    }),
    ["whatsapp", "instagram"],
  );
  assertEquals(availableReservationChannels({}), []);
});

Deno.test("preferReservationChannel: phone > whatsapp > instagram", () => {
  assertEquals(
    preferReservationChannel(["instagram", "whatsapp", "phone"]),
    "phone",
  );
  assertEquals(preferReservationChannel(["instagram", "whatsapp"]), "whatsapp");
  assertEquals(preferReservationChannel(["instagram"]), "instagram");
  assertEquals(preferReservationChannel([]), null);
});

Deno.test("valueForReservationChannel / buildReservationTarget", () => {
  const c = {
    phone: "+52 55 0000 0000",
    whatsapp_url: "https://wa.me/5255",
    instagram_url: "https://instagram.com/x",
  };
  assertEquals(valueForReservationChannel(c, "phone"), "+52 55 0000 0000");
  assertEquals(valueForReservationChannel(c, "whatsapp"), "https://wa.me/5255");
  assertEquals(
    buildReservationTarget("phone", c),
    { channel: "phone", value: "+52 55 0000 0000" },
  );
  assertEquals(buildReservationTarget("phone", { phone: "  " }), null);
});

Deno.test("hasReservationTarget: detects admin-selected channel", () => {
  assertEquals(hasReservationTarget(null), false);
  assertEquals(hasReservationTarget({ menu: [] }), false);
  assertEquals(hasReservationTarget({ reservations: { channel: "phone", value: "+1" } }), true);
  assertEquals(hasReservationTarget({ reservations: { channel: "email" } }), false);
  assertEquals(hasReservationTarget({ reservations: null }), false);
});

Deno.test("mergeProductsReservations: preserves menu and other keys", () => {
  const merged = mergeProductsReservations(
    { menu: [{ name: "Dinner" }], other: 1 },
    { channel: "whatsapp", value: "https://wa.me/1" },
  );
  assertEquals(merged.menu, [{ name: "Dinner" }]);
  assertEquals(merged.other, 1);
  assertEquals(merged.reservations, {
    channel: "whatsapp",
    value: "https://wa.me/1",
  });
  assertEquals(
    mergeProductsReservations(null, { channel: "phone", value: "+1" }),
    { reservations: { channel: "phone", value: "+1" } },
  );
});
