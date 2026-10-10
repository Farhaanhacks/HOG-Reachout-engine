import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { dailyLimitFromEnv, enrichStatus } from '../../../lib/enrich';
import { listRuns } from '../../../lib/run';
import { countPeople } from '../../../lib/store';

export const dynamic = 'force-dynamic';

/** Totals for the overview page. Spends nothing. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    const db = getDb();
    return NextResponse.json({ people: await countPeople(db), enrich: await enrichStatus(db, dailyLimitFromEnv()), runs: await listRuns(db, 5) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
