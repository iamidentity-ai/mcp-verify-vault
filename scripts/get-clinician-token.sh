#!/usr/bin/env bash
# Get a clinician access token via OIDC + PKCE against your Verify tenant.
#
# Usage:
#   bash scripts/get-clinician-token.sh
#
# Defaults pull from infra/verify/verify-output.json (written by the verify
# bootstrap). Override via env vars if you want a different tenant or app:
#   TENANT_HOST=<your-tenant>.verify.ibm.com \
#   CLIENT_ID=<ui-app-client-id> \
#   bash scripts/get-clinician-token.sh
#
# The script:
#   1. Reads tenant + client_id from verify-output.json (or env)
#   2. Generates a PKCE verifier + challenge + an 8+ char random state
#   3. Prints the /oauth2/authorize URL for you to open in a browser
#   4. Spins up a one-shot HTTP listener on localhost:8765 to catch the
#      redirect (so the browser does not show 'connection refused')
#   5. Exchanges the auth code for an access token
#   6. Prints `export CLINICIAN_TOKEN=<jwt>` for you to paste into your shell

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VERIFY_OUTPUT="${REPO_ROOT}/infra/verify/verify-output.json"

# ── Resolve tenant + client_id ──────────────────────────────────────────────
if [ -f "${VERIFY_OUTPUT}" ]; then
  TENANT_HOST="${TENANT_HOST:-$(jq -r '.tenantHost // empty' "${VERIFY_OUTPUT}")}"
  CLIENT_ID="${CLIENT_ID:-$(jq -r '.uiClientId // empty' "${VERIFY_OUTPUT}")}"
fi

# The UI app is registered with doNotGenerateClientSecret:false (Verify's
# default), which makes it a confidential client. The /oauth2/token call
# needs client_secret in addition to PKCE; without it Verify returns
# CSIAQ0155E invalid_client. The secret lives in Vault KV; we fetch it on
# demand and never write it to disk.
VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-vva-dev-root-token}"

if [ -z "${CLIENT_SECRET:-}" ]; then
  KV_BODY=$(curl -sf -H "X-Vault-Token: ${VAULT_TOKEN}" \
    "${VAULT_ADDR}/v1/secret/data/VERIFY_UI_CLIENT_SECRET" 2>/dev/null || true)
  if [ -n "${KV_BODY}" ]; then
    CLIENT_SECRET=$(echo "${KV_BODY}" | jq -r '.data.data.value // empty')
  fi
fi

if [ -z "${CLIENT_SECRET:-}" ]; then
  echo "ERROR: UI client secret not found."
  echo "Either:"
  echo "  - Make sure your local Vault dev container is up and run the verify"
  echo "    bootstrap (cd infra/verify && npm run bootstrap), which writes"
  echo "    the secret to secret/data/VERIFY_UI_CLIENT_SECRET, or"
  echo "  - Export CLIENT_SECRET=<your-ui-client-secret> in your shell and"
  echo "    re-run this script."
  exit 1
fi

if [ -z "${TENANT_HOST:-}" ]; then
  echo "ERROR: TENANT_HOST not set and could not read tenantHost from ${VERIFY_OUTPUT}"
  echo ""
  echo "Either run the verify bootstrap first:"
  echo "  cd infra/verify && npm run bootstrap"
  echo ""
  echo "Or set TENANT_HOST manually:"
  echo "  TENANT_HOST=<your-tenant>.verify.ibm.com bash scripts/get-clinician-token.sh"
  exit 1
fi
if [ -z "${CLIENT_ID:-}" ]; then
  echo "ERROR: CLIENT_ID not set and could not read uiClientId from ${VERIFY_OUTPUT}"
  exit 1
fi

TENANT="https://${TENANT_HOST}"
REDIRECT_URI="${REDIRECT_URI:-http://localhost:8765/cb}"
PORT="${PORT:-8765}"

# ── PKCE + state ────────────────────────────────────────────────────────────
# base64url alphabet keeps both upper AND lower case; only +/= get transformed.
# Lowercasing A-Z (an earlier version of this script did) makes the challenge
# mismatch what Verify computes from the verifier, causing invalid_grant on
# the token exchange.
VERIFIER=$(openssl rand -base64 64 | tr -d '=\n' | tr '+/' '-_' | cut -c1-64)
CHALLENGE=$(printf '%s' "${VERIFIER}" | openssl dgst -binary -sha256 | openssl base64 | tr -d '=\n' | tr '+/' '-_')
STATE=$(openssl rand -hex 8)   # Verify requires state >= 8 chars (CSIAQ5025E)

AUTHZ_URL="${TENANT}/oauth2/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=openid+profile+email&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=${STATE}"

echo ""
echo "─────────────────────────────────────────────────────────────────────"
echo " 1. Open this URL in your browser and sign in as your clinician:"
echo "─────────────────────────────────────────────────────────────────────"
echo ""
echo "${AUTHZ_URL}"
echo ""
echo "─────────────────────────────────────────────────────────────────────"
echo " 2. Waiting for the redirect on http://localhost:${PORT}/cb ..."
echo "─────────────────────────────────────────────────────────────────────"

