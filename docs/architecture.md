## Deployment and Architecture

You are about to wire up a small but complete identity and authorization chain. Read this once, slowly. Spending five minutes here saves an hour of confusion later.

## The picture

A clinician on a workstation signs into the agent with their IBM Verify token. The agent forwards that token to the MCP server. The MCP server exchanges the token at IBM Verify (RFC 8693 Token Exchange) and asks for a scoped on-behalf-of token, attaching a Rich Authorization Request (RFC 9396) that describes the exact action it wants to perform. IBM Verify evaluates a policy against the request; for high-risk reads it triggers a step-up MFA push on the clinician's phone. Once the policy allows the action, IBM Verify mints a short-lived OBO token. The MCP server presents that OBO to HashiCorp Vault, where the verify-rar plugin validates the JWT signature against the Verify JWKS, matches the embedded authorization details to a role mapping, and mints a 5-minute PostgreSQL credential. The MCP server uses that credential to run a single SELECT, returns the row, and the lease expires.

## What you are building, in one paragraph

A working reference for an AI agent that does the right thing under enterprise identity. The clinician's identity flows end-to-end as standards-based JWTs. The agent itself never holds long-lived database credentials. Each tool call mints a fresh, scoped, time-bound credential and discards it. High-risk reads require a human to approve with their phone before any data leaves the database. Every step writes audit records that share a single correlation id (`jti`) so a SOC can replay any chain from the SIEM.

## The seven steps, one paragraph each

**Step 1: Clinician to Agent.** A clinician opens a chat with the agent and submits a prompt such as "show me patient A0042's record." The clinician's browser or calling application carries the clinician's access token from IBM Verify in the request to the agent.

**Step 2: Agent to MCP server.** The agent decides which tool to invoke (here, `get_patient_record`). It opens a Model Context Protocol connection to the local MCP server and forwards the clinician's access token as a Bearer header. The agent does no authorization decisions; it is a transport.

**Step 3: MCP server to IBM Verify.** The MCP server takes the clinician's token as the `subject_token` for an RFC 8693 Token Exchange. It builds an RFC 9396 `authorization_details` block describing the action (operation = `read_patient_record`, location = `mrn:A0042`) and POSTs the exchange to IBM Verify. This is the only place in the system that uses the long-lived Token Exchange client secret.

**Step 4: IBM Verify policy evaluation and step-up MFA.** IBM Verify reads the `authorization_details` and evaluates the access policy bound to the Token Exchange application. For the VIP read, the policy fires `ACTION_MFA_ALWAYS`: Verify returns a `mfa_challenge` token (not an OBO) on the first leg, the MCP server uses it to trigger a push at `/v1.0/authenticators/{factor_id}/verifications` and polls the transaction URI until the clinician approves, then submits a second-leg exchange with `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` re-sending the same `authorization_details`. Verify mints a short-lived OBO JWT carrying the original RAR and a unique `jti` claim. For non-VIP reads, the policy fires `ACTION_ALLOW` and the OBO comes back on the first leg with no push.

**Step 5: MCP server to Vault.** The MCP server presents the OBO JWT directly to HashiCorp Vault as the `X-Vault-Token` header. Vault's verify-rar plugin validates the JWT signature against the Verify JWKS, matches the embedded `authorization_details` to one of the role's `rar_mappings`, and mints a fresh PostgreSQL role with a 5-minute lease.

**Step 6: MCP server to PostgreSQL.** The MCP server opens a database connection as the ephemeral role (the role name and password came back from Vault) and runs a single `SELECT` against the `clinical.patients` table. The database logs the statement under the ephemeral role name.

**Step 7: Lease revoke and return.** The MCP server explicitly revokes the Vault lease as soon as the SELECT completes. The ephemeral PostgreSQL role is dropped. The MCP server returns the patient record to the agent, the agent streams the answer back to the clinician, and the chain ends.

## What lives where

Four processes run on your machine. You start each one yourself and you can see all of their logs.

1.  **PostgreSQL container.** The clinical database. Tables: `clinical.clinicians`, `clinical.patients`, `clinical.visits`. Seeded with ten patients (two flagged VIP) and one clinician. Comes up with `docker compose up -d postgres`.
2.  **HashiCorp Vault container, in dev mode.** Hosts the verify-rar plugin that does the per-call credential mint. Comes up with `docker compose up -d vault`. Bootstrap creates the role, the policy, and a 24-hour token for the MCP server.
3.  **MCP server, on your host.** A Node 22 process listening on `127.0.0.1:3012`. Handles Model Context Protocol requests, performs the Token Exchange, talks to Vault, queries PostgreSQL.
4.  **Agent process, on your host.** A Python 3.11+ FastAPI server listening on `127.0.0.1:8080`. Runs the Strands agent loop. Receives `POST /invoke` from your calling app with the clinician's Bearer token, forwards the token to the MCP server, streams the model's response back.

No cloud accounts and no AWS dependencies. The agent has no AWS account requirement, no IAM role, no managed runtime. It is just a Python process.

## What you are NOT installing

The local stack is intentionally small. The following are common assumptions about an enterprise agent platform that you do not need for this cookbook:

*   No AWS account, no Bedrock subscription, no IAM policies. The agent runs locally as a Python process; the default LLM is Anthropic direct.
*   No managed agent-hosting runtime. The agent is `uvicorn` running a FastAPI app, on your laptop or anywhere else that runs Python.
*   No Kubernetes. The three local services run as plain Docker containers, a Node process, and a Python process.
*   No Cloudflare or other tunnel service. Everything binds to `127.0.0.1`.
*   No NAT gateway, VPC endpoint, or private link. The local stack does not need outbound access beyond Verify and your chosen LLM provider.
*   No SPIRE server. Workload identity to Vault is unnecessary because the OBO JWT itself is the credential Vault validates.
*   No central event bus, CAEP transmitter, or session-revoke fabric. Auditing is via the standard surfaces (Vault audit, PostgreSQL log, agent log, Verify event stream) and is covered in `docs/siem-logging.md`.
*   No bespoke aggregator or correlation engine. Every record carries the OBO `jti` and a SIEM joins on that field.

For this test deployment, they are not in the critical path for a working end-to-end demo on a laptop.

## What you just did

You read the system end-to-end. You can name the actor on each side of every step and you know which of the four services owns which step.

## What you'll do next

Move on to [Configure IBM Verify](./verify-setup.md) to set up the tenant-side pieces: the custom attribute that detects the healthcare RAR, the access policy that triggers step-up MFA, and the two OIDC applications the rest of the chain refers back to.