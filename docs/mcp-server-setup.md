## MCP Deployment

The MCP server is the only process in the stack that handles the on-behalf-of (OBO) token. The clinician's access token arrives from the agent as a Bearer header. The MCP server exchanges that token at IBM Verify (RFC 8693), gets back a scoped OBO containing the Rich Authorization Request the policy approved, hands the OBO to Vault, gets back an ephemeral PostgreSQL role with a 5-minute lease, runs a single SELECT, returns the row to the agent, and revokes the lease. Everything Verify-side, everything Vault-side, every database statement happens in this one process. Read its log if anything in the chain looks wrong.

## Configure

Move into the MCP server directory and copy the example file:

```bash
cd mcp-server
cp .env.example .env
```

Open `.env` and fill in each value. The defaults that ship in the example file are correct for the local stack; the only ones you must change are the three that come from the previous two chapters.

```bash
# From your IBM Verify tenant
VERIFY_TENANT_HOST=<your-tenant>.verify.ibm.com

# From infra/verify/verify-output.json (the bootstrap output)
VERIFY_TE_CLIENT_ID=<token-exchange-client-id>

# From the Vault bootstrap printout in the previous chapter
VAULT_TOKEN=hvs.<your-mcp-token>

# Defaults that match the local stack; change only if you bind something elsewhere
VAULT_ADDR=http://127.0.0.1:8200
VAULT_ROLE=healthcare-records
POSTGRES_HOST=127.0.0.1
POSTGRES_PORT=5432
POSTGRES_DB=healthcare
PORT=3012
```

Notice there is **no `VERIFY_TE_CLIENT_SECRET`**. The MCP server fetches that secret from Vault on the first Token Exchange call (cached in process for five minutes), at `secret/data/VERIFY_TE_CLIENT_SECRET`. The Verify bootstrap (chapter 4) wrote it there automatically when you ran with `VAULT_ADDR` + `VAULT_TOKEN` set. The MCP's Vault token policy grants `read` on that path; nothing extra to configure here.

If your environment does not have Vault available and you ran the Verify bootstrap without `VAULT_ADDR` + `VAULT_TOKEN` set, the bootstrap printed the secret to your terminal instead. In that case uncomment the `VERIFY_TE_CLIENT_SECRET=` line in `.env.example` and paste the value. The MCP server uses the env var as a fallback when Vault is not reachable, so this same code runs against either pattern.

Be deliberate about each value. A wrong `VERIFY_TENANT_HOST` makes the Token Exchange fail with a DNS error; a stale `VAULT_TOKEN` makes Vault return 403 (both for the verify-rar call and for the secret fetch); a wrong `VAULT_ROLE` returns a `role not found` error. The test chapter has a one-paragraph diagnostic for each.

## Install and run

```bash
npm install
npm run dev
```

Expected:

```
[vva-mcp-server] listening on http://127.0.0.1:3012
[vva-mcp-server] /healthz, /tool, /mcp registered
```

The server runs in the foreground. Leave the terminal open; you will tail this log when you exercise the smoke test. If you want it in the background, you can run `npm run dev &`, but a foreground tail is more useful for the first run.

## Smoke

A trivial GET confirms the server is up and that nothing in its startup path threw an error.

```bash
curl http://127.0.0.1:3012/healthz
```

Expected:

```json
{"status":"ok","service":"vva-mcp-server"}
```

If you see `Connection refused`, the server is not running on port 3012; look at the terminal where you ran `npm run dev`. If you see `503 service unavailable`, the server started but a downstream check failed; the log has the reason.

## Behind the scenes

Once a real tool call arrives over the `/mcp` or `/tool` endpoint, the server performs steps 2 through 6 of the seven-step flow from the architecture chapter. The compressed walkthrough is worth reading once so the smoke-test output is not a mystery.

**Step 2: receive the call.** A POST arrives with `Authorization: Bearer <clinician access token>` and a JSON body naming a tool and arguments. The server validates the bearer is present (returns 401 if missing, before any other work) and looks up the tool handler.

**Step 3: build the Rich Authorization Request, exchange the token.** The tool handler builds an `authorization_details` block describing exactly the action it is about to do (operation = `read_patient_record`, target patient MRN, etc.). It POSTs an RFC 8693 Token Exchange to IBM Verify with the clinician's token as `subject_token`, the Token Exchange client credentials as the requesting client, and the RAR in the request body. For VIP reads, Verify returns `scope: mfa_challenge` and a challenge token; the server then triggers a push to the clinician's phone (`/v1.0/authenticators/{id}/verifications`) and polls for the assertion. Once the user approves, the server completes the exchange with a `jwt_bearer` grant that re-sends the RAR. The result is an OBO JWT.

**Step 4: present the OBO to Vault.** The server POSTs to `verify-rar/creds/<VAULT_ROLE>` with the OBO JWT as the `X-Vault-Token` header. Vault's verify-rar plugin validates the JWT signature against the Verify JWKS, matches the embedded `authorization_details` to a `rar_mapping` on the role, and runs the role's SQL template against `vva_admin` to mint a fresh ephemeral PostgreSQL role with a 5-minute lease.

**Step 5: query PostgreSQL.** The server opens a connection using the ephemeral role's username and password, runs the single SELECT for the patient record, and closes the connection.

**Step 6: revoke the lease, return.** The server POSTs to `sys/leases/revoke` with the lease id, which drops the ephemeral PostgreSQL role immediately rather than waiting for the 5-minute TTL. It returns the patient record JSON to the agent.

Every one of those sub-steps is logged. If the smoke test fails, the line in the MCP server log that does not have a matching success pair tells you where in the chain the problem is.

## What you just did

You configured the MCP server with the credentials from the IBM Verify bootstrap and the HashiCorp Vault bootstrap, started it on `127.0.0.1:3012`, and confirmed `/healthz` returns OK. The server is now ready to receive tool calls from an agent.

## What you'll do next

Move on to [Run the agent](./agent-setup.md) to install the Python + Strands agent's dependencies, configure your `.env`, and start the agent locally with `uvicorn`. The agent runs as a plain Python process — no AWS account, no managed runtime.