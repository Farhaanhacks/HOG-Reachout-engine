import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { autopilotStatus, setAutopilot } from '../../../lib/autopilot';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

/** The autopilot's switch, size, last scheduler call and current run. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ ...(await autopilotStatus(getDb())), secretSet: !!process.env.CRON_SECRET });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Switches the autopilot on or off { enabled }, or changes leads per hour { perHour }. */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean; perHour?: number };
  try {
    const db = getDb();
    await setAutopilot(db, {
      ...(body.enabled !== undefined ? { enabled: !!body.enabled } : {}),
      ...(body.perHour !== undefined ? { perHour: Number(body.perHour) } : {}),
    });
    return NextResponse.json({ ...(await autopilotStatus(db)), secretSet: !!process.env.CRON_SECRET });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
