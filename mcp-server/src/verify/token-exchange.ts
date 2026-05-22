import type { TokenExchangeRequest, TokenExchangeResult } from './types.js';
import { MfaError } from './types.js';
import { getSecret, invalidateSecret } from '../vault/secret-cache.js';

// VERIFY_TENANT_HOST is the hostname only, e.g. <your-tenant>.verify.ibm.com
// The protocol is added here so the env var stays tidy.
const BASE = `https://${process.env.VERIFY_TENANT_HOST}`;
const TE_CLIENT_ID = process.env.VERIFY_TE_CLIENT_ID!;

// Where the TE client secret is fetched from. Vault KV is the canonical home
// (written by infra/verify/bootstrap-verify.ts); env is the fallback for
// customers running this pattern without a Vault dependency.
const TE_SECRET_PATH = 'secret/data/VERIFY_TE_CLIENT_SECRET';
const TE_SECRET_FIELD = 'value';
const TE_SECRET_ENV_FALLBACK = 'VERIFY_TE_CLIENT_SECRET';

// MFA poll defaults — match canonical conventions
const MFA_POLL_INTERVAL_MS = Number(process.env.MFA_POLL_INTERVAL_MS) || 3000;
const MFA_POLL_TIMEOUT_MS = Number(process.env.MFA_POLL_TIMEOUT_MS) || 120_000;

async function teClientSecret(): Promise<string> {
  return getSecret(TE_SECRET_PATH, TE_SECRET_FIELD, TE_SECRET_ENV_FALLBACK);
}

/**
 * Run RFC 8693 token exchange against IBM Verify with RFC 9396 RAR.
 *
 * The two-leg flow:
 *   Leg 1: POST /oauth2/token with grant_type=token-exchange + RAR
 *     -> 200 OK with scope: "mfa_challenge" if policy demands MFA
 *     -> 200 OK with real OBO if policy allows
 *   Leg 2 (only if mfa_challenge): drive MFA via push internally, then
 *     POST /oauth2/token with grant_type=jwt-bearer + the MFA assertion
 *     + the SAME RAR re-attached so the post-MFA OBO carries policy-attested
 *     authorization_details.
 *
 * Caller provides the actor token (a Vault-issued JWT identity token or a
 * SPIRE SVID). MFA is driven automatically — no callback required.
 *
 * The resulting OBO is presented directly to Vault as the X-Vault-Token.
 * Vault's OAuth-RS profile validates it against the Verify JWKS, resolves
 * the agent-identity entity-alias, and passes the token to the verify-rar
 * plugin for the rar_mappings check.
 */
