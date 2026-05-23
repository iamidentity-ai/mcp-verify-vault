## Full end to end test

You have all five pieces running. Time to prove the chain works end-to-end with one script. The full end to end test exercises three flavors of tool call: health check, an unauthenticated 401, a normal read with no MFA, and a VIP read that triggers a push to your phone. If all four pass, every arrow in the architecture diagram is wired correctly.

## Pre-requisites

Run the prior chapters first. Specifically, before you start this one you need:

*   Docker stack up: `docker compose -f infra/docker-compose.yml ps` shows both `vva-postgres` and `vva-vault` as `running`.
*   MCP server running on `127.0.0.1:3012`: `curl -s http://127.0.0.1:3012/healthz` returns the OK JSON.
*   Agent running on `127.0.0.1:8080`: `uvicorn healthcare_agent.main:app --host 127.0.0.1 --port 8080` in its own terminal. `curl -s http://127.0.0.1:8080/healthz` returns the OK JSON.
*   A clinician access token. The next section walks you through getting one.

## How to get a clinician access token

The MCP server expects a real IBM Verify access token for a clinician in your tenant. The repo ships a one-shot helper at `scripts/get-clinician-token.sh` that runs the OIDC authorization-code + PKCE flow against the UI application your Verify bootstrap created. It handles the three traps that bite a hand-rolled PKCE script (base64url alphabet preserving case, `state` length ≥ 8 characters, the confidential-client `client_secret` Verify requires alongside PKCE) and writes the resulting token to a sourceable file so a long JWT never has to survive a terminal copy-paste.

```bash
bash scripts/get-clinician-token.sh
```

The script prints an authorize URL, opens a one-shot HTTP listener on `localhost:8765` to catch the redirect (so the browser does not show a `connection refused` page), exchanges the code for an access token, and writes it to `.clinician-token.env` at the repo root (chmod 600, gitignored). It pulls the tenant host, UI client id, and UI client secret it needs from `infra/verify/verify-output.json` and from Vault KV — nothing for you to paste.

Expected (abridged):

```
─────────────────────────────────────────────────────────────────────
 1. Open this URL in your browser and sign in as your clinician:
─────────────────────────────────────────────────────────────────────

https://<your-tenant>.verify.ibm.com/oauth2/authorize?...

─────────────────────────────────────────────────────────────────────
 2. Waiting for the redirect on http://localhost:8765/cb ...
─────────────────────────────────────────────────────────────────────

 Got authorization code: ...
 3. Exchanging code for access token...

─────────────────────────────────────────────────────────────────────
 Success. Two ways to use the token:
─────────────────────────────────────────────────────────────────────

 1. Source the file written to <repo>/.clinician-token.env:

      source .clinician-token.env
```

Open the URL in a browser, sign in as the clinician whose `upn` matches the `CLINICIAN_UPN` value in `agent/.env`, and the script does the rest. Then load the token into your shell:

```bash
source .clinician-token.env
echo "${CLINICIAN_TOKEN:0:20}..."
```

