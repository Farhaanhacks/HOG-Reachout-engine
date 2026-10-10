import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../lib/auth';
import { isGeo } from '../../../../lib/geo';
import { googleSearch, keysFromEnv } from '../../../../lib/services';
import { rankDomains } from '../../../../lib/website';

/** Step 5: finds a company's own website. Returns every candidate with its score, to see why one was chosen. */
export async function POST(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;

  const { company, geo, city } = (await req.json().catch(() => ({}))) as { company?: string; geo?: string; city?: string };
  if (!company?.trim() || !geo || !isGeo(geo)) {
    return NextResponse.json({ error: 'Send a company and a geo of "ae" or "us".' }, { status: 400 });
  }
  const query = `${company} ${city ?? ''} official website`.replace(/\s+/g, ' ').trim();
  try {
    const results = await googleSearch({ fetch, keys: keysFromEnv() }, query, geo);
    const candidates = rankDomains(company, results);
    const best = candidates[0];
    return NextResponse.json({ query, candidates, domain: best && best.score > 0 ? best.domain : '' });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
