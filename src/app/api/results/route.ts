import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { keysFromEnv } from '../../../lib/services';
import { GROUPS, breakdown, lastSync, replies, syncMessages, totals, type GroupKey } from '../../../lib/tracking';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Results over the last `days` (default 30): totals, a breakdown by every group, and everyone who replied. Reads the latest from Apollo first (free). */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const days = Math.max(1, Math.min(Number(url.searchParams.get('days')) || 30, 365));
  const svc = { fetch, keys: keysFromEnv() };
  try {
    const db = getDb();
    const sync = url.searchParams.get('sync') === '0' ? null : await syncMessages(svc, db, { budgetMs: 25_000 }).catch((e: Error) => ({ error: e.message }));
    const keys = Object.keys(GROUPS) as GroupKey[];
    const groups = await Promise.all(keys.map(async (k) => ({ key: k, label: GROUPS[k].label, rows: await breakdown(db, k, days) })));
    return NextResponse.json({ days, sync, lastSync: await lastSync(db), totals: await totals(db, days), groups, replies: await replies(db) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
