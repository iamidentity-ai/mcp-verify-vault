import type { TokenExchangeRequest, TokenExchangeResult } from '../verify/types.js';
import type { exchangeToken as ExchangeTokenFn } from '../verify/token-exchange.js';

const VAULT_ADDR = process.env.VAULT_ADDR!;
const VAULT_TOKEN = process.env.VAULT_TOKEN!;
const ROLE = process.env.VAULT_ROLE ?? 'healthcare-records';

export interface MintedCred {
  username: string;
  password: string;
  leaseId: string;
  ttlSec: number;
}

export interface MintCredOptions {
  rarType: string;
  rarAction: string;
  patientMrn?: string;
  claims: { access_token: string };
  exchangeToken: typeof ExchangeTokenFn;
}

/**
 * Call the verify-rar Vault plugin to mint a 5-minute Postgres credential
 * gated on the RAR shape attested in the OBO JWT.
 *
 * The plugin endpoint is POST (Vault treats POST as `update` capability,
 * which the healthcare-mcp policy grants). The OBO JWT is sent in the
 * X-Vault-Token header. Vault's OAuth Resource Server profile validates it
 * against IBM Verify's JWKS and resolves the agent-identity entity-alias
 * before the plugin's rar_mappings check fires.
 *
 * The resulting OBO is the product of Token Exchange with a RAR that names
 * the action being authorized. For VIP patients the token exchange triggers
 * an MFA push via the Verify access policy; the caller's mfaCallback handles
 * the push and returns a jwt-bearer assertion for the second leg.
 */
export async function mintCred(opts: MintCredOptions): Promise<MintedCred> {
  // Build the RAR entry and run Token Exchange against Verify. If the RAR
  // matches the Verify access policy's MFA rule (the cookbook's
  // healthcareRarPresent CELX matches patient_read_vip only), exchangeToken
  // auto-drives the push + poll + jwt_bearer second leg and either returns
  // a post-MFA OBO or throws an MfaError (mfa_no_factor / mfa_denied /
  // mfa_timeout). The caller is responsible for translating those error
  // codes into a user-facing message.
  const rarEntry: { type: string; operationDetails: Record<string, unknown> } = {
    type: opts.rarType,
    operationDetails: { action: opts.rarAction, ...(opts.patientMrn ? { patient_mrn: opts.patientMrn } : {}) },
  };

  const req: TokenExchangeRequest = {
    subjectToken: opts.claims.access_token,
    scope: 'healthcare:patient:read',
    authorizationDetails: [rarEntry],
  };

  // No actor token: the cookbook's Verify TE app is configured with
  // actorTokenRequired:false. The MCP server authenticates to TE with its
  // own client_id + client_secret (the TE app credentials). For production
  // hardening, register a third "Agent Identity" OIDC client, mint an actor
  // JWT via client_credentials, and pass it here. See
  // docs/verify-setup.md "Production hardening" for the upgrade path.
  const te: TokenExchangeResult = await opts.exchangeToken(req, '');

  return postCreds(te.obo);
}

/**
 * Same as mintCred but the caller has already driven the MFA flow and supplies
 * the final OBO directly. Used by the VIP path in get-patient-record.ts.
 */
export async function mintCredFromObo(obo: string): Promise<MintedCred> {
  return postCreds(obo);
}

/** Decode a JWT's payload segment. Does NOT verify the signature; the plugin
 *  is the trust boundary, not us. We just need the claims so the plugin can
 *  match the authorization_details against rar_mappings. */
function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const segments = jwt.split('.');
  if (segments.length !== 3) throw new Error('OBO is not a JWT (expected 3 segments)');
  const padded = segments[1].replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (segments[1].length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString()) as Record<string, unknown>;
}

async function postCreds(obo: string): Promise<MintedCred> {
  const url = `${VAULT_ADDR}/v1/verify-rar/creds/${ROLE}`;
  // The plugin expects JWT claims in one of two places:
  //   - On Vault Enterprise, an OAuth-RS profile pre-validates the JWT in
  //     X-Vault-Token and populates req.Auth.Identity.Claims server-side.
  //   - On Vault OSS (this cookbook), the workload decodes the JWT itself
  //     and posts the claims in the request body. The plugin reads them
  //     from there. The X-Vault-Token header still carries the MCP service
  //     token (NOT the OBO) so Vault authenticates the call against the
  //     healthcare-mcp policy.
  const claims = decodeJwtClaims(obo);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'X-Vault-Token': VAULT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ claims }),
  });
  if (!res.ok) {
    throw new Error(`verify-rar mint failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { data: { username: string; password: string }; lease_id: string; lease_duration?: number };
  return {
    username: data.data.username,
    password: data.data.password,
    leaseId: data.lease_id,
    ttlSec: data.lease_duration ?? 300,
  };
}

/**
 * Early-revoke a lease so the ephemeral Postgres user is dropped the moment
 * the SQL completes. Reduces the misuse window from TTL (5 minutes) to
 * milliseconds. Best-effort -- swallow errors since the lease will expire on
 * its own.
 */
export async function revokeLease(leaseId: string): Promise<void> {
  try {
    await fetch(`${VAULT_ADDR}/v1/sys/leases/revoke`, {
      method: 'PUT',
      headers: { 'X-Vault-Token': VAULT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ lease_id: leaseId }),
    });
  } catch {
    /* lease will expire naturally; swallow */
  }
}
