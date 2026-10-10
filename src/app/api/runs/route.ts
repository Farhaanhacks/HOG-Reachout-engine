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

/** Starts a run: { maxQueries?, pages? }. Covers every type of lead in both countries unless geos or segments are given. Spends nothing yet. */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const run = await createRun(
      getDb(),
      {
        geos: b.geos === undefined ? undefined : (list(b.geos).filter(isGeo) as Geo[]),
        segments: b.segments === undefined ? undefined : list(b.segments),
        extraTitles: list(b.extraTitles),
      },
      { pages: Number(b.pages), maxQueries: Number(b.maxQueries) },
    );
    return NextResponse.json({ run });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
