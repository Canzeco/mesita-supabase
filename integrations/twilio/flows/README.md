# WhatsApp Flows (Meta)

In-chat forms for staff onboarding. **Not** web links.

| Flow | File | First screen |
|---|---|---|
| `staff-invite-accept` | `staff-invite-accept.flow.json` | `JOIN_TEAM` |

Publish: `./scripts/twilio-apply-flows.sh` → updates `registry.json` with `flow_id`.

The `staff-invite` Content template (`../templates/staff-invite.json`) attaches this flow and passes `flow_token` = `staff_invites.token`.
