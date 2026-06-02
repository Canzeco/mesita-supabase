#!/usr/bin/env bash
# One-shot staff-invite setup: local Twilio scripts OR prod bootstrap EF + secret + deploy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT}"
PROJECT_REF="${SUPABASE_PROJECT_REF:-yjalywfzdelacdzccpgb}"

echo "==> Mesita staff-invite Twilio setup"

SID=""
if "${ROOT}/scripts/twilio-apply-templates.sh" 2>/dev/null; then
  SID="$(python3 -c "
import json
d=json.load(open('${ROOT}/integrations/twilio/content-sids.json'))
print(d.get('staff-invite-flow',{}).get('content_sid') or d.get('staff-invite',{}).get('content_sid',''))
")"
fi

if [[ -z "${SID}" ]]; then
  echo "==> Local Twilio auth failed — bootstrapping via Edge Function (prod secrets)"
  supabase functions deploy twilio-bootstrap-staff-invite --project-ref "${PROJECT_REF}" >/dev/null
  RESP="$(supabase functions invoke twilio-bootstrap-staff-invite \
    --project-ref "${PROJECT_REF}" \
    --method POST \
    --body '{}' 2>/dev/null || true)"
  SID="$(echo "${RESP}" | python3 -c "
import json,sys
raw=sys.stdin.read().strip()
try:
  d=json.loads(raw)
except json.JSONDecodeError:
  print(''); sys.exit(0)
if isinstance(d, dict) and 'contentSid' in d:
  print(d['contentSid'])
elif isinstance(d, dict) and d.get('ok') and 'contentSid' in str(d):
  print(d.get('contentSid',''))
else:
  print(d.get('contentSid','') if isinstance(d,dict) else '')
" 2>/dev/null || true)"
  if [[ -z "${SID}" ]]; then
    echo "Bootstrap response: ${RESP}" >&2
    echo "Fix TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in Supabase secrets, then re-run." >&2
    exit 1
  fi
  python3 - "${ROOT}/integrations/twilio/content-sids.json" "${SID}" <<'PY'
import json, sys
path, sid = sys.argv[1], sys.argv[2]
data = {"staff-invite": {"content_sid": sid, "whatsapp_approval": "submitted", "source": "bootstrap-ef"}}
with open(path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
fi

"${ROOT}/scripts/twilio-apply-flows.sh" 2>/dev/null || true

echo "==> Setting Supabase secret TWILIO_CONTENT_SID_STAFF_INVITE=${SID}"
supabase secrets set "TWILIO_CONTENT_SID_STAFF_INVITE=${SID}" --project-ref "${PROJECT_REF}"

echo "==> Deploying edge functions"
supabase functions deploy business-invite-waiter twilio-whatsapp-inbound --project-ref "${PROJECT_REF}"

echo ""
echo "Done. TWILIO_CONTENT_SID_STAFF_INVITE=${SID}"
