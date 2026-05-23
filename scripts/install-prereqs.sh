#!/usr/bin/env bash
# Install macOS prerequisites for the mcp-verify-vault cookbook.
#
# Idempotent: re-running is safe. Only installs what is missing.
#
# What this script installs:
#   * Colima            (Docker daemon for macOS, no Docker Desktop required)
#   * docker / compose / buildx CLIs
#   * node              (Node 22+, for the MCP server and the Verify bootstrap)
#   * python@3.12       (Python 3.12, for the agent venv)
#   * jq, git, gh       (standard tooling)
#
# What this script does NOT install (do these yourself, see docs/cookbook-prereqs.md):
#   * An IBM Verify tenant or admin API client
#   * An Anthropic API key (or whichever LLM provider you swap to)
#   * The IBM Verify mobile app on your phone
#   * The verify-rar plugin binary (email support@iamidentity.ai)
#
# Usage:
#   bash scripts/install-prereqs.sh

set -euo pipefail

# ── macOS-only guard ────────────────────────────────────────────────────────
if [ "$(uname)" != "Darwin" ]; then
  echo "ERROR: this script is macOS-only."
  echo ""
  echo "On Linux, install the equivalents via your distro's package manager:"
  echo "  Docker Engine    apt install docker.io  (or follow Docker's docs)"
  echo "  Node 22+         use your distro's package manager or nvm"
  echo "  Python 3.11+     usually already installed"
  echo "  jq, git, gh      apt install jq git gh"
  exit 1
fi

# ── Homebrew guard ──────────────────────────────────────────────────────────
if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew is required to install the toolchain."
  echo ""
  echo "Install it from https://brew.sh/ — paste the curl install line into a"
  echo "terminal, then re-run this script."
  exit 1
fi

echo "[install-prereqs] Checking macOS prerequisites for mcp-verify-vault..."
echo ""

install_if_missing() {
  local formula="$1"
  if brew list --formula "$formula" >/dev/null 2>&1; then
    printf "  \xE2\x9C\x93 %s (installed)\n" "$formula"
  else
    printf "  \xE2\xAC\x87 installing %s\n" "$formula"
    brew install "$formula" >/dev/null
    printf "  \xE2\x9C\x93 %s installed\n" "$formula"
  fi
}

install_if_missing colima
install_if_missing docker
install_if_missing docker-compose
install_if_missing docker-buildx
install_if_missing node
install_if_missing python@3.12
install_if_missing jq
install_if_missing git
install_if_missing gh

echo ""
echo "[install-prereqs] All base tools installed."

# ── Start Colima if it isn't running ────────────────────────────────────────
echo ""
if colima status >/dev/null 2>&1; then
  echo "[install-prereqs] Colima is already running."
else
  echo "[install-prereqs] Starting Colima (Docker daemon backend, no Desktop)."
  echo "                  First start takes about 30 seconds and downloads a"
  echo "                  small Linux VM image. Subsequent starts are faster."
  colima start --cpu 4 --memory 8 --disk 60
fi

# ── Confirm Docker is reachable ─────────────────────────────────────────────
DOCKER_VER=$(docker info --format '{{.ServerVersion}}' 2>/dev/null || true)
if [ -z "$DOCKER_VER" ]; then
  echo ""
  echo "ERROR: Docker daemon is not reachable after colima start."
  echo "Try: colima delete && colima start --cpu 4 --memory 8 --disk 60"
  exit 1
fi

# ── Final report ────────────────────────────────────────────────────────────
cat <<EOF

==================================================================
  Prerequisites installed.
  Docker engine: ${DOCKER_VER} (via Colima on macOS Virtualization.Framework)
==================================================================

Next steps (one-time per fresh clone of this repo):

  cd infra/verify && npm install
  cd mcp-server && npm install
  cd agent && python3.12 -m venv .venv && source .venv/bin/activate && pip install -e .

You also need (see docs/cookbook-prereqs.md for the full list):

  * An IBM Verify tenant + an admin API client (chapter 5 walks the click path).
  * An Anthropic API key from console.anthropic.com (set in agent/.env).
  * The IBM Verify mobile app + an enrolled push factor on your clinician
    test account.
  * The verify-rar plugin binary (email support@iamidentity.ai).

Then start the cookbook at docs/architecture.md.
EOF
