/**
 * Load the Verify admin client_id + client_secret. Vault first
 * (secret/data/VERIFY_ADMIN_CREDS, fields client_id + client_secret),
 * env fallback (VERIFY_ADMIN_CLIENT_ID + VERIFY_ADMIN_CLIENT_SECRET).
 *
 * Shared between bootstrap-verify.ts and probe-verify.ts so both reflect
 * the same lookup order and there is one place to change if the Vault
 * path is renamed.
 */
import 'dotenv/config';

const VAULT_ADDR = process.env.VAULT_ADDR;
const VAULT_TOKEN = process.env.VAULT_TOKEN;

async function readVaultKv(path: string, field: string): Promise<string | null> {
  if (!VAULT_ADDR || !VAULT_TOKEN) return null;
  try {
    const url = `${VAULT_ADDR.replace(/\/$/, '')}/v1/${path}`;
    const res = await fetch(url, { headers: { 'X-Vault-Token': VAULT_TOKEN } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { data?: Record<string, string> } };
    const value = body.data?.data?.[field];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export interface AdminCreds {
  clientId: string;
  clientSecret: string;
  source: 'vault' | 'env';
}

export async function loadAdminCreds(): Promise<AdminCreds> {
  const vaultId = await readVaultKv('secret/data/VERIFY_ADMIN_CREDS', 'client_id');
  const vaultSecret = await readVaultKv('secret/data/VERIFY_ADMIN_CREDS', 'client_secret');
  if (vaultId && vaultSecret) {
    return { clientId: vaultId, clientSecret: vaultSecret, source: 'vault' };
  }
  const envId = process.env.VERIFY_ADMIN_CLIENT_ID;
  const envSecret = process.env.VERIFY_ADMIN_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, source: 'env' };
  }
  console.error('Missing Verify admin credentials.');
  console.error('Either write them to Vault:');
  console.error('  docker exec -e VAULT_TOKEN=vva-dev-root-token vva-vault \\');
  console.error('    vault kv put secret/VERIFY_ADMIN_CREDS \\');
  console.error('      client_id=<id> client_secret=<secret>');
  console.error('Or set both env vars in .env:');
  console.error('  VERIFY_ADMIN_CLIENT_ID=<id>');
  console.error('  VERIFY_ADMIN_CLIENT_SECRET=<secret>');
  process.exit(1);
}
