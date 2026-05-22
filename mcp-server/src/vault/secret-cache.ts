/**
 * Tiny in-memory cache in front of Vault KV v2.
 *
 * Why this exists: the MCP server's TE client_secret lives in Vault, not in
 * mcp-server/.env. On the first Token Exchange call we fetch it from Vault
 * and hold it for VVA_SECRET_CACHE_TTL_MS (default 5 minutes). The next call
 * within that window reuses the cached value; the call after the window
 * fetches fresh.
 *
 * Fallback: if process.env[envFallbackName] is set, that value is used and
 * Vault is never touched. The fallback exists so a customer adapting this
 * pattern to an environment without Vault can still run the cookbook by
 * pasting the secret into .env.
 */

type CacheEntry = { value: string; expiresAt: number };

const CACHE = new Map<string, CacheEntry>();
const TTL_MS = Number(process.env.VVA_SECRET_CACHE_TTL_MS ?? 5 * 60 * 1000);

/**
 * Get a KV v2 field value from Vault, with a 5-minute cache and optional
 * env-var fallback.
 *
 * @param path KV v2 data path, e.g. "secret/data/VERIFY_TE_CLIENT_SECRET"
 * @param field The field name inside the secret's data object, e.g. "value"
 * @param envFallbackName Optional env-var name to read when Vault is not
 *   reachable or VAULT_ADDR/VAULT_TOKEN are not set.
 */
export async function getSecret(
  path: string,
  field: string,
  envFallbackName?: string,
): Promise<string> {
  const cacheKey = `${path}#${field}`;
  const hit = CACHE.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const vaultAddr = process.env.VAULT_ADDR;
  const vaultToken = process.env.VAULT_TOKEN;

  // Env fallback path: customer's stack has no Vault, or they want a
  // local override for development.
  if (!vaultAddr || !vaultToken) {
    if (envFallbackName && process.env[envFallbackName]) {
      const v = process.env[envFallbackName]!;
      CACHE.set(cacheKey, { value: v, expiresAt: Date.now() + TTL_MS });
      return v;
    }
    throw new Error(
      `getSecret(${path}#${field}): VAULT_ADDR + VAULT_TOKEN are not set` +
        (envFallbackName ? ` and env fallback ${envFallbackName} is empty` : ''),
    );
  }

  const url = `${vaultAddr.replace(/\/$/, '')}/v1/${path}`;
  const res = await fetch(url, {
    headers: { 'X-Vault-Token': vaultToken },
  });

  if (!res.ok) {
    // Try env fallback before giving up; lets a customer keep running if
    // Vault is briefly unreachable mid-shift.
    if (envFallbackName && process.env[envFallbackName]) {
      const v = process.env[envFallbackName]!;
      CACHE.set(cacheKey, { value: v, expiresAt: Date.now() + TTL_MS });
      return v;
    }
    throw new Error(`Vault KV fetch failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { data?: { data?: Record<string, string> } };
  const value = body.data?.data?.[field];
  if (typeof value !== 'string') {
    throw new Error(
      `Vault KV at ${path} has no field ${field} (got: ${JSON.stringify(body.data?.data ?? null)})`,
    );
  }

  CACHE.set(cacheKey, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** Drop a single key from the cache (useful on auth failures). */
export function invalidateSecret(path: string, field: string): void {
  CACHE.delete(`${path}#${field}`);
}
