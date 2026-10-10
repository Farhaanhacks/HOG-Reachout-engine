import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../../lib/auth';
import { getDb } from '../../../../../lib/db';
import { finishRun } from '../../../../../lib/run';

/** Marks the run done, or stopped by the user: { status: "done" | "stopped" }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const { id } = await params;
  const { status } = (await req.json().catch(() => ({}))) as { status?: string };
  try {
    return NextResponse.json({ run: await finishRun(getDb(), id, status === 'stopped' ? 'stopped' : 'done') });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
