# WhatsApp (Twilio) — runbook

Operational detail for Mesita WhatsApp. Architecture overview: [README.md](../README.md).

## IDs

| | ID |
|---|---|
| Meta Business Portfolio (Mesita) | `1180640363250622` |
| WABA | `1389123139178386` |
| Staff sender | `+1 628 296 8794` — Mesita Ops |
| Consumer sender | `+1 628 296 4968` — Mesita Notifications |
| Recording TwiML bin | `EHfd33bff85448c2a934494625fb70d808` |

## Webhook URLs (prod)

Base: `https://yjalywfzdelacdzccpgb.supabase.co/functions/v1`

| Endpoint | Function |
|---|---|
| `/business-whats-handle-message` | Inbound messages |
| `/twilio-webhook-update-delivery` | Delivery receipts |

Apply via `./scripts/sync-twilio-whatsapp-webhooks.sh` or Twilio Console → WhatsApp Senders.

## Secrets

```bash
supabase secrets set \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_WHATSAPP_FROM_STAFF='whatsapp:+16282968794' \
  TWILIO_WHATSAPP_FROM_CONSUMERS='whatsapp:+16282964968' \
  TWILIO_CONTENT_SID_STAFF_INVITE=HX...
```

Local scripts: `.env.twilio.local` (see `.env.twilio.local.example`).

## Waiter invite — natural language (default)

| Asset | Path |
|---|---|
| Content template (`twilio/text`) | `integrations/twilio/templates/staff-invite.json` |
| Invite message copy | `supabase/functions/_shared/staff-invite-message.ts` |

**Setup:**

```bash
./scripts/twilio-setup-staff-invite.sh
```

Flow:

1. Manager **Add waiter** → WhatsApp con texto natural (“responde sí…”).
2. Waiter responde **sí** (o sí quiero, listo, vale, etc.).
3. `business-whats-handle-message` los da de alta en el equipo.

No mencionar botones ni flows en copy hasta que exista un Flow aprobado. Más adelante se puede añadir [WhatsApp Flows](https://developers.facebook.com/documentation/business-messaging/whatsapp/flows) solo para el paso final de confirmación.

Approve `staff-invite` in [Twilio Console → Content](https://console.twilio.com/us1/develop/sms/content-template-builder) if outbound template is pending.

## Billing

WhatsApp message fees go through **Twilio** (Twilio fee + Meta pass-through on the same invoice). No separate Meta invoice for traffic via Twilio.

## Meta (manual)

- [Business Verification](https://business.facebook.com/latest/settings/security_center?business_id=1180640363250622)
- OBA (green ✓): optional, WhatsApp Manager per number

## Staff WhatsApp — one active unit per phone

- Only **team staff** (`project_roles.role = staff`) can use Mesita Ops for Type A tickets.
- **One WhatsApp number → one active place at a time.** Escribe **cambiar unidad** para cambiar.

Session state: `staff_whatsapp_sessions`.

Transcript (last 20 messages per phone) for LLM context: `staff_whatsapp_messages` (service-role only, no Realtime).

## Type A flow (staff WhatsApp → consumer Pay)

1. Staff sends guest **code** → verified in WhatsApp.
2. Staff sends **subtotal + tip** (one or several messages).
3. Edge function creates ticket + row in `consumer_pay_notifications` (`kind: bill`).
4. **Consumer** sees it on **Mesita app → Pay → QR and Tickets** (Realtime on `consumer_pay_notifications`; ticket card shows place photo, total reward, passive Pay step / Review).
5. Guest pays at the table; staff replies **listo** (or taps **Paid received** in the business console) when cash/terminal is collected.

Staff coach replies are **static** (no LLM rewrite) so WhatsApp never invents amounts or codes. Optional WhatsApp text to the guest phone is secondary; the app Pay notification is the source of truth.
