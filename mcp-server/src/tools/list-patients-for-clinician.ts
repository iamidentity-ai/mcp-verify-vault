import type { MintedCred, MintCredOptions } from '../vault/verify-rar-client.js';
import type { runAsEphemeralRole as RunFn } from '../db/pool.js';
import type { exchangeToken as ExchangeTokenFn } from '../verify/token-exchange.js';

export interface ListPatientsForClinicianOpts {
  clinicianUpn: string;
  claims: { access_token: string };
  mintCred: (opts: MintCredOptions) => Promise<MintedCred>;
  runAsEphemeralRole: typeof RunFn;
  exchangeToken?: typeof ExchangeTokenFn;
}

export interface PatientListRow {
  mrn: string;
  display_name: string;
  dob: string;
  primary_diagnosis: string;
  vip_flag: boolean;
}

export interface ListPatientsResult {
  patients: PatientListRow[];
  jti?: string;
}

/**
 * Return all patients on a clinician's active panel.
 *
 * Runs under the patient_read RAR (no step-up MFA). VIP patients are
 * included in the list with their vip_flag set; the agent's system prompt
 * instructs it not to display the VIP record details in the list view.
 * Full chart access for a VIP patient requires a separate get_patient_record
 * call that will trigger the step-up MFA flow.
 *
 * The SQL column set intentionally omits visit history; that lives in
 * get_patient_record.
 */
export async function listPatientsForClinician(opts: ListPatientsForClinicianOpts): Promise<ListPatientsResult> {
  const { clinicianUpn, claims, mintCred, runAsEphemeralRole } = opts;

  const cred = await mintCred({
    rarType: 'urn:smt:agent:healthcare',
    rarAction: 'patient_read',
    claims,
    exchangeToken: opts.exchangeToken ?? (await import('../verify/token-exchange.js')).exchangeToken,
  });

  const rows = await runAsEphemeralRole<PatientListRow>(
    cred,
    `SELECT mrn, display_name, dob::text AS dob, primary_diagnosis, vip_flag
     FROM clinical.patients
     WHERE primary_clinician = $1
     ORDER BY mrn`,
    [clinicianUpn],
  );

  return { patients: rows };
}
