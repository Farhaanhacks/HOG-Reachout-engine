import { timingSafeEqual } from 'node:crypto';
import { NextResponse, after } from 'next/server';
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
 * Called by the outside scheduler every couple of minutes. It answers at once (so the scheduler never times out) and
 * then, in the background, moves the autopilot's hourly run on (find, write, send) for up to ~45 seconds. Does nothing
 * while the autopilot is switched off on the Run workflow page. What each call did shows in the Autopilot box there.
 */
async function handle(req: Request) {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: 'CRON_SECRET is not set on the server.' }, { status: 503 });
  if (!allowed(req)) return NextResponse.json({ error: 'Wrong or missing key.' }, { status: 401 });
  after(async () => {
    try {
      await tick({ fetch, keys: keysFromEnv() }, getDb(), { budgetMs: 45_000 });
    } catch (e) {
      console.error('autopilot tick failed', e);
    }
  });
  return NextResponse.json({ ok: true, started: true });
}

export const GET = handle;
export const POST = handle;
