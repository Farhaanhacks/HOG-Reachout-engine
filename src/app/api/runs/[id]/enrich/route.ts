import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { dailyLimitFromEnv } from '../../../../../lib/enrich';
import { enrichRun } from '../../../../../lib/run';
import { keysFromEnv } from '../../../../../lib/services';

export const maxDuration = 60;

/** Sends waiting target people to Apollo and adds the cost to the run. Spends Apollo credits: needs { confirm: true }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { limit?: number; confirm?: boolean };
  if (body.confirm !== true) return NextResponse.json({ error: 'Getting emails spends Apollo credits: send confirm true.' }, { status: 400 });
  const limit = Math.max(1, Math.min(Number(body.limit) || 20, 100));
  try {
    return NextResponse.json(await enrichRun({ fetch, keys: keysFromEnv() }, getDb(), id, { limit, dailyLimit: dailyLimitFromEnv() }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
