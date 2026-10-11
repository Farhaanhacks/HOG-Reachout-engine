import { createHmac, timingSafeEqual } from 'node:crypto';
import { getJson, type Services } from './services';
import { ensureSchema, type Db } from './store';

/**
 * Unsubscribe links: every email ends with a link unique to the person, signed so nobody can unsubscribe someone else
 * by guessing. Unsubscribing marks the person in the database (they are never personalized or sent again) and adds
 * their email to the Instantly blocklist, so no campaign emails them.
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

/** Adds an email to the Instantly blocklist, so no campaign sends to it. */
export async function blockInInstantly(svc: Services, email: string): Promise<void> {
  if (!svc.keys.instantly) throw new Error('INSTANTLY_API_KEY is not set');
  await getJson(svc, 'https://api.instantly.ai/api/v2/block-lists-entries', {
    method: 'POST',
    headers: { authorization: `Bearer ${svc.keys.instantly}`, 'content-type': 'application/json' },
    body: JSON.stringify({ bl_value: email }),
  });
}

export type UnsubscribeResult = 'unsubscribed' | 'test' | 'invalid';

/**
 * Unsubscribes the person a token names. Safe to repeat. If the Instantly blocklist cannot be reached now, the person
 * is still marked and the blocklist is retried by syncUnsubscribes.
 */
export async function unsubscribe(svc: Services, db: Db, token: string | null | undefined): Promise<UnsubscribeResult> {
  const id = readToken(token);
  if (!id) return 'invalid';
  if (id === TEST_ID) return 'test';
  await ensureSchema(db);
  const [row] = await db.query<{ email: string; unsubscribe_blocked: boolean }>(
    'UPDATE people SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1 RETURNING email, unsubscribe_blocked',
    [id],
  );
  if (!row) return 'invalid';
  if (row.email && !row.unsubscribe_blocked && svc.keys.instantly) {
    try {
      await blockInInstantly(svc, row.email);
      await db.query('UPDATE people SET unsubscribe_blocked = TRUE WHERE id = $1', [id]);
    } catch {
      // Retried by syncUnsubscribes.
    }
  }
  return 'unsubscribed';
}

/** Blocklists anyone who unsubscribed while Instantly could not be reached. Returns how many were synced. */
export async function syncUnsubscribes(svc: Services, db: Db): Promise<number> {
  if (!svc.keys.instantly) return 0;
  await ensureSchema(db);
  const rows = await db.query<{ id: number | string; email: string }>(
    "SELECT id, email FROM people WHERE unsubscribed_at IS NOT NULL AND NOT unsubscribe_blocked AND email <> '' LIMIT 50",
  );
  let synced = 0;
  for (const r of rows) {
    try {
      await blockInInstantly(svc, r.email);
      await db.query('UPDATE people SET unsubscribe_blocked = TRUE WHERE id = $1', [r.id]);
      synced++;
    } catch {
      break; // Instantly is still unreachable: try again next time.
    }
  }
  return synced;
}