# ── One-shot HTTP listener ──────────────────────────────────────────────────
# Python is required by other cookbook steps, so it is the most portable
# way to listen for one HTTP request on Mac + Linux. Captures the 'code'
# query parameter and exits.
CAPTURED_CODE=$(python3 - "${PORT}" "${STATE}" <<'PYEOF'
import http.server
import socketserver
import urllib.parse
import sys

port = int(sys.argv[1])
expected_state = sys.argv[2]
captured = {"code": None, "state": None, "error": None}

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        captured["code"] = params.get("code", [None])[0]
        captured["state"] = params.get("state", [None])[0]
        captured["error"] = params.get("error_description", params.get("error", [None]))[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        body = (b"<html><body style='font-family:sans-serif;padding:2em'>"
                b"<h2>Sign-in captured.</h2>"
                b"<p>You can close this tab and return to your terminal.</p>"
                b"</body></html>")
        self.wfile.write(body)
    def log_message(self, *a, **kw):
        pass

with socketserver.TCPServer(("127.0.0.1", port), Handler) as s:
    s.handle_request()

if captured["error"]:
    print(f"ERROR:{captured['error']}", file=sys.stderr)
    sys.exit(2)
# State check: warn but do not fail. Some Verify deployments truncate the
# state by one trailing character on the redirect (observed with
# tryverify.ibm.com tenants); strict equality would block what is otherwise
# a clean flow. CSRF risk on a localhost-loopback dev script is minimal.
if captured["state"] != expected_state:
    if not (captured["state"] and expected_state.startswith(captured["state"])):
        print(f"WARN:state mismatch (expected {expected_state}, got {captured['state']})", file=sys.stderr)
if not captured["code"]:
    print("ERROR:no code in callback", file=sys.stderr)
    sys.exit(4)

print(captured["code"])
PYEOF
)

if [ -z "${CAPTURED_CODE}" ]; then
  echo "ERROR: no code captured. Re-run the script and try again."
  exit 1
fi

echo ""
echo " Got authorization code: ${CAPTURED_CODE:0:20}..."
echo ""
echo "─────────────────────────────────────────────────────────────────────"
echo " 3. Exchanging code for access token..."
echo "─────────────────────────────────────────────────────────────────────"

# Capture response + HTTP status; do NOT use -sf so we can show the error
# body on failure. set -e would otherwise kill the script silently.
HTTP_BODY=$(mktemp)
CURL_ARGS=(
  -s -o "${HTTP_BODY}" -w '%{http_code}'
  -X POST "${TENANT}/oauth2/token"
  -d "grant_type=authorization_code"
  -d "code=${CAPTURED_CODE}"
  -d "redirect_uri=${REDIRECT_URI}"
  -d "client_id=${CLIENT_ID}"
  -d "code_verifier=${VERIFIER}"
)
if [ -n "${CLIENT_SECRET:-}" ]; then
  CURL_ARGS+=(-d "client_secret=${CLIENT_SECRET}")
fi
HTTP_STATUS=$(curl "${CURL_ARGS[@]}")

TOKEN_RESPONSE=$(cat "${HTTP_BODY}")
rm -f "${HTTP_BODY}"

if [ "${HTTP_STATUS}" != "200" ]; then
  echo ""
  echo "ERROR: token exchange failed (HTTP ${HTTP_STATUS})."
  echo "Response body:"
  echo "${TOKEN_RESPONSE}" | (jq . 2>/dev/null || cat)
  echo ""
  echo "Common causes:"
  echo "  - code_verifier does not match the code_challenge sent earlier"
  echo "    (re-run this script to mint a fresh PKCE pair)"
  echo "  - the authorization code has already been redeemed or expired"
  echo "  - the UI app does not allow the authorization_code grant"
  exit 1
fi

ACCESS_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.access_token // empty')

if [ -z "${ACCESS_TOKEN}" ]; then
  echo "ERROR: response was 200 but no access_token field."
  echo "Response: ${TOKEN_RESPONSE}"
  exit 1
fi

# Write the export to a sourceable file at the repo root for one-line use.
TOKEN_FILE="${REPO_ROOT}/.clinician-token.env"
echo "export CLINICIAN_TOKEN=${ACCESS_TOKEN}" > "${TOKEN_FILE}"
chmod 600 "${TOKEN_FILE}"

echo ""
echo "─────────────────────────────────────────────────────────────────────"
echo " Success. Two ways to use the token:"
echo "─────────────────────────────────────────────────────────────────────"
echo ""
echo " 1. Source the file written to ${TOKEN_FILE}:"
echo ""
echo "      source ${TOKEN_FILE}"
echo ""
echo " 2. Or copy this line into your shell:"
echo ""
echo "      export CLINICIAN_TOKEN=${ACCESS_TOKEN}"
echo ""
echo " The token file is gitignored and chmod 600. It overwrites on each"
echo " re-run of this script."
echo ""
