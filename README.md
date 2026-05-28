# Securing Your MCP Server End-to-End: IBM Verify + HashiCorp Vault

> A 30-minute hands-on walkthrough that lands a working MCP server on your laptop where every tool call is authorized by IBM Verify policy (with step-up MFA where the policy demands it) and runs under a 5-minute PostgreSQL credential that HashiCorp Vault mints fresh per call. No AWS account required.

## Start here

The cookbook PDF (`MCP-COOKBOOK-V1.pdf`) lands in this repo after the first customer-trial pass and is the canonical customer-facing artifact. Until it does, read the chapters under [`docs/`](docs/) in this order:

1. [`architecture.md`](docs/architecture.md) — the seven-step flow
2. [`identity-chain.md`](docs/identity-chain.md) — the security story up front
3. [`verify-setup.md`](docs/verify-setup.md) — configure your IBM Verify tenant
4. [`vault-setup.md`](docs/vault-setup.md) — bring up Vault + the verify-rar plugin
5. [`postgres-setup.md`](docs/postgres-setup.md) — bring up the clinical database
6. [`mcp-server-setup.md`](docs/mcp-server-setup.md) — start the MCP server
7. [`agent-setup.md`](docs/agent-setup.md) — start the Python + Strands agent
8. [`smoke-test.md`](docs/smoke-test.md) — exercise the full chain end-to-end
9. [`llm-options.md`](docs/llm-options.md) — swap the LLM provider
10. [`mcp-anatomy.md`](docs/mcp-anatomy.md) — verbatim code walkthrough of the security gates
11. [`troubleshooting.md`](docs/troubleshooting.md) — the common gotchas
12. [`siem-logging.md`](docs/siem-logging.md) — audit surfaces and the `jti` join key

## What you'll build

A healthcare MCP server that exposes two tools to an AI agent — `list_patients_for_clinician` and `get_patient_record` — where every call passes through this chain:

1. An agent (any agent — the cookbook ships a Python + Strands + FastAPI reference) forwards the clinician's IBM Verify access token to the MCP server.
2. The MCP server runs an RFC 8693 Token Exchange with an RFC 9396 Rich Authorization Request describing exactly the action it is about to perform.
3. IBM Verify evaluates the request against an access policy. For VIP reads the policy fires `ACTION_MFA_ALWAYS` and a push lands on the clinician's phone; once approved, Verify signs the authorization details into a short-lived on-behalf-of JWT.
4. The MCP server presents the OBO directly to HashiCorp Vault, where the verify-rar plugin validates the JWT signature against the Verify JWKS, matches the embedded RAR against the role's mappings, and mints a brand-new PostgreSQL credential with a 5-minute lease.
5. The MCP server runs one `SELECT` as that ephemeral role, returns the row, and revokes the lease.

The MCP server never makes a local authorization decision. The agent has no security responsibilities at all. The agent is a transport; the MCP server is the security perimeter; Verify is the policy decision point; Vault is the credential broker.

## What's in this repo

| Path | What it is |
|---|---|
| `MCP-COOKBOOK-V1.pdf` | The cookbook (added after the customer-trial pass — read `docs/` until then). |
| `infra/` | Docker compose for the local PostgreSQL + HashiCorp Vault stack, the verify-rar plugin slot, and the IBM Verify tenant bootstrap script. |
| `mcp-server/` | TypeScript MCP server. Two transports (`/tool` REST and `/mcp` Streamable HTTP), the RFC 8693 + RAR + `mfa_challenge` two-leg Token Exchange handler, the Vault verify-rar client, and the ephemeral-role Postgres pool. |
| `agent/` | Python + Strands + FastAPI agent. `uvicorn healthcare_agent.main:app` runs it on a laptop or any host that runs Python. Four pluggable LLM providers via `LLM_PROVIDER` (Anthropic direct by default, plus Bedrock, OpenAI, Gemini as opt-in extras). |
| `docs/` | Per-chapter markdown sources for the cookbook (the source of truth for the PDF). |
| `scripts/` | One-shot helpers: `install-prereqs.sh` (macOS toolchain via Colima), `bootstrap-all.sh` (Docker stack), `get-clinician-token.sh` (PKCE token grabber), `smoke-test.sh` (exercise the chain). |

## Prerequisites

Docker, Node 22+, Python 3.11+, an IBM Verify tenant where you can create OIDC applications and access policies, an Anthropic API key (or another LLM provider's key if you swap), and the IBM Verify mobile app installed on a phone with a push factor enrolled for the clinician test account. No AWS account is required.

**On macOS**, you can install Docker (via Colima, no Docker Desktop), Node, Python, and the rest with a single command:

```bash
bash scripts/install-prereqs.sh
```

That installs Colima as the Docker daemon, then `colima start`, then sanity-checks `docker info`. Idempotent.

## For contributors

The PDF will be the customer artifact (once it lands); the per-chapter markdown in `docs/` is the contributor source of truth. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the prose-style rules that apply to any PR.

## License

See [`LICENSE`](LICENSE).
