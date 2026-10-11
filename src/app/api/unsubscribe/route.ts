import { getDb } from '../../../lib/db';
import { keysFromEnv } from '../../../lib/services';
import { readToken, unsubscribe } from '../../../lib/unsubscribe';

export const dynamic = 'force-dynamic';

/**
 * The public unsubscribe page (no login), reached at /unsubscribe?t=…
 * GET shows a single Unsubscribe button rather than acting at once, because email security scanners open links
 * automatically. POST unsubscribes: from that button, or from a mail app's one-click unsubscribe (RFC 8058).
 */

function page(title: string, message: string, form = ''): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Humans of Globe</title><meta name="robots" content="noindex">
<style>
  :root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--fg:#14171a;--muted:#5d646d;--accent:#3b73cf}
  @media (prefers-color-scheme:dark){:root{--bg:#111213;--card:#1a1b1d;--fg:#ededee;--muted:#a1a5ab;--accent:#4a84e2}}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;padding:24px 16px;box-sizing:border-box}
  main{max-width:440px;width:100%;background:var(--card);border-radius:16px;padding:36px 32px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  h1{font-size:1.5rem;margin:0 0 10px}p{margin:0 0 20px;color:var(--muted)}b.brand{display:block;font-size:.95rem;margin-bottom:18px;color:var(--fg)}
  button{font:inherit;font-weight:600;width:100%;padding:13px 18px;border:0;border-radius:9px;background:var(--accent);color:#fff;cursor:pointer}
  button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}
</style></head><body><main><b class="brand">Humans of Globe</b><h1>${title}</h1><p>${message}</p>${form}</main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}

const tokenFrom = (req: Request) => new URL(req.url).searchParams.get('t');

export function GET(req: Request) {
  const token = tokenFrom(req);
  if (!readToken(token)) return page('This link has expired', 'We could not recognise this unsubscribe link. Reply to the email with "unsubscribe" and we will remove you.');
  const t = encodeURIComponent(token ?? '');
  return page(
    'Unsubscribe',
    'Press the button and you will not receive any more emails from Humans of Globe.',
    `<form method="post" action="/unsubscribe?t=${t}"><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function POST(req: Request) {
  let token = tokenFrom(req);
  if (!token) {
    const form = await req.formData().catch(() => null);
    token = (form?.get('t') as string | null) ?? null;
  }
  try {
    const result = await unsubscribe({ fetch, keys: keysFromEnv() }, getDb(), token);
    if (result === 'invalid') return page('This link has expired', 'We could not recognise this unsubscribe link. Reply to the email with "unsubscribe" and we will remove you.');
    if (result === 'test') return page('Test link works', 'This was a test email, so nobody was unsubscribed. In real emails this button removes the person from every campaign.');
    return page('You are unsubscribed', 'You will not receive any more emails from Humans of Globe. Sorry for the interruption.');
  } catch {
    return page('Something went wrong', 'We could not process this right now. Please try again in a minute, or reply to the email with "unsubscribe".');
  }
}
