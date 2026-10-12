import { marketOf, type Market } from './markets';
import type { Db } from './store';

/**
 * The three brands leads are found for. Each sends from its own domain and covers its own countries:
 *  - Humans of Globe (humansofglobe.com): the GCC, the US, Europe and Africa.
 *  - Gulf Icons (gulficons.com): the six GCC countries.
 *  - CIO Minds (ciominds.com): the US and Europe.
 * Every lead belongs to exactly one brand, for good, so nobody is contacted by two of them. A lead several brands could
 * take (a GCC lead: Humans of Globe or Gulf Icons; a US or European one: Humans of Globe or CIO Minds) goes to whichever
 * of them has had the fewest leads from the same overlap, so overlaps are split evenly.
 */
export type Brand = 'hog' | 'gulficons' | 'ciominds';

export const BRANDS: Record<Brand, { label: string; domain: string; regions: Market[]; regionLabel: string }> = {
  hog: { label: 'Humans of Globe', domain: 'humansofglobe.com', regions: ['gcc', 'us', 'eu', 'af'], regionLabel: 'GCC, US, Europe, Africa' },
  gulficons: { label: 'Gulf Icons', domain: 'gulficons.com', regions: ['gcc'], regionLabel: 'GCC' },
  ciominds: { label: 'CIO Minds', domain: 'ciominds.com', regions: ['us', 'eu'], regionLabel: 'US, Europe' },
};

export const BRAND_LIST = Object.keys(BRANDS) as Brand[];

export function isBrand(value: unknown): value is Brand {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BRANDS, value);
}

/** The brands that cover a country, in the fixed order above ([] for countries outside every brand). */
export function eligibleBrands(country: string | null | undefined): Brand[] {
  const market = marketOf(country);
  return market ? BRAND_LIST.filter((b) => BRANDS[b].regions.includes(market)) : [];
}

/** The brand an inbox sends for, from its domain ("aisha@gulficons.com" is Gulf Icons), or null. */
export function brandOfEmail(email: string | null | undefined): Brand | null {
  const domain = (email ?? '').split('@')[1]?.toLowerCase().trim() ?? '';
  return BRAND_LIST.find((b) => domain === BRANDS[b].domain || domain.endsWith(`.${BRANDS[b].domain}`)) ?? null;
}

/**
 * Picks the brand for a new lead among those that cover their country: the one with the fewest leads so far from the
 * same overlap (e.g. "Humans of Globe or Gulf Icons" for a UAE lead, "Humans of Globe or CIO Minds" for a US one), ties
 * going in the fixed order. Returns the brand and the overlap key it was counted in.
 */
export async function pickBrand(db: Db, eligible: Brand[]): Promise<{ brand: Brand; group: string } | null> {
  if (!eligible.length) return null;
  const group = eligible.join(',');
  if (eligible.length === 1) return { brand: eligible[0], group };
  const counts = new Map(
    (await db.query<{ brand: string; n: number }>('SELECT brand, count(*)::int AS n FROM people WHERE brand_group = $1 GROUP BY brand', [group])).map((r) => [r.brand, r.n]),
  );
  const brand = [...eligible].sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0) || BRAND_LIST.indexOf(a) - BRAND_LIST.indexOf(b))[0];
  return { brand, group };
}

export function brandLabel(id: string | null | undefined): string {
  return isBrand(id) ? BRANDS[id].label : '—';
}
