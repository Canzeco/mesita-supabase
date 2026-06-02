#!/usr/bin/env bash
# Create / update Twilio Content templates from integrations/twilio/templates/*.json
# Submit WhatsApp approval and write Content SIDs to integrations/twilio/content-sids.json
#
# Requires TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN (.env.twilio.local)
# For staff-invite (whatsapp/flows): run ./scripts/twilio-apply-flows.sh first

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/_load-local-env.sh"

ACCOUNT_SID="${TWILIO_ACCOUNT_SID:?Set TWILIO_ACCOUNT_SID}"
AUTH_TOKEN="${TWILIO_AUTH_TOKEN:?Set TWILIO_AUTH_TOKEN}"
TEMPLATES_DIR="${ROOT}/integrations/twilio/templates"
REGISTRY="${ROOT}/integrations/twilio/flows/registry.json"
OUT="${ROOT}/integrations/twilio/content-sids.json"
CONTENT_API="https://content.twilio.com/v1/Content"

auth=(-u "${ACCOUNT_SID}:${AUTH_TOKEN}")

flow_id_for_staff_invite() {
  python3 -c "import json; r=json.load(open('${REGISTRY}')); print(r.get('staff-invite-accept',{}).get('flow_id',''))"
}

apply_one() {
  local file="$1"
  local name
  name="$(basename "${file}" .json)"
  echo "==> Template: ${name}"

  local payload
  payload="$(python3 - "${file}" "${REGISTRY}" <<'PY'
import json, sys
path, reg_path = sys.argv[1], sys.argv[2]
with open(path) as f:
    tpl = json.load(f)
with open(reg_path) as f:
    reg = json.load(f)
raw = json.dumps(tpl)
if "__FLOW_ID_STAFF_INVITE_ACCEPT__" in raw:
    flow_id = reg.get("staff-invite-accept", {}).get("flow_id", "")
    if not flow_id:
        raise SystemExit("SKIP_FLOW_TEMPLATE")
    raw = raw.replace("__FLOW_ID_STAFF_INVITE_ACCEPT__", flow_id)
print(raw)
PY
)"

  local resp sid
  resp="$(curl -sS "${auth[@]}" -X POST "${CONTENT_API}" \
    -H "Content-Type: application/json" \
    -d "${payload}")"
  sid="$(echo "${resp}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('sid',''))" 2>/dev/null || true)"
  if [[ -z "${sid}" ]]; then
    echo "    ✗ create failed:" >&2
    echo "${resp}" >&2
    exit 1
  fi
  echo "    content_sid=${sid}"

  local category
  category="$(echo "${payload}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('category','UTILITY'))")"
  local approval_resp approval_status
  approval_resp="$(curl -sS "${auth[@]}" -X POST \
    "${CONTENT_API}/${sid}/ApprovalRequests/whatsapp" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"${name}\",\"category\":\"${category}\"}")"
  approval_status="$(echo "${approval_resp}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status',''))" 2>/dev/null || echo "submitted")"
  echo "    whatsapp approval: ${approval_status}"

  python3 - "${OUT}" "${name}" "${sid}" "${approval_status}" <<'PY'
import json, sys
out, name, sid, status = sys.argv[1:5]
try:
    with open(out) as f:
        data = json.load(f)
except FileNotFoundError:
    data = {}
data[name] = {
    "content_sid": sid,
    "whatsapp_approval": status,
    "updated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
}
with open(out, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

mkdir -p "$(dirname "${OUT}")"
echo '{}' > "${OUT}"

FLOW_ID="$(flow_id_for_staff_invite)"

for f in "${TEMPLATES_DIR}"/*.json; do
  [[ -f "${f}" ]] || continue
  base="$(basename "${f}" .json)"
  if [[ "${base}" == *-flow ]] && [[ -z "${FLOW_ID}" ]]; then
    echo "==> Template: ${base} (skipped — no Meta flow_id)"
    continue
  fi
  apply_one "${f}"
done

echo ""
staff_sid="$(python3 -c "
import json
d=json.load(open('${OUT}'))
print(d.get('staff-invite-flow',{}).get('content_sid') or d.get('staff-invite',{}).get('content_sid',''))
")"
if [[ -n "${staff_sid}" ]]; then
  echo "Primary ContentSid for TWILIO_CONTENT_SID_STAFF_INVITE: ${staff_sid}"
  echo "Or run: ./scripts/twilio-setup-staff-invite.sh  (applies + sets Supabase secret + deploys)"
else
  echo "No staff-invite ContentSid created." >&2
  exit 1
fi
