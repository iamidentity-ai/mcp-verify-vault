import type { MintedCred, MintCredOptions } from '../vault/verify-rar-client.js';
import type { exchangeToken as ExchangeTokenFn } from '../verify/token-exchange.js';
import type { runAsEphemeralRole as RunFn } from '../db/pool.js';

export interface GetPatientRecordOpts {
  mrn: string;
  claims: { access_token: string };
  mintCred: (opts: MintCredOptions) => Promise<MintedCred>;
  runAsEphemeralRole: typeof RunFn;
  exchangeToken?: typeof ExchangeTokenFn;
}

export interface PatientRecord {
  mrn: string;
  display_name: string;
  dob: string;
  primary_diagnosis: string;
  vip_flag: boolean;
  primary_clinician: string;
}

export interface PatientRecordResult {
  patient: PatientRecord | null;
  vipPath: boolean;
}

/**
 * Read a patient chart by MRN.
 *
 * Two-step when the patient is VIP-flagged:
 *   Step A — discovery: mint a credential under the patient_read RAR.
 *     Read just enough to check the vip_flag. No MFA required.
 *   Step B — VIP step-up: mint a fresh credential under the patient_read_vip
 *     RAR. The Verify access policy fires ACTION_MFA_ALWAYS for this RAR
 *     and exchangeToken auto-drives the push + poll + jwt_bearer second
 *     leg. The post-MFA OBO is presented to Vault, a new credential is
 *     minted, and the full chart is returned.
 *
 * For non-VIP patients only Step A runs; no push is sent.
 *
 * Errors thrown by Step B:
 *   MfaError(code='mfa_no_factor')  — clinician has no push factor enrolled
 *   MfaError(code='mfa_denied')      — clinician tapped Deny on the push
 *   MfaError(code='mfa_timeout')     — push not approved within timeout
 * The MCP server dispatcher catches these and surfaces them to the agent.
 */
export async function getPatientRecord(opts: GetPatientRecordOpts): Promise<PatientRecordResult> {
  const { mrn, claims, mintCred, runAsEphemeralRole } = opts;

  // Step A: discovery read with patient_read RAR (no MFA)
  const discoveryCred = await mintCred({
    rarType: 'urn:smt:agent:healthcare',
    rarAction: 'patient_read',
    patientMrn: mrn,
    claims,
    exchangeToken: opts.exchangeToken ?? (await import('../verify/token-exchange.js')).exchangeToken,
  });

  type VipRow = { vip_flag: boolean };
  const vipRows = await runAsEphemeralRole<VipRow>(
    discoveryCred,
    'SELECT vip_flag FROM clinical.patients WHERE mrn = $1',
    [mrn],
  );

  if (vipRows.length === 0) {
    return { patient: null, vipPath: false };
  }

  const isVip = vipRows[0].vip_flag;

  if (!isVip) {
    // Non-VIP: read the full record using the same credential
    const rows = await runAsEphemeralRole<PatientRecord>(
      discoveryCred,
      'SELECT mrn, display_name, dob::text AS dob, primary_diagnosis, vip_flag, primary_clinician FROM clinical.patients WHERE mrn = $1',
      [mrn],
    );
    return { patient: rows[0] ?? null, vipPath: false };
  }

  // Step B: VIP step-up. Mint a fresh credential under patient_read_vip RAR.
  // exchangeToken auto-drives the MFA flow on mfa_challenge; it throws an
  // MfaError on user denial / timeout / no factor enrolled, which propagates
  // up to the dispatcher.
  const vipCred = await mintCred({
    rarType: 'urn:smt:agent:healthcare',
    rarAction: 'patient_read_vip',
    patientMrn: mrn,
    claims,
    exchangeToken: opts.exchangeToken ?? (await import('../verify/token-exchange.js')).exchangeToken,
  });

  const rows = await runAsEphemeralRole<PatientRecord>(
    vipCred,
    'SELECT mrn, display_name, dob::text AS dob, primary_diagnosis, vip_flag, primary_clinician FROM clinical.patients WHERE mrn = $1',
    [mrn],
  );

  return { patient: rows[0] ?? null, vipPath: true };
}
