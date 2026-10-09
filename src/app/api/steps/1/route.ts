import { NextResponse } from 'next/server';
import { isGeo } from '../../../../lib/geo';
import { googleSearch, keysFromEnv } from '../../../../lib/services';

export async function POST(req: Request) {
  // The site is public once deployed, and every search spends Serper credits: require the app password.
  const password = process.env.APP_PASSWORD;
  if (!password && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'APP_PASSWORD is not set on the server.' }, { status: 503 });
  }
  if (password && req.headers.get('x-app-password') !== password) {
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }

  const { query, geo } = (await req.json().catch(() => ({}))) as { query?: string; geo?: string };
  if (!query?.trim() || !geo || !isGeo(geo)) {
    return NextResponse.json({ error: 'Send a query and a geo of "ae" or "us".' }, { status: 400 });
  }
  try {
    const results = await googleSearch({ fetch, keys: keysFromEnv() }, query.trim(), geo);
    return NextResponse.json({ results });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
