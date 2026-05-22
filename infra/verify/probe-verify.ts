/**
 * Sanity probe: confirms VERIFY_TENANT_HOST + admin credentials work by
 * minting an admin access token and listing the first 1 application on the
 * tenant. Admin credentials come from Vault (secret/data/VERIFY_ADMIN_CREDS)
 * with env-var fallback. Prints "Verify reachable: OK" on success.
 *
 * Usage:  npx tsx probe-verify.ts
 */
import 'dotenv/config';
import { loadAdminCreds } from './admin-creds.js';

const TENANT = process.env.VERIFY_TENANT_HOST || '';
if (!TENANT) {
  console.error('Missing VERIFY_TENANT_HOST in .env');
  process.exit(1);
}

const { clientId: ID, clientSecret: SECRET, source } = await loadAdminCreds();

const tokenRes = await fetch(`https://${TENANT}/oauth2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ID, client_secret: SECRET }),
});
if (!tokenRes.ok) {
  console.error(`Admin token request failed: ${tokenRes.status}\n${await tokenRes.text()}`);
  process.exit(1);
}
const token = (await tokenRes.json() as { access_token: string }).access_token;

const appsRes = await fetch(`https://${TENANT}/v1.0/applications?count=1`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
if (!appsRes.ok) {
  console.error(`List applications failed: ${appsRes.status}\n${await appsRes.text()}`);
  console.error('The admin client may be missing the manageApplications entitlement.');
  process.exit(1);
}
console.log('Verify reachable: OK');
console.log(`  Tenant: ${TENANT}`);
console.log(`  Admin client id: ${ID.slice(0, 8)}... (from ${source})`);
