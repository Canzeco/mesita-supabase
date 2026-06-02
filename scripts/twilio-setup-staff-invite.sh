#!/usr/bin/env bash
# One-shot: create twilio/text staff-invite template, set Supabase secret, deploy EFs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"
PROJECT_REF="${SUPABASE_PROJECT_REF:-yjalywfzdelacdzccpgb}"

echo "==> Mesita staff-invite (natural language, twilio/text)"

SID=""
if "${ROOT}/scripts/twilio-apply-templates.sh" 2>/dev/null; then
  SID="$(python3 -c "import json; print(json.load(open('${ROOT}/integrations/twilio/content-sids.json')).get('staff-invite',{}).get('content_sid',''))")"
fi

if [[ -z "${SID}" ]]; then
  echo "==> Local Twilio failed — bootstrap via Edge Function (prod credentials)"
  supabase functions deploy twilio-bootstrap-staff-invite --project-ref "${PROJECT_REF}" >/dev/null
  RESP="$(supabase functions invoke twilio-bootstrap-staff-invite \
    --project-ref "${PROJECT_REF}" \
    --method POST \
    --body '{}' 2>&1 || true)"
  SID="$(printf '%s' "${RESP}" | python3 -c "import json,sys; raw=sys.stdin.read();
for line in raw.splitlines():
  line=line.strip()
  if not line or line[0] not in '{': continue
  try: d=json.loads(line)
  except: continue
  if d.get('contentSid'): print(d['contentSid']); break
  if d.get('ok') and d.get('contentSid'): print(d['contentSid']); break
")"
  if [[ -z "${SID}" ]]; then
    echo "${RESP}" >&2
    exit 1
  fi
fi

echo "==> TWILIO_CONTENT_SID_STAFF_INVITE=${SID}"
supabase secrets set "TWILIO_CONTENT_SID_STAFF_INVITE=${SID}" --project-ref "${PROJECT_REF}"

supabase functions deploy business-invite-waiter twilio-whatsapp-inbound --project-ref "${PROJECT_REF}"

echo "Done. Waiter invites are natural language (responde sí). Approve template in Twilio Console if pending."
