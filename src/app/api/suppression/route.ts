import { NextResponse } from 'next/server';
import { checkPassword } from '../../../lib/auth';
import { getDb } from '../../../lib/db';
import { clearSuppression, importSuppression, suppressionStatus, type ImportRow, type SuppressionSource } from '../../../lib/suppression';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const SOURCES: SuppressionSource[] = ['client', 'contacted', 'manual'];

/** How many entries the suppression list holds, by source and kind, and how many saved leads it blocks. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await suppressionStatus(getDb()));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * action "import": adds rows { source: "client" | "contacted" | "manual", rows: [{ email, website, linkedin, company }] }.
 * The page sends a big file in parts of a few thousand rows.
 * action "clear": removes every entry from one source { source }.
 */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => ({}))) as { action?: string; source?: string; rows?: ImportRow[]; note?: string };
  const source = SOURCES.find((s) => s === body.source);
  if (!source) return NextResponse.json({ error: 'Send source "client", "contacted" or "manual".' }, { status: 400 });
  try {
    const db = getDb();
    if (body.action === 'import') {
      const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
      if (!rows.length) return NextResponse.json({ error: 'No rows to import.' }, { status: 400 });
      const summary = await importSuppression(db, rows, source, body.note ?? '');
      return NextResponse.json({ summary, status: await suppressionStatus(db) });
    }
    if (body.action === 'clear') {
      const removed = await clearSuppression(db, source);
      return NextResponse.json({ removed, status: await suppressionStatus(db) });
    }
    return NextResponse.json({ error: 'Send action "import" or "clear".' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
