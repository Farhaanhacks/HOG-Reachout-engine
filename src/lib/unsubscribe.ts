import { createHmac, timingSafeEqual } from 'node:crypto';
import { stopInSequences } from './apollo-sequences';
import type { Services } from './services';
import { ensureSchema, type Db } from './store';

/**
 * Unsubscribe links: every email ends with a link unique to the person, signed so nobody can unsubscribe someone else
 * by guessing. Unsubscribing marks the person in the database (they are never personalized or sent again) and stops
 * their Apollo sequence.
 *
 * The signing secret is UNSUBSCRIBE_SECRET. Set it once and never change it: changing it breaks the links in emails
 * already sent. Without it the app password is used.
 */

/** The id used for test sends: its link opens the page but unsubscribes nobody. */
export const TEST_ID = 'test';

function secret(): string {
  return process.env.UNSUBSCRIBE_SECRET || process.env.APP_PASSWORD || 'local-development-only';
}

function sign(id: string): string {
  return createHmac('sha256', secret()).update(`unsubscribe:${id}`).digest('hex').slice(0, 32);
}

export function unsubscribeToken(id: number | string): string {
  const raw = String(id);
  return `${Buffer.from(raw).toString('base64url')}.${sign(raw)}`;
}

/** The person id in a token, or null when the token is not one of ours. */
export function readToken(token: string | null | undefined): string | null {
  const [encoded, mac] = String(token ?? '').split('.');
  if (!encoded || !mac) return null;
  let id: string;
  try {
    id = Buffer.from(encoded, 'base64url').toString();
  } catch {
    return null;
  }
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

/** The site's public address: APP_URL, or the Vercel production address. */
export function siteUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:3000';
}

export function unsubscribeUrl(id: number | string): string {
  return `${siteUrl()}/unsubscribe?t=${unsubscribeToken(id)}`;
}

export type UnsubscribeResult = 'unsubscribed' | 'test' | 'invalid';

type Row = { id: number | string; apollo_contact_id: string; apollo_sequence_id: string };

/**
 * Stops the person in the Apollo sequence they were added to. Someone never added to a sequence has nothing to stop.
 * Throws when Apollo cannot be reached, so the caller can retry later.
 */
async function stopInApollo(svc: Services, db: Db, row: Row): Promise<void> {
  if (row.apollo_contact_id && row.apollo_sequence_id) await stopInSequences(svc, [row.apollo_sequence_id], [row.apollo_contact_id]);
  await db.query('UPDATE people SET unsubscribe_blocked = TRUE WHERE id = $1', [row.id]);
}

/**
 * Unsubscribes the person a token names. Safe to repeat. They are marked at once, so they are never personalized or
 * sent again, and their Apollo sequence is stopped. If Apollo cannot be reached now, that is retried by syncUnsubscribes.
 */
export async function unsubscribe(svc: Services, db: Db, token: string | null | undefined): Promise<UnsubscribeResult> {
  const id = readToken(token);
  if (!id) return 'invalid';
  if (id === TEST_ID) return 'test';
  await ensureSchema(db);
  const [row] = await db.query<Row & { unsubscribe_blocked: boolean }>(
    'UPDATE people SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1 RETURNING id, apollo_contact_id, apollo_sequence_id, unsubscribe_blocked',
    [id],
  );
  if (!row) return 'invalid';
  if (!row.unsubscribe_blocked && svc.keys.apollo) {
    try {
      await stopInApollo(svc, db, row);
    } catch {
      // Retried by syncUnsubscribes.
    }
  }
  return 'unsubscribed';
}

/** Stops the Apollo sequence of anyone who unsubscribed while Apollo could not be reached. Returns how many were synced. */
export async function syncUnsubscribes(svc: Services, db: Db): Promise<number> {
  if (!svc.keys.apollo) return 0;
  await ensureSchema(db);
  const rows = await db.query<Row>('SELECT id, apollo_contact_id, apollo_sequence_id FROM people WHERE unsubscribed_at IS NOT NULL AND NOT unsubscribe_blocked LIMIT 50');
  let synced = 0;
  for (const r of rows) {
    try {
      await stopInApollo(svc, db, r);
      synced++;
    } catch {
      break; // Apollo is still unreachable: try again next time.
    }
  }
  return synced;
}
