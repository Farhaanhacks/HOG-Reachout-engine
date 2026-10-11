import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { DEFAULT_SETTINGS, getSettings, saveSettings, type Settings } from '../../../lib/settings';

export const dynamic = 'force-dynamic';

/** The title rules, the edition table and emails per person, with the defaults for comparison. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ settings: await getSettings(getDb()), defaults: DEFAULT_SETTINGS });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Saves any of { rules, editions, emailsPerPerson }, or { reset: "rules" | "editions" | "emailsPerPerson" }. */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as Partial<Record<keyof Settings, unknown>> & { reset?: string };
  const reset = (['rules', 'editions', 'emailsPerPerson'] as const).find((k) => k === body.reset);
  try {
    return NextResponse.json({ settings: await saveSettings(getDb(), { rules: body.rules, editions: body.editions, emailsPerPerson: body.emailsPerPerson, reset }) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
