import * as pg from 'pg';
import type { MintedCred } from '../vault/verify-rar-client.js';

const PG_HOST = process.env.POSTGRES_HOST ?? '127.0.0.1';
const PG_PORT = Number(process.env.POSTGRES_PORT ?? 5432);
const PG_DB   = process.env.POSTGRES_DB ?? 'healthcare';

/**
 * Run a parameterised SQL query as the ephemeral Postgres user just minted
 * by the verify-rar plugin.
 *
 * Opens a one-shot pg.Pool authenticated as the ephemeral user, runs the
 * query, closes the pool, and returns the rows. The caller is responsible for
 * revoking the Vault lease (early-revoke pattern) after this returns.
 *
 * We create a fresh Pool per call rather than keeping a long-lived pool so
 * that the ephemeral role's lifetime is tied only to the Vault TTL, not to
 * a connection that might outlive it.
 */
export async function runAsEphemeralRole<T extends pg.QueryResultRow>(
  cred: MintedCred,
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const pool = new pg.Pool({
    host: PG_HOST,
    port: PG_PORT,
    database: PG_DB,
    user: cred.username,
    password: cred.password,
    max: 2,
    idleTimeoutMillis: 1000,
  });

  try {
    const result = await pool.query<T>(sql, params);
    return result.rows;
  } finally {
    await pool.end();
  }
}
