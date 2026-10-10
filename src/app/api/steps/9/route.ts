import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { DEFAULT_DAILY_LIMIT, enrichStatus, pendingPeople, runEnrichment } from '../../../../lib/enrich';
import { keysFromEnv } from '../../../../lib/services';
import { listPeople } from '../../../../lib/store';

const dailyLimit = () => Math.max(1, Number(process.env.APOLLO_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT);

/** Status and the people already looked up. Spends no credits. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    const db = getDb();
    const people = (await listPeople(db, { limit: 500 })).filter((p) => p.apollo_status !== 'none').slice(0, 100);
    return NextResponse.json({ status: await enrichStatus(db, dailyLimit()), people });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * action "preview": who would be sent to Apollo. Spends no credits.
 * action "run" with confirm true: sends up to `limit` people to Apollo. Spends credits.
 */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { action?: string; limit?: number; confirm?: boolean };
  const limit = Math.max(1, Math.min(Number(body.limit) || 10, 100));
  try {
    const db = getDb();
    if (body.action === 'preview') {
      const people = await pendingPeople(db, limit);
      return NextResponse.json({ people, status: await enrichStatus(db, dailyLimit()) });
    }
    if (body.action === 'run') {
      if (body.confirm !== true) return NextResponse.json({ error: 'Running spends Apollo credits: send confirm true.' }, { status: 400 });
      const summary = await runEnrichment({ fetch, keys: keysFromEnv() }, db, { limit, dailyLimit: dailyLimit() });
      return NextResponse.json({ summary, status: await enrichStatus(db, dailyLimit()) });
    }
    return NextResponse.json({ error: 'Send action "preview" or "run".' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
