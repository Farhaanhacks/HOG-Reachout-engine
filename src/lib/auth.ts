import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

export const SESSION_COOKIE = 'hog_session';

/** The login cookie's value: derived from the app password, so changing the password logs everyone out. */
export function sessionToken(password: string): string {
  return createHmac('sha256', password).update('hog-session-v1').digest('hex');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(req: Request, name: string): string {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return '';
}

/**
 * The site is public once deployed and every search spends credits, so API routes require the app password: the login
 * cookie, or the password itself in an x-app-password header. Returns an error response to send back, or null to go on.
 * Without APP_PASSWORD, login is off locally and refused in production.
 */
export function checkPassword(req: Request): NextResponse | null {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return process.env.NODE_ENV === 'production' ? NextResponse.json({ error: 'APP_PASSWORD is not set on the server.' }, { status: 503 }) : null;
  }
  const header = req.headers.get('x-app-password');
  if (header && same(header, password)) return null;
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie && same(cookie, sessionToken(password))) return null;
  return NextResponse.json({ error: 'Please log in again.' }, { status: 401 });
}