export async function exchangeToken(
  req: TokenExchangeRequest,
  actorToken: string,
): Promise<TokenExchangeResult> {
  // Leg 1: standard token exchange. Fetch the client secret from Vault
  // (cached 5 min); on 401/403 invalidate and retry once in case the secret
  // was rotated between fetches.
  //
  // actor_token is OPTIONAL in this cookbook. The Verify TE app is configured
  // with actorTokenRequired:false (see infra/verify/bootstrap-verify.ts for
  // the rationale + production-hardening upgrade path). If the caller passes
  // an empty string, we omit actor_token + actor_token_type from the form so
  // Verify does not try to validate an empty token.
  let secret = await teClientSecret();
  function tePayload(s: string): URLSearchParams {
    const p = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: TE_CLIENT_ID,
      client_secret: s,
      subject_token: req.subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: req.scope,
      authorization_details: JSON.stringify(req.authorizationDetails),
    });
    if (actorToken) {
      p.set('actor_token', actorToken);
      p.set('actor_token_type', 'urn:ietf:params:oauth:token-type:jwt');
    }
    return p;
  }
  let leg1 = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tePayload(secret),
  });
  if (leg1.status === 401 || leg1.status === 403) {
    invalidateSecret(TE_SECRET_PATH, TE_SECRET_FIELD);
    secret = await teClientSecret();
    leg1 = await fetch(`${BASE}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tePayload(secret),
    });
  }
  if (!leg1.ok) throw new Error(`Leg 1 token exchange failed: ${leg1.status} ${await leg1.text()}`);
  const leg1Body = await leg1.json() as Record<string, unknown>;

  // Non-VIP path: real OBO returned directly
  if (leg1Body['scope'] !== 'mfa_challenge') {
    return {
      obo: leg1Body['access_token'] as string,
      expiresIn: leg1Body['expires_in'] as number,
      scope: leg1Body['scope'] as string,
      jti: extractJti(leg1Body['access_token'] as string),
      authorizationDetails: (leg1Body['authorization_details'] as RarEntryArray | undefined) ?? req.authorizationDetails,
      vipPath: false,
    };
  }

  // VIP path: leg 1 returned a challenge token (NOT a transactionUri).
  // Use it to fetch the user's userPresence factor and trigger a push, then
  // poll the resulting transactionUri, then re-exchange the assertion with
  // RAR re-attached. This matches the canonical
  // healthcare/mcp-server/src/auth/token-exchange.ts lines 386-411.
  const challengeToken = leg1Body['access_token'] as string | undefined;
  if (!challengeToken) {
    throw new MfaError(
      'mfa_challenge_no_token',
      'Verify returned scope=mfa_challenge with no access_token field',
    );
  }

  const transactionUri = await triggerOAuthMfaPush(challengeToken);
  const pollResult = await pollOAuthMfaStatus(transactionUri, challengeToken);

  if (pollResult.state === 'denied') {
    throw new MfaError('mfa_denied', `User denied push (${pollResult.reason})`);
  }
  if (pollResult.state === 'timeout') {
    throw new MfaError('mfa_timeout', 'User did not respond to push within timeout');
  }

  // Leg 2: jwt_bearer with the MFA assertion + RE-SEND the same RAR.
  // exchangeMfaAssertionWithRAR throws on non-2xx so any other error surfaces.
  const leg2Body = await exchangeMfaAssertionWithRAR(
    pollResult.assertion,
    req.scope,
    req.authorizationDetails,
    secret,
  );

  return {
    obo: leg2Body['access_token'] as string,
    expiresIn: leg2Body['expires_in'] as number,
    scope: leg2Body['scope'] as string,
    jti: extractJti(leg2Body['access_token'] as string),
    authorizationDetails: (leg2Body['authorization_details'] as RarEntryArray | undefined) ?? req.authorizationDetails,
    vipPath: true,
  };
}

// Local alias used in the two return-type assertions above.
type RarEntryArray = import('./types.js').RarEntry[];

// ── MFA helpers (challenge → push → poll → jwt-bearer) ──────────────────────
// Implements IBM Verify's two-leg flow for access policies that fire
// ACTION_MFA_ALWAYS: leg 1 returns scope: mfa_challenge with a transaction
// URI; we push to the user's enrolled factor, poll until VERIFY_SUCCESS,
// then re-exchange the assertion with grant_type=jwt-bearer + the same RAR.

/**
 * Trigger an IBM Verify push notification using the mfa_challenge token as
 * the bearer. Returns the transactionUri to poll.
 *
 * The challenge token is what /oauth2/token returns when the bound access
 * policy fires ACTION_MFA_ALWAYS. It carries enough authority to call the
 * factor + verifications endpoints on the user's behalf, but cannot be used
 * to call business APIs.
 */
export async function triggerOAuthMfaPush(challengeToken: string): Promise<string> {
  // 1. Look up the user's userPresence (push) factor
  const factorsRes = await fetch(`${BASE}/v2.0/factors`, {
    headers: {
      Authorization: `Bearer ${challengeToken}`,
      Accept: 'application/json',
    },
  });
  if (!factorsRes.ok) {
    throw new Error(
      `triggerOAuthMfaPush: /v2.0/factors failed (${factorsRes.status}): ${await factorsRes.text()}`,
    );
  }
  const factorsData = (await factorsRes.json()) as { factors?: any[] };
  const factors = factorsData?.factors ?? [];

  // Prefer non-SDK userPresence (Verify-app registrations); newest first.
  const userPresence = factors
    .filter((f) => f.type === 'signature' && f.subType === 'userPresence')
    .sort((a, b) => {
      const ta = new Date(a.created || 0).getTime();
      const tb = new Date(b.created || 0).getTime();
      return tb - ta;
    });
  const verifyAppOnly = userPresence.filter((f) => {
    const ad = f.attributes?.additionalData;
    return !ad || (Array.isArray(ad) && ad.length === 0);
  });
  const candidates = verifyAppOnly.length > 0 ? verifyAppOnly : userPresence;
  const pick = candidates[0];
  if (!pick) {
    // Use MfaError so the caller can render a user-friendly message instead
    // of a stack trace.
    throw new MfaError('mfa_no_factor', 'user has no registered userPresence factor');
  }
  const factorId: string | undefined = pick.id;
  const authenticatorId: string | undefined = pick.references?.authenticatorId;
  if (!factorId || !authenticatorId) {
    throw new Error('triggerOAuthMfaPush: factor record missing id or authenticatorId');
  }

  // 2. Send push notification
  const verifyRes = await fetch(
    `${BASE}/v1.0/authenticators/${authenticatorId}/verifications`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${challengeToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        transactionData: {
          message: 'Approve healthcare action',
          originIpAddress: '192.168.222.222',
          originUserAgent: 'Healthcare Agent (MCP)',
        },
        pushNotification: {
          send: true,
          title: 'Healthcare Agent',
          message: 'Approve healthcare action',
        },
        authenticationMethods: [{ id: factorId, methodType: 'signature' }],
        logic: 'OR',
        expiresIn: 130,
      }),
    },
  );
  if (!verifyRes.ok) {
    throw new Error(
      `triggerOAuthMfaPush: /v1.0/authenticators/${authenticatorId}/verifications failed (${verifyRes.status}): ${await verifyRes.text()}`,
    );
  }
  const verifyData = (await verifyRes.json()) as { transactionUri?: string };
  if (!verifyData.transactionUri) {
    throw new Error(
      `triggerOAuthMfaPush: response missing transactionUri: ${JSON.stringify(verifyData)}`,
    );
  }
  return verifyData.transactionUri;
}

/**
 * Poll an IBM Verify verification transaction until success/denial/timeout.
 * Append `?returnJwt=true` so VERIFY_SUCCESS includes the assertion JWT used
 * for the second leg jwt_bearer call.
 *
 * Verbatim port from canonical lines 236-272.
 */
export async function pollOAuthMfaStatus(
  transactionUri: string,
  challengeToken: string,
  options?: { intervalMs?: number; timeoutMs?: number },
): Promise<import('./types.js').MfaPollResult> {
  const intervalMs = options?.intervalMs ?? MFA_POLL_INTERVAL_MS;
  const timeoutMs = options?.timeoutMs ?? MFA_POLL_TIMEOUT_MS;
  const url = transactionUri + (transactionUri.includes('?') ? '&' : '?') + 'returnJwt=true';
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${challengeToken}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      // Transient? Back off and retry until outer timeout.
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    // Verify returns the assertion JWT under `assertion` (NOT `jwt`). Banking's
    // working poll reads validation.assertion. Accept both keys defensively.
    const data = (await res.json()) as { state?: string; assertion?: string; jwt?: string };
    const state = data.state;
    if (state === 'VERIFY_SUCCESS') {
      const assertion = data.assertion ?? data.jwt;
      if (!assertion) {
        throw new Error('pollOAuthMfaStatus: VERIFY_SUCCESS but no assertion JWT in response');
      }
      return { state: 'approved', assertion };
    }
    if (state === 'USER_DENIED' || state === 'DENY' || state === 'FAILED' || state === 'EXPIRED') {
      return { state: 'denied', reason: state };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { state: 'timeout' };
}

/**
 * Second-leg jwt_bearer call. After MFA approval we POST the assertion back
 * to /oauth2/token with grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer.
 *
 * CRITICAL — Verify does NOT propagate authorization_details through the
 * second leg by default. The wrapper MUST re-send them or the resulting OBO
 * has no Verify-attested RAR.
 */
export async function exchangeMfaAssertionWithRAR(
  assertion: string,
  scope: string,
  authorizationDetails: import('./types.js').RarEntry[] | undefined,
  exchangeSecret: string,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    client_id: TE_CLIENT_ID,
    client_secret: exchangeSecret,
    assertion,
    scope,
  };
  if (authorizationDetails && authorizationDetails.length > 0) {
    params.authorization_details = JSON.stringify(authorizationDetails);
  }

  const res = await fetch(`${BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`exchangeMfaAssertionWithRAR: jwt_bearer failed (${res.status}): ${await res.text()}`);
  }
  return res.json() as Promise<Record<string, unknown>>;
}

function extractJti(jwt: string): string | undefined {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return undefined;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (parts[1].length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString()) as Record<string, unknown>;
    return typeof payload['jti'] === 'string' ? payload['jti'] : undefined;
  } catch {
    return undefined;
  }
}
