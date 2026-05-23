#!/usr/bin/env bash
# Smoke test the mcp-verify-vault stack end-to-end.
#
# Usage:
#   export CLINICIAN_TOKEN=<access token from a Verify sign-in for the clinician>
#   bash scripts/smoke-test.sh
#
# Pre-requisites:
#   - scripts/bootstrap-all.sh has been run
#   - mcp-server is running on http://127.0.0.1:3012 (cd mcp-server && npm run dev)
#   - infra/verify bootstrap has been run and the policy is ACTIVE in the Verify Admin UI

set -euo pipefail

MCP="${MCP:-http://127.0.0.1:3012}"
TOKEN="${CLINICIAN_TOKEN:?CLINICIAN_TOKEN must be set}"

echo "──────────────────────────────────────────────────────────────"
echo " Test 1: GET /healthz"
echo "──────────────────────────────────────────────────────────────"
curl -sf "${MCP}/healthz" && echo ""

run_tool() {
  local label="$1"
  local body="$2"
  local tmp status
  tmp=$(mktemp)
  echo ""
  echo "──────────────────────────────────────────────────────────────"
  echo " ${label}"
  echo "──────────────────────────────────────────────────────────────"
  status=$(curl -sS -o "${tmp}" -w "%{http_code}" -X POST "${MCP}/tool" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --max-time 120 \
    -d "${body}") || status="curl_failed"
  if [ "${status}" != "200" ]; then
    echo "HTTP ${status}"
    cat "${tmp}"
    echo ""
    rm -f "${tmp}"
    return 1
  fi
  python3 -m json.tool < "${tmp}"
  rm -f "${tmp}"
}

run_tool "Test 2: list_patients_for_clinician (no MFA expected)" '{"name":"list_patients_for_clinician","arguments":{}}'
run_tool "Test 3: get_patient_record for A0001 (non-VIP, no MFA expected)" '{"name":"get_patient_record","arguments":{"mrn":"A0001"}}'

echo ""
echo "──────────────────────────────────────────────────────────────"
echo " Test 4: get_patient_record for A0042 (VIP; expect a push to your phone)"
echo "──────────────────────────────────────────────────────────────"
echo " A push notification should land on the clinician's enrolled device."
echo " Approve it within 90 seconds."
run_tool "Test 4 result" '{"name":"get_patient_record","arguments":{"mrn":"A0042"}}'

echo ""
echo " All four tests returned. If Test 4 came back with the patient data,"
echo " the full chain (Verify Token Exchange → step-up MFA → OBO →"
echo " Vault verify-rar → ephemeral Postgres role → SELECT) is working."
