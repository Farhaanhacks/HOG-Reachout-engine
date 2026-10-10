import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../lib/auth';
import { isGeo } from '../../../../lib/geo';
import { parsePeople } from '../../../../lib/linkedin';
import { googleSearch, keysFromEnv } from '../../../../lib/services';

/** Step 3: one search, then each result read into a person. Returns the raw results too, to see what the parser was given. */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;

  const { query, geo } = (await req.json().catch(() => ({}))) as { query?: string; geo?: string };
  if (!query?.trim() || !geo || !isGeo(geo)) {
    return NextResponse.json({ error: 'Send a query and a geo of "ae" or "us".' }, { status: 400 });
  }
  try {
    const results = await googleSearch({ fetch, keys: keysFromEnv() }, query.trim(), geo);
    return NextResponse.json({ results, people: parsePeople(results, geo) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
