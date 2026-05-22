## The Identity Chain

This is the security story in one chapter. The MCP server in this cookbook is the only process that makes IBM Verify calls, the only one that handles the on-behalf-of token, the only one that talks to HashiCorp Vault. Everything that protects a patient record is concentrated in that one process. Read this chapter before the implementation chapters so the chain's *shape* is clear before you stand it up piece by piece.

## The five-second version

> Clinician bearer in -> MCP server builds an RFC 9396 Rich Authorization Request -> IBM Verify policy decides (with step-up MFA where the policy demands it) -> Verify signs the RAR into an OBO JWT -> HashiCorp Vault validates the OBO and matches its RAR -> ephemeral 5-minute PostgreSQL role -> one SELECT -> lease revoked.

Each arrow is a standards-based wire format your existing tooling can already inspect: OAuth 2.0 / OIDC for the user sign-in, RFC 8693 for the Token Exchange, RFC 9396 for the authorization details, Vault audit JSON for the credential mint, PostgreSQL `log_statement=all` for the database call.

## Three guarantees that live in IBM Verify, not in the code

These are the assurances a security reviewer is looking for. None of them live in the MCP server or the agent; all three are properties of how IBM Verify enforces the access policy.

**1. Per-call authorization, not per-session.** Every single tool invocation runs its own Token Exchange. The MCP server cannot accumulate or reuse authority across calls. A clinician who has read patient A0001 has *not* been pre-approved to read A0042; the next call goes through Verify again and gets a fresh evaluation.

**2. Step-up MFA evaluated at policy time.** When the cookbook's access policy fires `ACTION_MFA_ALWAYS` for VIP reads, IBM Verify returns `scope: mfa_challenge` instead of an OBO. The MCP server triggers a push at IBM Verify's `/v1.0/authenticators/{factor_id}/verifications` endpoint and polls until the clinician approves. Only then does Verify mint the real OBO. There is no path through the MCP server's code that bypasses this gate; the policy decision happens *inside Verify*, not inside the cookbook.

**3. Policy-attested authorization details.** The RAR the MCP server sends to Verify is *cryptographically attested* on the way back: Verify signs the approved `authorization_details` into the OBO JWT it returns. Vault then validates that JWT signature against the Verify JWKS *before* it matches the RAR to a `rar_mappings` entry. If the MCP server tried to forge a wider RAR locally and present it to Vault directly, Vault would reject the signature check.

## What the MCP server is forbidden from doing

A security reviewer who picks up this code will want to know what authorization decisions the MCP server can make unilaterally. The answer is: almost none. The forbidden-list is short and worth reading in full.

*   **No local allow/deny logic.** The MCP server never reads the clinician bearer's claims to decide if they can see a patient. It forwards the token to Verify as `subject_token` and acts on Verify's response.
*   **No OBO caching across calls.** Every tool call mints a fresh OBO with a fresh `jti` claim. There is no opportunity for the MCP server to reuse an old OBO for a new request. Vault audit can correlate every PostgreSQL mint to exactly one IBM Verify policy decision.
*   **No long-lived database credentials.** The MCP server never holds a PostgreSQL password. It uses the 5-minute ephemeral role HashiCorp Vault mints from the OBO, runs one SQL statement, and explicitly revokes the lease.
*   **No hand-rolled crypto.** OBO JWT signature validation happens in HashiCorp Vault, against the IBM Verify JWKS. The MCP server does not introspect the OBO or implement any JWT verification of its own.

## What the agent is forbidden from doing

If the MCP server is "almost nothing" from an authorization standpoint, the *agent* is literally nothing. The agent is a transport, not a security boundary.

*   **The agent never inspects the clinician bearer.** It reads the `Authorization: Bearer` header off the inbound HTTP request, forwards it verbatim to the MCP server, and that is the end of the agent's relationship with the token.
*   **The agent never talks to IBM Verify.** It has no Verify client credentials, no Verify tenant URL hard-coded, no `/oauth2/token` calls in its source. If you grep the agent code for the string `verify`, the only match is the URL the MCP server is hosted at.
*   **The agent never talks to HashiCorp Vault.** It has no Vault token, no `/v1/verify-rar/creds/...` call, no policy access. The credentials in Vault never reach the agent process.
*   **The agent never touches the database.** It has no PostgreSQL connection string, no PG library installed in its dependencies, no SQL.

The agent's job is to think and route. A change of agent framework, host, or even programming language does not change the security chain. The MCP server is the security perimeter; the agent is just a different way to call it.

## The trust boundary, sliced one more way

When a reviewer asks "where is the trust boundary in this system?" the answer is the MCP server. Specifically, three load-bearing files inside `mcp-server/src/`:

1. The HTTP entrypoint that refuses any request without a Bearer header (`index.ts`).
2. The tool handler that constructs a fresh RFC 9396 RAR per call (`tools/get-patient-record.ts`).
3. The Token Exchange handler that implements the RFC 8693 + `mfa_challenge` two-leg flow (`verify/token-exchange.ts`).

The chapter [Anatomy of an MCP Call](./mcp-anatomy.md) opens each of those three files near the end of the cookbook (after you have stood up the stack and watched it work) and walks through the code line by line. Read it after the smoke-test chapter, not before; the code lands better when you have already seen it run.

## What you just did

You read the security story end-to-end without yet running any code. You know which guarantees live in IBM Verify (per-call authz, step-up MFA, RAR attestation), what the MCP server is forbidden from doing on its own (local allow/deny, OBO caching, long-lived DB creds, hand-rolled JWT verification), and that the agent is a transport with no security responsibilities. You can quote any of those points back to a security reviewer without checking the code first.

## What you'll do next

Move on to [Prerequisites](./cookbook-prereqs.md) to confirm you have Docker, Node, Python, and an IBM Verify tenant ready, then on to the implementation chapters that stand up each piece of the chain.
