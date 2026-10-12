import { isGcc, marketOf } from './markets';
import type { Db } from './store';

/**
 * The three brands leads are found for. Each sends from its own domain and covers its own countries:
 *  - Humans of Globe (humansofglobe.com): the US, Europe, the Middle East and Africa.
 *  - Gulf Icons (gulficons.com): the Middle East.
 *  - CIO Minds (ciominds.com): the US, Europe and the six GCC countries.
 * Every lead belongs to exactly one brand, for good, so nobody is contacted by two of them. A lead several brands could
 * take goes to whichever of them has had the fewest leads from the same overlap, so overlaps are split evenly.
 */
export type Brand = 'hog' | 'gulficons' | 'ciominds';
type Region = 'us' | 'eu' | 'me' | 'gcc' | 'af';

export const BRANDS: Record<Brand, { label: string; domain: string; regions: Region[]; regionLabel: string }> = {
  hog: { label: 'Humans of Globe', domain: 'humansofglobe.com', regions: ['us', 'eu', 'me', 'af'], regionLabel: 'US, Europe, Middle East, Africa' },
  gulficons: { label: 'Gulf Icons', domain: 'gulficons.com', regions: ['me'], regionLabel: 'Middle East' },
  ciominds: { label: 'CIO Minds', domain: 'ciominds.com', regions: ['us', 'eu', 'gcc'], regionLabel: 'US, Europe, GCC' },
};

export const BRAND_LIST = Object.keys(BRANDS) as Brand[];

export function isBrand(value: unknown): value is Brand {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BRANDS, value);
}

/** The regions a country is in: a GCC country is in both "gcc" and "me". */
function regionsOf(country: string): Region[] {
  const market = marketOf(country);
  if (!market) return [];
  const out: Region[] = [market];
  if (market === 'me' && isGcc(country)) out.push('gcc');
  return out;
}

/** The brands that cover a country, in the fixed order above ([] for countries outside every brand). */
export function eligibleBrands(country: string | null | undefined): Brand[] {
  const regions = regionsOf(country ?? '');
  return BRAND_LIST.filter((b) => BRANDS[b].regions.some((r) => regions.includes(r)));
}

/** The brand an inbox sends for, from its domain ("aisha@gulficons.com" is Gulf Icons), or null. */
export function brandOfEmail(email: string | null | undefined): Brand | null {
  const domain = (email ?? '').split('@')[1]?.toLowerCase().trim() ?? '';
  return BRAND_LIST.find((b) => domain === BRANDS[b].domain || domain.endsWith(`.${BRANDS[b].domain}`)) ?? null;
}

/**
 * Picks the brand for a new lead among those that cover their country: the one with the fewest leads so far from the
 * same overlap (e.g. "every brand" for a UAE lead, "Humans of Globe or CIO Minds" for a US one), ties going in the fixed
 * order. Returns the brand and the overlap key it was counted in.
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
