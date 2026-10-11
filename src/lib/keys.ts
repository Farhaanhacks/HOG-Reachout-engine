import { canonicalProfileUrl } from './linkedin';

/** Normalized forms of emails, domains, LinkedIn profiles and company names, so the same thing always matches. */

/** Email providers anyone can sign up to: their domains are never blocked as a company. */
export const FREEMAIL = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'outlook.com', 'live.com',
  'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com',
  'yandex.com', 'yandex.ru', 'zoho.com', 'ymail.com', 'rocketmail.com', 'orange.fr', 'free.fr', 'laposte.net', 'libero.it', 'btinternet.com',
]);

export function normEmail(raw: string | null | undefined): string {
  const e = String(raw ?? '').trim().toLowerCase().replace(/^mailto:/, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

/** "https://www.Acme.com/about" gives "acme.com". */
export function normDomain(raw: string | null | undefined): string {
  let d = String(raw ?? '').trim().toLowerCase();
  if (!d) return '';
  if (d.includes('@')) d = d.split('@').pop() ?? '';
  d = d.replace(/^[a-z]+:\/\//, '').replace(/^www\d?\./, '').split(/[/?#:\s]/)[0].replace(/\.+$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : '';
}

/** The company domain from a work email; '' for free email providers. */
export function emailDomain(email: string | null | undefined): string {
  const d = normDomain(normEmail(email).split('@')[1] ?? '');
  return d && !FREEMAIL.has(d) ? d : '';
}

export function isFreemail(domain: string): boolean {
  return FREEMAIL.has(domain);
}

export function linkedinKey(raw: string | null | undefined): string {
  return canonicalProfileUrl(String(raw ?? ''));
}

const LEGAL = /\b(inc|incorporated|llc|ltd|limited|plc|llp|lp|gmbh|ag|sa|sas|sarl|srl|spa|bv|nv|pty|pvt|private|co|corp|corporation|company|fze|fzco|fz llc|dmcc)\b/g;

/** "Acme Holdings, Inc." gives "acme holdings": the same company however it is written. */
export function companyKey(raw: string | null | undefined): string {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    // Dots go first, so "S.A." and "L.L.C." read as "sa" and "llc".
    .replace(/\./g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(LEGAL, ' ')
    .replace(/^\s*the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

