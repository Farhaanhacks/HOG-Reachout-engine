import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { dailyLimitFromEnv } from '../../../../../lib/enrich';
import { runStep } from '../../../../../lib/run';
import { keysFromEnv } from '../../../../../lib/services';

export const maxDuration = 60;

/** Works through the run's next Apollo search page: the search is free, the lookups it leads to spend Apollo credits (within APOLLO_DAILY_LIMIT). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    return NextResponse.json(await runStep({ fetch, keys: keysFromEnv() }, getDb(), id, { dailyLimit: dailyLimitFromEnv() }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
