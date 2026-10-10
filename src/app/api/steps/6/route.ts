import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../lib/auth';
import { getDb } from '../../../../lib/db';
import { isGeo } from '../../../../lib/geo';
import { parsePeople } from '../../../../lib/linkedin';
import { googleSearch, keysFromEnv } from '../../../../lib/services';
import { countPeople, listPeople, savePeople, splitByCountry } from '../../../../lib/store';

/** Step 6, run: one search, read the people, drop those outside the country, save the rest (each LinkedIn URL once). */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;

  const { query, geo } = (await req.json().catch(() => ({}))) as { query?: string; geo?: string };
  if (!query?.trim() || !geo || !isGeo(geo)) {
    return NextResponse.json({ error: 'Send a query and a geo of "ae" or "us".' }, { status: 400 });
  }
  try {
    const results = await googleSearch({ fetch, keys: keysFromEnv() }, query.trim(), geo);
    const people = parsePeople(results, geo);
    const { kept, excluded } = splitByCountry(people);
    const db = getDb();
    const saved = await savePeople(db, kept, geo, query.trim());
    return NextResponse.json({ found: people.length, excludedOutsideCountry: excluded.length, ...saved, counts: await countPeople(db) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Step 6, list: the saved people, newest first. */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const geo = url.searchParams.get('geo') ?? '';
  try {
    const db = getDb();
    const people = await listPeople(db, { geo: isGeo(geo) ? geo : undefined, targetOnly: url.searchParams.get('targets') === '1' });
    return NextResponse.json({ people, counts: await countPeople(db) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
