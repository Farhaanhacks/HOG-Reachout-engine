import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { runStep } from '../../../../../lib/run';
import { keysFromEnv } from '../../../../../lib/services';

export const maxDuration = 60;

/** Works through the run's next query. Spends Serper searches. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const { id } = await params;
  try {
    return NextResponse.json({ run: await runStep({ fetch, keys: keysFromEnv() }, getDb(), id) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
