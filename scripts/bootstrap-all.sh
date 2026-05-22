#!/usr/bin/env bash
# One-shot local bring-up for the mcp-verify-vault stack.
#
# What this does:
#   1. docker compose up -d   (Postgres + Vault dev)
#   2. waits for Postgres healthcheck
#   3. waits for Vault to respond
#   4. runs infra/vault/bootstrap-vault.sh  (registers plugin, creates role + policy)
#   5. prints the MCP-server Vault token + the verify-output.json reminders
#
# What this does NOT do:
#   - the Verify bootstrap (cd infra/verify && npm run bootstrap)
#   - the MCP server start (cd mcp-server && npm run dev)
#   - the agent start (cd agent && uvicorn healthcare_agent.main:app --host 127.0.0.1 --port 8080)
# Those three are customer-driven (each runs in its own foreground terminal).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}/infra"

if [ ! -f .env ]; then
  echo "[bootstrap-all] Creating infra/.env from .env.example (using local-dev defaults)"
  cp .env.example .env
fi

# ── 1. Compose up ────────────────────────────────────────────────────────────
echo "[bootstrap-all] Starting Postgres + Vault dev containers..."
docker compose up -d

# ── 2. Wait for Postgres healthcheck ─────────────────────────────────────────
echo -n "[bootstrap-all] Waiting for Postgres "
for i in {1..30}; do
  if docker inspect --format='{{.State.Health.Status}}' vva-postgres 2>/dev/null | grep -q healthy; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 1
done

# ── 3. Wait for Vault ───────────────────────────────────────────────────────
echo -n "[bootstrap-all] Waiting for Vault "
for i in {1..30}; do
  if curl -s http://127.0.0.1:8200/v1/sys/health 2>/dev/null | grep -q '"initialized":true'; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 1
done

# ── 4. Sanity-check the plugin binary is in place ────────────────────────────
if ! docker exec vva-vault test -x /vault/plugins/vault-plugin-secrets-verify-rar; then
  echo ""
  echo "ERROR: The verify-rar plugin binary is not in infra/vault/plugins/."
  echo "See infra/vault/docs/PLUGINS.md for how to obtain the binary."
  echo "Short version: request it from support@iamidentity.ai."
  echo ""
  echo "(The Postgres + Vault containers are still running. Drop the binary"
  echo " into infra/vault/plugins/, then re-run this script.)"
  exit 1
fi

# ── 5. Run Vault bootstrap (prompts for VERIFY_TENANT_URL) ───────────────────
if [ -z "${VERIFY_TENANT_URL:-}" ]; then
  echo ""
  echo "[bootstrap-all] VERIFY_TENANT_URL is not set in the current shell."
  echo "Export it before running this script, e.g.:"
  echo "  export VERIFY_TENANT_URL=https://<your-tenant>.verify.ibm.com"
  echo "  bash scripts/bootstrap-all.sh"
  exit 1
fi

echo "[bootstrap-all] Bootstrapping Vault (plugin + role + policy)..."
bash "${REPO_ROOT}/infra/vault/bootstrap-vault.sh"

echo ""
echo "[bootstrap-all] Done. Next steps:"
echo "  1. cd infra/verify && npm install && cp .env.example .env  # then fill in your Verify admin creds"
echo "  2. cd infra/verify && npm run probe                         # confirm tenant reachable"
echo "  3. cd infra/verify && npm run bootstrap                      # creates attribute, policy, OIDC apps"
echo "  4. Copy verify-output.json values into mcp-server/.env"
echo "  5. cd mcp-server && npm install && npm run dev"
echo "  6. cd agent && python3 -m venv .venv && source .venv/bin/activate && pip install -e ."
echo "  7. cd agent && cp .env.example .env  # set ANTHROPIC_API_KEY"
echo "  8. cd agent && uvicorn healthcare_agent.main:app --host 127.0.0.1 --port 8080"
echo ""
echo "Then run scripts/smoke-test.sh with a clinician access token."
