#!/usr/bin/env bash
# Assemble COOKBOOK.md at the repo root from the per-chapter docs/*.md files.
#
# The per-chapter docs/*.md files are the single source of truth that
# contributors edit. COOKBOOK.md is the assembled, numbered narrative the
# customer reads end-to-end (and that scripts/render-cookbook.py converts
# to COOKBOOK.docx).
#
# Re-run after editing any docs/<chapter>.md file:
#   bash scripts/assemble-cookbook.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Two parallel arrays. Keep these arrays in lockstep with the TOC in
# docs/cookbook-header.md (architecture is chapter 1; SIEM is chapter 14).
CHAPTERS=(
  "architecture"
  "identity-chain"
  "cookbook-prereqs"
  "cookbook-clone"
  "verify-setup"
  "vault-setup"
  "postgres-setup"
  "mcp-server-setup"
  "agent-setup"
  "smoke-test"
  "llm-options"
  "mcp-anatomy"
  "troubleshooting"
  "siem-logging"
)

TITLES=(
  "Architecture"
  "The identity chain"
  "Prerequisites"
  "Clone the repo"
  "Configure IBM Verify"
  "Configure HashiCorp Vault"
  "Configure PostgreSQL"
  "Start the MCP server"
  "Run the agent"
  "End-to-end smoke test"
  "Swapping the LLM"
  "Anatomy of an MCP call"
  "Troubleshooting"
  "Logging for an enterprise SIEM"
)

# Start the output with the header (title, intro, TOC).
cat docs/cookbook-header.md > COOKBOOK.md

# Append each chapter under a "## N. Title" heading.
for i in "${!CHAPTERS[@]}"; do
  n=$((i + 1))
  chapter="${CHAPTERS[$i]}"
  title="${TITLES[$i]}"

  if [ ! -f "docs/${chapter}.md" ]; then
    echo "ERROR: docs/${chapter}.md is missing." >&2
    exit 1
  fi

  {
    echo ""
    echo "## ${n}. ${title}"
    echo ""
    cat "docs/${chapter}.md"
  } >> COOKBOOK.md
done

echo "Wrote COOKBOOK.md ($(wc -l < COOKBOOK.md) lines, $(wc -w < COOKBOOK.md) words)."