The token is valid for ~1 hour (IBM Verify's default access-token lifetime). If a later step returns `CSIAQ0158E` ("authorization_grant of type user_code does not exist or is invalid" — misleading message; really means the token expired or was revoked), re-run `bash scripts/get-clinician-token.sh` to mint a fresh one. See [troubleshooting #14](./troubleshooting.md#14-token-exchange-returns-csiaq0158e-authorization_grant-of-type-user_code-does-not-exist-or-is-invalid) for the full diagnosis.

## Run the test

The script `scripts/smoke-test.sh` runs four tests in order and prints results to stdout.

```bash
bash scripts/smoke-test.sh
```

Expected (four sections, abridged):

```
Test 1: GET /healthz
{"status":"ok","service":"vva-mcp-server"}

Test 2: list_patients_for_clinician (no MFA expected)
{
  "patients": [
    {"mrn": "A0001", "display_name": "Anderson, ...", ...},
    ... ten rows ...
  ]
}

Test 3: get_patient_record for A0001 (non-VIP, no MFA expected)
{
  "mrn": "A0001",
  "display_name": "Anderson, ...",
  "visits": [ ... ]
}

Test 4: get_patient_record for A0042 (VIP, expect a push to your phone)
   A push notification should land on the clinician's enrolled device.
   Approve it within 90 seconds.
   ... waits ...
{
  "mrn": "A0042",
  "display_name": "Thornton, ...",
  "visits": [ ... ]
}

All four tests returned. The full chain is working.
```

## What to look for on Test 4

Test 4 is the proof. The flow is, in order:

1.  The script POSTs `get_patient_record` for MRN `A0042` to the MCP server.
2.  The MCP server starts the Token Exchange against IBM Verify. Verify's access policy fires `ACTION_MFA_ALWAYS` because the RAR matches the `healthcareVipRequest` attribute.
3.  IBM Verify pushes a notification to the clinician's enrolled mobile device.
4.  The MCP server log shows the poll loop: `[verify] polling MFA assertion (attempt 1)... (attempt 2)...`.
5.  You tap **Approve** on your phone.
6.  The MCP server log shows `[verify] MFA approved after N attempts`.
7.  The MCP server hands the resulting OBO JWT to Vault. The PostgreSQL log shows the CREATE ROLE, GRANT, SELECT, REASSIGN, and DROP ROLE statements firing in under a second.
8.  The MCP server returns the patient record JSON to the smoke-test script.

If your phone never rings, you did not get to step 3. The most common reasons are listed in the next section.

## If it didn't work

**401 on Test 1.** The MCP server is not running, or it is running on a different port than `3012`. Check the terminal running `npm run dev` and look for the `listening on http://127.0.0.1:3012` line. If the terminal shows a different port, edit `mcp-server/.env` and set `PORT=3012` (or update `MCP=` at the top of the smoke-test script).

**401 on Test 2.** The clinician access token is expired or for the wrong tenant. IBM Verify access tokens default to a one-hour lifetime; if more than an hour has passed since you ran the authorize flow, repeat it. If the token is fresh, the most likely cause is `VERIFY_TENANT_HOST` in `mcp-server/.env` not matching the tenant that minted the token; double-check both.

**Test 4 hangs.** Two common causes. First, the access policy in IBM Verify is in state `IDLE` rather than `ACTIVE`. Sign into the Admin UI, open **Security** then **Policies**, find **Healthcare-VIP-Step-Up**, click into it, click Save then Publish. The policy state column should now read **Active**. Second, the clinician has no enrolled push factor. Sign into the IBM Verify self-service portal with that clinician's credentials and enroll the IBM Verify mobile authenticator.

**Test 4 returns `mfa_denied`.** Either the user tapped **Deny** on the push, or the push timed out. The MCP server log shows which: `[verify] MFA denied by user` versus `[verify] MFA timeout after 120s`. Re-run the test and approve within 90 seconds.

## VIP step-up smoke test

The cookbook's VIP patients (`A0042` Senator Reed and `A0099` CEO Thornton in the seed) trigger the Verify access policy's step-up MFA rule. To exercise the full chain end-to-end:

**Prerequisite.** The clinician account you signed in as must have an IBM Verify mobile-app push factor enrolled. Without one, the read returns `mfa_no_factor` (see [troubleshooting #8](./troubleshooting.md#8-vip-read-fails-with-mfa_no_factor-user-has-no-registered-userpresence-factor)).

```bash
curl -N -X POST http://127.0.0.1:8080/invoke \
  -H "Authorization: Bearer $CLINICIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Read patient A0042"}'
```

Expected sequence:

1. The agent's reply pauses (the MCP is waiting on Verify's MFA challenge).
2. A push notification lands on the clinician's phone: "Approve healthcare action".
3. Approve the push within 120 seconds.
4. The agent returns Senator Reed's chart with `mrn`, `display_name`, `dob`, `primary_diagnosis`, `primary_clinician`, and `vip_flag: true`.

What just happened end-to-end:

- The agent called `get_patient_record` with `mrn=A0042`.
- The MCP server's Step A discovery mint ran under the `patient_read` RAR (no MFA — policy ACTION_ALLOW). The plugin returned an ephemeral Postgres role, the row was read, `vip_flag` came back true.
- The MCP server's Step B re-fired Token Exchange with the `patient_read_vip` RAR. Verify's CELX matched, the policy fired `ACTION_MFA_ALWAYS`, and `/oauth2/token` returned `scope: mfa_challenge` with a challenge access_token.
- The MCP server used the challenge token to call `/v2.0/factors`, found the clinician's userPresence factor, posted a verification to `/v1.0/authenticators/{id}/verifications`, got back a `transactionUri`, and polled until `state: VERIFY_SUCCESS` arrived with an assertion JWT.
- The MCP server re-called `/oauth2/token` with `grant_type=jwt-bearer`, the assertion, and the SAME RAR re-attached (Verify does not propagate `authorization_details` through the second leg by default).
- Verify returned a post-MFA OBO carrying `authorization_details` signed into the JWT.
- The MCP server presented that OBO to the verify-rar Vault plugin, which validated the RAR shape against the role's `rar_mappings`, minted a fresh 5-minute Postgres role, the MCP server ran the full `SELECT`, and the chart returned.

Try the denial paths too:

```bash
# Deny the push when it arrives. Agent surfaces an mfa_denied error.
curl -N -X POST http://127.0.0.1:8080/invoke \
  -H "Authorization: Bearer $CLINICIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Read patient A0099"}'

# Ignore the push entirely; wait 2+ minutes. Agent surfaces an mfa_timeout error.
curl -N -X POST http://127.0.0.1:8080/invoke \
  -H "Authorization: Bearer $CLINICIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Read patient A0042"}'
```

Both error paths are documented in [troubleshooting #9](./troubleshooting.md#9-vip-read-fails-with-mfa_denied) and [#10](./troubleshooting.md#10-vip-read-fails-with-mfa_timeout).

## What you just did

You generated a clinician access token, ran four test calls against the MCP server, and exercised both the no-MFA read path and the step-up MFA path. You watched a push notification land on your phone, approved it, and saw the corresponding patient record come back. The full identity chain works end-to-end on your laptop.

## What you'll do next

If you want to try a non-default LLM provider (Bedrock, OpenAI, or Gemini), move on to [Swapping the LLM](./llm-options.md). If you want a code-level walkthrough of how the MCP server enforces the security chain, [Anatomy of an MCP Call](./mcp-anatomy.md) quotes the load-bearing files verbatim. If something went wrong above, jump to [Troubleshooting](./troubleshooting.md).