import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { filtersFrom } from '../../../lib/lead-filters';
import { listPeople } from '../../../lib/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ people: await listPeople(getDb(), { ...filtersFrom(new URL(req.url)), limit: 500 }) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
