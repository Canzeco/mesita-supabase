#!/usr/bin/env bash
# Publish Meta WhatsApp Flows from integrations/twilio/flows/*.flow.json
# and write flow_id into integrations/twilio/flows/registry.json
#
# Requires: META_WHATSAPP_ACCESS_TOKEN (System User token with whatsapp_business_management)
# Optional: WHATSAPP_WABA_ID (default from docs/whatsapp.md)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/_load-local-env.sh"

TOKEN="${META_WHATSAPP_ACCESS_TOKEN:-${WHATSAPP_ACCESS_TOKEN:-}}"
WABA_ID="${WHATSAPP_WABA_ID:-1389123139178386}"
REGISTRY="${ROOT}/integrations/twilio/flows/registry.json"
GRAPH="https://graph.facebook.com/v21.0"

if [[ -z "${TOKEN}" ]]; then
  echo "Set META_WHATSAPP_ACCESS_TOKEN in .env.twilio.local (Meta System User token)." >&2
  echo "Create the Flow manually in WhatsApp Manager → Flows, then paste flow_id into integrations/twilio/flows/registry.json" >&2
  exit 1
fi

apply_flow() {
  local key="$1"
  local file="$2"
  local first_page
  first_page="$(python3 -c "import json; d=json.load(open('${file}')); print(d['screens'][0]['id'])")"

  echo "==> Publishing flow: ${key} (first page: ${first_page})"

  local create_resp flow_id
  create_resp="$(curl -sS -X POST "${GRAPH}/${WABA_ID}/flows" \
    -H "Authorization: Bearer ${TOKEN}" \
    -F "name=mesita_${key}" \
    -F "categories[]=OTHER" \
    -F "flow_json=<${file}")"

  flow_id="$(echo "${create_resp}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('id',''))" 2>/dev/null || true)"
  if [[ -z "${flow_id}" ]]; then
    echo "    ✗ create failed:" >&2
    echo "${create_resp}" >&2
    exit 1
  fi
  echo "    created flow_id=${flow_id}"

  local pub_resp
  pub_resp="$(curl -sS -X POST "${GRAPH}/${flow_id}/publish" \
    -H "Authorization: Bearer ${TOKEN}")"
  local success
  success="$(echo "${pub_resp}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('success', False))" 2>/dev/null || echo "False")"
  if [[ "${success}" != "True" ]]; then
    echo "    ✗ publish failed:" >&2
    echo "${pub_resp}" >&2
    exit 1
  fi
  echo "    ✓ published"

  python3 - "${REGISTRY}" "${key}" "${flow_id}" "${first_page}" <<'PY'
import json, sys
path, key, flow_id, first_page = sys.argv[1:5]
with open(path) as f:
    reg = json.load(f)
reg[key] = {
    **reg.get(key, {}),
    "flow_id": flow_id,
    "first_page_id": first_page,
}
with open(path, "w") as f:
    json.dump(reg, f, indent=2)
    f.write("\n")
print(f"    registry updated: {path}")
PY
}

apply_flow "staff-invite-accept" "${ROOT}/integrations/twilio/flows/staff-invite-accept.flow.json"

echo ""
echo "Next: ./scripts/twilio-apply-templates.sh"
