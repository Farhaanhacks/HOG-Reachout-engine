import { NextResponse } from 'next/server';
import { SESSION_COOKIE, checkPassword, sessionToken } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

/** Whether this browser is logged in. */
export function GET(req: Request) {
  return NextResponse.json({ ok: checkPassword(req) === null });
}

/** Log in with the app password; sets a cookie for 30 days. */
export async function POST(req: Request) {
  const password = process.env.APP_PASSWORD;
  const { password: given } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password) return NextResponse.json({ ok: process.env.NODE_ENV !== 'production' });
  if (given !== password) return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, sessionToken(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}

/** Log out. */
export function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
