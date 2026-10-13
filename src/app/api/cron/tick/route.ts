import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { tick } from '../../../../lib/autopilot';
import { getDb } from '../../../../lib/db';
import { keysFromEnv } from '../../../../lib/services';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The secret is sent as "Authorization: Bearer <CRON_SECRET>" (or ?key=<CRON_SECRET> for schedulers without headers). */
function allowed(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  if (secret.length < 16) return false;
  const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || new URL(req.url).searchParams.get('key') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Called by the outside scheduler every couple of minutes: moves the autopilot's hourly run on (find, write, send) for
 * up to ~45 seconds. Does nothing while the autopilot is switched off on the Run workflow page.
 */
async function handle(req: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'CRON_SECRET is not set on the server.' }, { status: 503 });
  if (!allowed(req)) return NextResponse.json({ error: 'Wrong or missing key.' }, { status: 401 });
  try {
    return NextResponse.json(await tick({ fetch, keys: keysFromEnv() }, getDb(), { budgetMs: 45_000 }));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

export const GET = handle;
export const POST = handle;
