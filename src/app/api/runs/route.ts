import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { isGeo, type Geo } from '../../../lib/geo';
import { createRun, listRuns } from '../../../lib/run';

export const dynamic = 'force-dynamic';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(',')).map((s) => s.trim()).filter(Boolean);

export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ runs: await listRuns(getDb()) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Starts a run: { geos: ["ae","us"], segments: ["leaders",…], extraTitles?, pages?, maxQueries? }. Spends nothing yet. */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const geos = list(b.geos).filter(isGeo) as Geo[];
  try {
    const run = await createRun(getDb(), { geos, segments: list(b.segments), extraTitles: list(b.extraTitles) }, { pages: Number(b.pages), maxQueries: Number(b.maxQueries) });
    return NextResponse.json({ run });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
