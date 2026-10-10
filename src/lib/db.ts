import postgres from 'postgres';
import type { Db } from './store';

let cached: Db | undefined;

/**
 * The Postgres database named by DATABASE_URL (Supabase's "Transaction pooler" string or any other Postgres).
 * Created on first use, so building the site never needs the database.
 */
export function getDb(): Db {
  if (cached) return cached;
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  // The transaction pooler does not support prepared statements; one connection per serverless instance is enough.
  const client = postgres(url, {
    prepare: false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? false : 'require',
  });
  cached = { query: async (text, params = []) => (await client.unsafe(text, params as never[])) as never };
  return cached;
}
