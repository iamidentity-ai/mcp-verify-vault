#!/usr/bin/env bash
# Bootstrap Vault dev mode for the mcp-verify-vault cookbook.
# Idempotent: run as many times as you like.
#
# Pre-requisites:
#   - `docker compose up -d vault` is already running.
#   - The compiled verify-rar plugin binary is in infra/vault/plugins/.
#   - VAULT_ADDR and VAULT_TOKEN are set (or take the defaults below).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Source infra/.env so the customer can put their values in one file instead
# of exporting on the command line. Safe to run if the file does not exist.
if [ -f "${INFRA_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${INFRA_DIR}/.env"
  set +a
fi

export VAULT_ADDR="${VAULT_ADDR:-http://127.0.0.1:8200}"
# VAULT_DEV_ROOT_TOKEN is the canonical name in infra/.env (matches the value
# docker-compose passes to the vault container). Accept VAULT_TOKEN as an
# alias for back-compat with the bootstrap-all.sh workflow.
export VAULT_TOKEN="${VAULT_TOKEN:-${VAULT_DEV_ROOT_TOKEN:-vva-dev-root-token}}"

PLUGIN_BIN_NAME="vault-plugin-secrets-verify-rar"
PLUGIN_MOUNT="verify-rar"
PLUGIN_ROLE="healthcare-records"

POSTGRES_HOST="${POSTGRES_HOST:-host.docker.internal}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-healthcare}"
POSTGRES_ADMIN_USER="${POSTGRES_ADMIN_USER:-vva_admin}"
POSTGRES_ADMIN_PASSWORD="${POSTGRES_ADMIN_PASSWORD:-vva_admin_local_dev_only}"

# The rest of the cookbook uses VERIFY_TENANT_HOST (hostname only, no scheme).
# Accept that as the canonical input and synthesize VERIFY_TENANT_URL from it.
# Keep VERIFY_TENANT_URL as an override for anyone who exports it directly.
if [ -z "${VERIFY_TENANT_URL:-}" ] && [ -n "${VERIFY_TENANT_HOST:-}" ]; then
  VERIFY_TENANT_URL="https://${VERIFY_TENANT_HOST}"
fi
VERIFY_TENANT_URL="${VERIFY_TENANT_URL:?VERIFY_TENANT_HOST (preferred) or VERIFY_TENANT_URL must be set. Add VERIFY_TENANT_HOST=<your-tenant>.verify.ibm.com to infra/.env.}"
VERIFY_JWKS_URI="${VERIFY_JWKS_URI:-${VERIFY_TENANT_URL%/}/oauth2/jwks}"

echo "[bootstrap] Vault addr: ${VAULT_ADDR}"
echo "[bootstrap] Plugin:     ${PLUGIN_BIN_NAME}"
echo "[bootstrap] Role:       ${PLUGIN_ROLE}"
echo ""

# ── 1. Sanity-check the plugin binary is mounted in the container ────────────
if ! docker exec vva-vault test -x "/vault/plugins/${PLUGIN_BIN_NAME}"; then
  echo "ERROR: /vault/plugins/${PLUGIN_BIN_NAME} not found or not executable inside the vault container."
  echo "       Build the plugin (see infra/vault/plugins/README.md) and copy the binary into infra/vault/plugins/."
  exit 1
fi

# ── 2. Compute the SHA256 of the plugin binary (Vault uses it for registration)
PLUGIN_SHA=$(docker exec vva-vault sha256sum "/vault/plugins/${PLUGIN_BIN_NAME}" | awk '{print $1}')
echo "[bootstrap] Plugin SHA256: ${PLUGIN_SHA}"

# ── 3. Register the plugin in the catalog (idempotent: same SHA = no-op) ─────
docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
  vault plugin register -sha256="${PLUGIN_SHA}" secret "${PLUGIN_BIN_NAME}" \
  || true
echo "[bootstrap] Plugin registered in catalog."

# ── 4. Enable the secrets engine at verify-rar/ (idempotent) ─────────────────
if ! docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
     vault secrets list -format=json | grep -q "\"${PLUGIN_MOUNT}/\""; then
  docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
    vault secrets enable -path="${PLUGIN_MOUNT}" -plugin-name="${PLUGIN_BIN_NAME}" plugin
  echo "[bootstrap] Secrets engine enabled at ${PLUGIN_MOUNT}/."
else
  echo "[bootstrap] Secrets engine already enabled at ${PLUGIN_MOUNT}/."
fi

# ── 5. Configure the Postgres connection the plugin will use to mint roles ───
# Plugin schema (from path_config.go):
#   name           Logical name; role.db_name references this
#   connection_url Postgres DSN with {{username}} and {{password}} placeholders
#                  (the plugin substitutes from the next two fields at connect
#                  time, so they are never embedded in the stored URL string).
#   username       Management user (must have CREATE ROLE)
#   password       Management password (never returned via read)
docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
  vault write "${PLUGIN_MOUNT}/config/db" \
    name=healthcare \
    connection_url="postgresql://{{username}}:{{password}}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}?sslmode=disable" \
    username="${POSTGRES_ADMIN_USER}" \
    password="${POSTGRES_ADMIN_PASSWORD}"
echo "[bootstrap] Database connection written to ${PLUGIN_MOUNT}/config/db/healthcare."

# ── 6. JWT validation note (NO config/oauth-rs write -- the verify-rar plugin
#       does NOT define that path) ─────────────────────────────────────────────
#
# The plugin reads JWT claims from one of two sources:
#   - Vault Enterprise's OAuth-RS profile, which pre-validates the JWT in
#     X-Vault-Token against the Verify JWKS and populates req.Auth.Identity.Claims.
#   - The "claims" field in the POST body, populated by the workload after
#     it decodes the OBO itself.
#
# Vault dev mode (the image this cookbook uses) is the OSS edition, which does
# NOT have OAuth-RS profiles. The cookbook MCP server therefore decodes the
# OBO itself and passes the claims in the request body. No Vault-side config
# is required for JWT validation in this cookbook.
echo "[bootstrap] JWT claims will be passed in the request body by the MCP server (Vault OSS path)."

# ── 7. Write the role definition with RAR mappings ────────────────────────────
# Plugin schema (from path_roles.go in the verify-rar plugin source):
#   db_name      -> the connection name written to config/db (here: "healthcare")
#   max_ttl      -> hard cap on the ephemeral credential's lease
#   rar_mappings -> map of "<RAR-type>|<RAR-action>" -> {grants:[...]}
#                   each grant SQL gets {{name}} substituted with the
#                   safely-quoted ephemeral user name at mint time.
#
# The plugin owns CREATE ROLE + DROP ROLE itself; do NOT pass
# creation_statements or revocation_statements (those are Vault's stock
# database engine fields, not this plugin's).
#
# Two RAR shapes are accepted, both granted the same healthcare_read_template
# SQL role (the difference between them is the Verify access-policy step-up,
# not the credential shape).
# 'vault write' deserializes the rar_mappings string as a flat KV and Vault
# then rejects it with "'' expected a map, got 'string'" because the value
# is supposed to be a real JSON object, not a stringified one. POST to the
# HTTP API directly via curl so the JSON body lands unmodified.
#
# We run curl from the host (not via docker exec) because the Vault Alpine
# image does not ship curl in its PATH, and the Vault container's 8200
# is already mapped to localhost:8200 by docker-compose. This requires curl
# to be installed on the host (standard on Mac and Linux).
curl -sf -X POST \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d @- \
  "${VAULT_ADDR}/v1/${PLUGIN_MOUNT}/roles/${PLUGIN_ROLE}" <<'EOF'
{
  "db_name": "healthcare",
  "max_ttl": "300s",
  "rar_mappings": {
    "urn:smt:agent:healthcare|patient_read": {
      "grants": ["GRANT healthcare_read_template TO \"{{name}}\""]
    },
    "urn:smt:agent:healthcare|patient_read_vip": {
      "grants": ["GRANT healthcare_read_template TO \"{{name}}\""]
    }
  }
}
EOF
echo "[bootstrap] Role ${PLUGIN_ROLE} written with 5-minute TTL."

# ── 8. Ensure the KV v2 secrets engine is mounted at secret/ ─────────────────
# Vault dev mode mounts KV v2 at secret/ by default, but the explicit check
# makes this script work against a non-dev Vault as well.
if ! docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
     vault secrets list -format=json | grep -q '"secret/"'; then
  docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
    vault secrets enable -path=secret -version=2 kv
  echo "[bootstrap] KV v2 secrets engine enabled at secret/."
else
  echo "[bootstrap] KV v2 secrets engine already enabled at secret/."
fi

# ── 9. Write the policy and create a token for the MCP server ────────────────
docker cp "${INFRA_DIR}/vault/policies/healthcare-mcp.hcl" vva-vault:/tmp/healthcare-mcp.hcl
docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
  vault policy write healthcare-mcp /tmp/healthcare-mcp.hcl
echo "[bootstrap] Policy healthcare-mcp written."

MCP_TOKEN=$(docker exec -e VAULT_TOKEN="${VAULT_TOKEN}" -e VAULT_ADDR="http://127.0.0.1:8200" vva-vault \
  vault token create -policy=healthcare-mcp -ttl=24h -format=json | jq -r .auth.client_token)
echo ""
echo "==============================================================="
echo " MCP server Vault token (24h TTL, policy healthcare-mcp):"
echo "   ${MCP_TOKEN}"
echo ""
echo " Put this in mcp-server/.env as VAULT_TOKEN=..."
echo "==============================================================="
