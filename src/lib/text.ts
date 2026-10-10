const SECOND_LEVEL = /^(co|com|net|org|gov|ac|edu|res|gen|firm|ind)$/;

/** "https://www.Acme.com/about" gives "acme.com". */
export function domainOf(s: string | null | undefined): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#\s]/)[0];
}

/** The registrable domain: "ae.linkedin.com" gives "linkedin.com", "shop.acme.co.ae" gives "acme.co.ae". */
export function rootDomain(s: string | null | undefined): string {
  const parts = domainOf(s).split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const keep = SECOND_LEVEL.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-keep).join('.');
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
