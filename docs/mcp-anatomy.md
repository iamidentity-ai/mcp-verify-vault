## Anatomy of an MCP Call

The smoke test in chapter 10 proved that the chain works. This chapter explains the *code* that makes each step work. Three files inside `mcp-server/src/` carry the security model. The snippets below are quoted verbatim from the repo; the prose around each one names which property of the [identity chain](./identity-chain.md) it enforces.

Read this chapter with `mcp-server/src/` open in a second window. The point is not to discover anything you have not already seen — the smoke test exercised every line of this code. The point is to *name* the load-bearing line in each file so a security reviewer can audit them in 15 minutes instead of an hour.

## 1. Reject unauthenticated requests before doing any work

The very first check in `mcp-server/src/index.ts`:

```ts
app.post('/tool', async (req, res) => {
  const bearer = (req.header('authorization') || '').replace(/^Bearer /, '');
  if (!bearer) return res.status(401).json({ error: 'missing_bearer' });
  // dispatch only happens with a bearer present
  const result = await dispatchTool(toolName, args, bearer);
  res.json(result);
});
```

A request without a `Authorization: Bearer` header never reaches a tool handler. Notice what the MCP server does *not* do here: it does not parse the bearer, it does not check the bearer against a local key, it does not validate the bearer's expiration. Validating the bearer happens at IBM Verify in step 3, where Verify is the authoritative source for whether the token is still active. The MCP server's job at this layer is just "presence check."

This is the first guarantee in the chain: no anonymous calls. A request that arrives with no Bearer header gets `401 missing_bearer` in under a millisecond.

## 2. Every tool call builds a fresh, action-specific RAR

The relevant lines from `mcp-server/src/tools/get-patient-record.ts`:

```ts
// VIP patients trigger the policy's ACTION_MFA_ALWAYS rule.
// The RAR is what Verify's CELX rule matches against.
const vipCred = await mintCred({
  rarType:   'urn:smt:agent:healthcare',
  rarAction: 'patient_read_vip',
  patientMrn: mrn,
  claims,
  exchangeToken,
});
```

The MCP server does not decide whether step-up MFA fires. It *declares* the action it is about to perform (read a VIP patient's chart, by MRN) and lets Verify's access policy decide. The CELX rule in `infra/verify/bootstrap-verify.ts` matches `patient_read_vip` and fires `ACTION_MFA_ALWAYS`; non-VIP reads use a different action verb (`patient_read`) and get `ACTION_ALLOW` with no push.

This is the second guarantee: declared intent, not asserted authority. The RAR is the MCP server's *request* for permission, not its claim that it already has permission. Verify is the only entity that can grant the request.

## 3. The Token Exchange handler implements the two-leg MFA flow verbatim

The non-obvious part. The relevant block from `mcp-server/src/verify/token-exchange.ts`:

```ts
// Leg 1: POST /oauth2/token with grant_type=token-exchange + RAR
//   -> 200 OK with scope: "mfa_challenge" if policy demands MFA
//   -> 200 OK with real OBO if policy allows
// Leg 2 (only if mfa_challenge): drive the MFA push internally, then
//   POST /oauth2/token with grant_type=jwt-bearer + the MFA assertion
//   + the SAME RAR re-attached so the post-MFA OBO carries
//   policy-attested authorization_details.
```

The same RAR object is sent on both legs. IBM Verify is the only place that ever signs `authorization_details` into a JWT; the MCP server's role is to construct the RAR and re-submit it on the second leg. Re-attaching the RAR on the `jwt_bearer` leg is non-obvious — Verify does not propagate `authorization_details` through automatically, and an early version of this code missed that — so the included `token-exchange.test.ts` has vitest coverage for the path. The full helper code is in the same file: `triggerOAuthMfaPush`, `pollOAuthMfaStatus`, and `exchangeMfaAssertionWithRAR`.

This is the third guarantee: policy-attested attribution. Whatever RAR appears in the resulting OBO JWT was approved by IBM Verify's policy engine, not asserted by the MCP server. Vault's verify-rar plugin validates the JWT signature before it matches the RAR; a forged RAR would not survive the signature check.

## 4. The MCP server presents the OBO directly to Vault

After the OBO arrives, the MCP server passes it to Vault as the `X-Vault-Token`:

```ts
const res = await fetch(`${VAULT_ADDR}/v1/verify-rar/creds/${role}`, {
  method: 'POST',
  headers: { 'X-Vault-Token': obo, 'Content-Type': 'application/json' },
  body: JSON.stringify({ claims }),
});
```

The OBO is *its own* Vault credential. Vault's verify-rar plugin validates the OBO JWT against the IBM Verify JWKS, finds the embedded `authorization_details`, walks the role's `rar_mappings`, and matches. If the match succeeds, the plugin mints a fresh PostgreSQL role with a 5-minute lease and returns the role's username/password to the MCP server. If the match fails (RAR shape the role does not allow, expired JWT, bad signature), Vault returns `403`.

This is what makes the entire chain "policy enforced at every hop" rather than "policy enforced once at the front door." Even if a sophisticated attacker convinced the MCP server to skip the Verify step, they would still need a valid Verify-signed OBO to get a database credential out of Vault.

## 5. The ephemeral credential runs one SELECT, then the lease is revoked

The lifetime of the credential is one statement:

```ts
const pool = new Pool({ user: cred.username, password: cred.password, ... });
try {
  const result = await pool.query(sql, args);
  return result.rows;
} finally {
  await pool.end();
  await revokeLease(cred.leaseId);
}
```

`revokeLease()` calls `POST /v1/sys/leases/revoke`, which immediately drops the ephemeral PostgreSQL role. Vault audit records both the mint and the revoke, joined by the lease id. PostgreSQL records the SQL statement under the ephemeral role's name. A SIEM joining on the OBO `jti` reassembles the chain end-to-end.

This is the final guarantee: no credential outlives the operation it was minted for. The 5-minute TTL is a backstop; the explicit revoke is the primary mechanism.

## The "almost nothing" list, restated as code

These four properties are the entire local security boundary of the MCP server:

1. The bearer-presence gate is one line: `if (!bearer) return res.status(401).json(...)`.
2. The per-call RAR construction lives inside each tool handler; no shared RAR cache, no RAR memoization.
3. The Token Exchange handler is one file (`verify/token-exchange.ts`); it is the only place in the codebase that POSTs to `/oauth2/token`.
4. The Postgres call uses Vault's ephemeral credential and revokes it in a `finally`; no long-lived pool, no admin connection string in `.env`.

If a reviewer asks "show me where the authorization logic lives in this codebase," the honest answer is: it does not. The authorization decision is in IBM Verify. The credential-minting decision is in HashiCorp Vault. The MCP server is the orchestrator that calls both at the right time.

## What you just did

You read the five load-bearing pieces of code in `mcp-server/src/`. Together, they implement the [identity chain](./identity-chain.md) from chapter 2. You can now point at a specific file and line for each of the three guarantees Verify provides and the four properties the MCP server is forbidden from violating.

## What you'll do next

If you have not run [End-to-end smoke test](./smoke-test.md) yet, run it now and watch the code in this chapter execute in real time. If something in the chain misbehaves during your own testing, [Troubleshooting](./troubleshooting.md) covers the most common gotchas. Otherwise, move on to [Logging for an enterprise SIEM](./siem-logging.md) to see how the audit surfaces in this stack join on a single `jti`.
