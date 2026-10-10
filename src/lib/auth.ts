import { NextResponse } from 'next/server';

/**
 * The site is public once deployed and every search spends Serper credits, so API routes require
 * the app password. Returns an error response to send back, or null when the request may go on.
 */
export function checkPassword(req: Request): NextResponse | null {
  const password = process.env.APP_PASSWORD;
  if (!password && process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'APP_PASSWORD is not set on the server.' }, { status: 503 });
  }
  if (password && req.headers.get('x-app-password') !== password) {
    return NextResponse.json({ error: 'Wrong password.' }, { status: 401 });
  }
  return null;
}
