## Troubleshooting

The entries below are ordered roughly by the order in which you encounter them during a fresh setup. Each one has the symptom you actually see, the diagnosis (what is really happening), and the fix.

## Table of contents

1.  [`pip install -e .` fails with `error: Microsoft Visual C++ ...` on Windows](#1-pip-install--e--fails-with-c-compiler-required)
2.  [`uvicorn` command not found after `pip install -e .`](#2-uvicorn-command-not-found-after-pip-install--e-)
3.  [Agent returns `401 missing_bearer`](#3-agent-returns-401-missing_bearer)
4.  [Agent returns `500` with `mcp.client.streamable_http: ConnectError`](#4-agent-returns-500-with-mcp-clientstreamable_http-connecterror)
5.  [HashiCorp Vault returns 403 on `verify-rar/creds/<role>`](#5-hashicorp-vault-returns-403-on-verify-rarcredsrole)
6.  [IBM Verify Token Exchange returns `scope: mfa_challenge` instead of an OBO](#6-ibm-verify-token-exchange-returns-scope-mfa_challenge-instead-of-an-obo)
7.  [Token Exchange returns CSIAQ0158E "authorization_grant of type user_code does not exist or is invalid"](#7-token-exchange-returns-csiaq0158e-authorization_grant-of-type-user_code-does-not-exist-or-is-invalid)
8.  [VIP read fails with `mfa_no_factor`](#8-vip-read-fails-with-mfa_no_factor-user-has-no-registered-userpresence-factor)
9.  [VIP read fails with `mfa_denied`](#9-vip-read-fails-with-mfa_denied)
10. [VIP read fails with `mfa_timeout`](#10-vip-read-fails-with-mfa_timeout)

* * *

## 1\. `pip install -e .` fails with C-compiler required

**Symptom.** Running `pip install -e .` in the agent's virtual environment fails partway through with an error mentioning a missing C compiler (typical on Windows: `error: Microsoft Visual C++ 14.0 or greater is required`).

**Diagnosis.** A transitive dependency in the agent's chain (usually `httpx`'s native h11 or one of Strands' SDK extras) needs to build a small C extension if no pre-built wheel matches your Python version and platform.

**Fix.** Easiest path is to install Python 3.11 or 3.12 (not 3.13+) — these have full wheel coverage for everything in this dependency tree on Mac, Linux, and Windows. If you must use an unreleased Python, install the build toolchain (`apt install build-essential` on Linux, Xcode CLI tools on Mac, the Visual Studio Build Tools on Windows) and retry.

* * *

## 2\. `uvicorn` command not found after `pip install -e .`

**Symptom.** `pip install -e .` reports success, but `uvicorn healthcare_agent.main:app ...` returns `command not found` (or `uvicorn: not found`).

**Diagnosis.** Either you forgot to `source .venv/bin/activate` (the venv's `bin/` directory is not on your PATH) or you ran `pip install` in a venv but `uvicorn` from your shell.

**Fix.**

```bash
cd agent
source .venv/bin/activate
which uvicorn   # should print .../agent/.venv/bin/uvicorn
uvicorn healthcare_agent.main:app --host 127.0.0.1 --port 8080
```

If `which uvicorn` still does not return the venv path after activation, the install failed silently — re-run `pip install -e .` and check for errors.

* * *

## 3\. Agent returns `401 missing_bearer`

**Symptom.** `POST /invoke` returns:

```json
{"detail":"missing_bearer"}
```

**Diagnosis.** The request did not carry a `Authorization: Bearer <token>` header, or the header was empty after stripping the `Bearer ` prefix. The agent rejects unauthenticated requests at the front door — it does not look up tools or call the MCP server until the bearer is present.

**Fix.** Pass the clinician token (mint it with `bash scripts/get-clinician-token.sh && source .clinician-token.env`):

```bash
curl -N -X POST http://127.0.0.1:8080/invoke \
  -H "Authorization: Bearer ${CLINICIAN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "List my patients"}'
```

* * *

## 4\. Agent returns `500` with `mcp.client.streamable_http: ConnectError`

**Symptom.** The agent log shows a Python traceback ending in `httpx.ConnectError: All connection attempts failed` against `127.0.0.1:3012`.

**Diagnosis.** The agent is reaching for the MCP server at `HEALTHCARE_MCP_URL` (default `http://127.0.0.1:3012/mcp`), but nothing is listening there. Either the MCP server is not running, it is running on a different port, or your `agent/.env` points at the wrong URL.

**Fix.** In a second terminal:

```bash
curl -s http://127.0.0.1:3012/healthz
```

Should return `{"status":"ok","service":"vva-mcp-server"}`. If you get connection refused, start the MCP server (`cd mcp-server && npm run dev`). If the MCP server is on a non-default port, update `HEALTHCARE_MCP_URL` in `agent/.env` and restart `uvicorn`.

* * *

## 5\. HashiCorp Vault returns 403 on `verify-rar/creds/<role>`

**Symptom.** The MCP server logs `Vault: permission denied` when it POSTs to `verify-rar/creds/healthcare-records`, even though the `VAULT_TOKEN` you copied from the bootstrap looks fine. The Vault CLI command `vault read verify-rar/creds/healthcare-records` works without complaint when run as the same token.

**Diagnosis.** This is the subtle one. The verify-rar plugin path is registered with HashiCorp Vault for both `ReadOperation` and `UpdateOperation`. Vault's HTTP layer does not deserialize a JSON request body on a GET, so the plugin's read handler cannot accept the OBO. Workloads have to POST, and POST corresponds to the `update` capability in Vault, not `read`. If your policy grants only `read` on this path, the CLI test passes (it uses the read path) but the workload POST fails with 403 (it needs `update`).

**Fix.** The included `healthcare-mcp.hcl` policy grants both capabilities, so the cookbook works out of the box. If you ever write your own policy for a similar plugin, grant both:

```hcl
path "verify-rar/creds/healthcare-records" {
  capabilities = ["read", "update"]
}
```

* * *

## 6\. IBM Verify Token Exchange returns `scope: mfa_challenge` instead of an OBO

**Symptom.** The MCP server log shows `Token Exchange returned scope=mfa_challenge`. The clinician's phone rings but the MCP server appears to do nothing with the resulting assertion.

**Diagnosis.** This is not an error. This is the normal IBM Verify pattern for an access policy that fires `ACTION_MFA_ALWAYS`. The first leg of the exchange returns a 200 OK with a `mfa_challenge` token (not a real OBO) and a transaction URI for polling. The MCP server is expected to:

1.  Use the challenge token to call `/v2.0/factors` for the user.
2.  Trigger a push at `/v1.0/authenticators/{factor_id}/verifications`.
3.  Poll the transaction URI until the user approves.
4.  Submit a second exchange using `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` with the assertion JWT as the `assertion` parameter, re-sending the original `authorization_details`.

The result of that second leg is a real OBO with the RAR baked in.

**Fix.** The included `mcp-server/src/verify/token-exchange.ts` already implements this two-leg flow. If you see the `mfa_challenge` log line, the next several lines should show `polling MFA assertion (attempt 1)... (attempt 2)... approved`. If you do not see those, the polling helper is not being invoked; the most likely cause is a mismatched code copy from an earlier reference that lacked the helper. Pull from the cookbook's `main` branch.

A common related symptom: if you forget to re-send `authorization_details` on the second-leg `jwt_bearer` call, the OBO comes back without a RAR and HashiCorp Vault returns `no rar_mapping match` on the next step. The cookbook handles this; flag it if you ever fork the code.

* * *

## 7\. Token Exchange returns CSIAQ0158E "authorization_grant of type user_code does not exist or is invalid"

**Symptom.** The MCP server log (or a direct curl to `/mcp` with a `tools/call`) returns:

```
Leg 1 token exchange failed: 400 {"error":"invalid_request","error_description":"CSIAQ0158E The authorization_grant of type user_code does not exist or is invalid."}
```

The agent's chat reply surfaces this as a generic "authentication issue" or "authorization problem".

**Diagnosis.** The error message mentions `user_code` but that is misleading. `CSIAQ0158E` is IBM Verify's general "the subject_token presented to Token Exchange is no longer valid" error. The user's access token has either:

- Expired (default Verify access token TTL is 1 hour),
- Been explicitly revoked by Verify (Continuous Access Evaluation, manual revocation, or session-end), or
- Was minted for a different OIDC application than the one the Token Exchange app trusts.

The most common cause is "I got the token an hour ago and forgot to refresh."

**Fix.** Re-mint the clinician token and retry:

```bash
bash scripts/get-clinician-token.sh
source .clinician-token.env

# Retry your call
curl -N -X POST http://127.0.0.1:8080/invoke \
  -H "Authorization: Bearer $CLINICIAN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "List my patients"}'
```

If you minted a brand-new token and still see CSIAQ0158E, the issue is configuration rather than expiry. Check that the Token Exchange app's `clientGroups.tokenExchange` (in the Verify Admin UI under the TE app's Sign-on tab) lists the UI app's clientId as a trusted subject. Verify rejects subject_tokens minted by clients not in that list with CSIAQ0158E. The cookbook bootstrap does not set this explicitly because in the default flow the same UI app issues the subject_token and is implicitly trusted; if you swap in a different UI app you may need to add it.

* * *

## 8\. VIP read fails with `mfa_no_factor` ("user has no registered userPresence factor")

**Symptom.** Asking the agent to read a VIP patient (e.g. `A0042`) returns an error message mentioning `mfa_no_factor`. The MCP server log shows `triggerOAuthMfaPush: user has no registered userPresence factor`.

**Diagnosis.** The clinician account you signed in as does not have an IBM Verify mobile-app push factor enrolled on the Verify tenant. The VIP step-up flow requires one; the policy demands MFA, the MCP server tries to trigger a push, and no enrolled push factor means there is nothing to push to.

**Fix.** Enroll the IBM Verify mobile app for the clinician account:

1. Install the IBM Verify app on your phone (iOS App Store / Google Play).
2. In the Verify Admin UI: Identity -> Users -> select your clinician account -> Authentication factors -> Add factor -> IBM Verify mobile.
3. Scan the resulting QR code with the IBM Verify app.
4. Re-run the VIP read prompt. The push should fire.

* * *

## 9\. VIP read fails with `mfa_denied`

**Symptom.** Push notification appears on the clinician's phone, the clinician taps Deny (or the verification is rejected), the agent's reply mentions `mfa_denied` or `User denied push`.

**Diagnosis.** This is the policy working as intended — the clinician chose not to authorize the action. No fix needed. The MCP returned 4xx-equivalent, the agent surfaced the denial, and Verify recorded the event in its audit log.

**Fix.** None required. If the clinician intended to approve, ask them to retry: re-run the prompt and approve the next push within the 120-second window.

* * *

## 10\. VIP read fails with `mfa_timeout`

**Symptom.** Push notification appears on the clinician's phone, the clinician does not approve or deny within ~120 seconds, the agent's reply mentions `mfa_timeout`.

**Diagnosis.** The cookbook's default MFA poll timeout is `MFA_POLL_TIMEOUT_MS=120000` (two minutes). If the clinician was away from their phone or the push notification was missed, the MCP server stops polling and returns the timeout.

**Fix.** Re-run the prompt and respond to the push promptly. If the customer's environment legitimately needs a longer window (slow networks, controlled environments where the user must walk to a secured device), raise the timeout in `mcp-server/.env`:

```bash
MFA_POLL_TIMEOUT_MS=300000   # 5 minutes
```

Restart the MCP server (`npm run dev`) for the new value to take effect.

* * *

## What you just did

You read the ten common gotchas and you know how to diagnose each one from its first observed symptom. Most of these took someone an hour to discover the first time and ten minutes to fix once they knew where to look. Save yourself the hour.

## What you'll do next

If you have not run [End-to-end smoke test](./smoke-test.md) yet, do that. If you have, move on to [Anatomy of an MCP Call](./mcp-anatomy.md) to walk the code that implements the security chain, or [Logging for an enterprise SIEM](./siem-logging.md) to see how the audit surfaces in this stack join on a single `jti`.
