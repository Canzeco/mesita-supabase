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
| `/twilio-whatsapp-inbound` | Inbound messages |
| `/twilio-whatsapp-status` | Delivery receipts |

Apply via `./scripts/sync-twilio-whatsapp-webhooks.sh` or Twilio Console → WhatsApp Senders.

## Secrets

```bash
supabase secrets set \
  TWILIO_ACCOUNT_SID=AC... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_WHATSAPP_FROM_STAFF='whatsapp:+16282968794' \
  TWILIO_WHATSAPP_FROM_CONSUMERS='whatsapp:+16282964968'
```

Local scripts: `.env.twilio.local` (see `.env.twilio.local.example`).

## Templates & Flows (waiter invite)

| Asset | Path | Apply |
|---|---|---|
| In-chat Flow (`twilio/flows` — no Meta token) | `integrations/twilio/templates/staff-invite.json` | `./scripts/twilio-apply-templates.sh` |
| Optional Meta-native flow | `integrations/twilio/flows/staff-invite-accept.flow.json` | `./scripts/twilio-apply-flows.sh` (needs `META_WHATSAPP_ACCESS_TOKEN`) |
| Content SIDs (generated) | `integrations/twilio/content-sids.json` | written by apply script |
| Flow IDs (generated) | `integrations/twilio/flows/registry.json` | written by apply script |

**Order:** `./scripts/twilio-setup-staff-invite.sh` (templates + secret + deploy).

Uses **`twilio/flows`**: Twilio creates the Flow and Meta publishes it when the template is approved — only `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` required.

Optional `twilio-apply-flows.sh` only if you prefer Meta-built `whatsapp/flows` + `META_WHATSAPP_ACCESS_TOKEN`.

Waiter taps **Unirme** → in-chat form → **Confirmar**. Fallback: reply **SI** (session text).

Other templates: `integrations/twilio/templates/`. **Do not** create only in Console — definitions live in repo.

## Meta (manual)

- [Business Verification](https://business.facebook.com/latest/settings/security_center?business_id=1180640363250622)
- OBA (green ✓): optional, WhatsApp Manager per number

## Voice OTP tip

For Twilio-owned numbers, use **phone call** verification in Meta signup; SMS OTP lands in Twilio Messaging Logs.

## Staff WhatsApp — one active unit per phone

Business rules:

- Only **team staff** (`venue_roles.role = staff`) can use Mesita Ops for Type A tickets.
- One auth account may belong to **many units**; one unit may have **many staff**.
- **One WhatsApp number → one active venue at a time.** Tickets and discounts always apply to that unit.

If a waiter works at two partner venues, their first message (or `SWITCH`) shows a numbered list; they reply `1`, `2`, or the venue name. Guest codes and bills are blocked until a unit is selected. `SWITCH` only works when no guest session is open (`idle`); use `CANCEL` first if needed.

Session state is stored in `staff_whatsapp_sessions` (`venue_id` + `state`, including `selecting_venue`).
