import { marketOf, type Market } from './markets';
import type { Db } from './store';

/**
 * The three brands leads are found for. Each sends from its own domain and covers its own countries:
 *  - Humans of Globe (humansofglobe.com): the GCC, the US, Europe and Africa.
 *  - Gulf Icons (gulficons.com): the six GCC countries.
 *  - CIO Minds (ciominds.com): the US and Europe.
 * Every lead belongs to exactly one brand, for good, so nobody is contacted by two of them.
 *
 * Each run is split 40% Gulf Icons, 30% Humans of Globe, 30% CIO Minds (BRAND_SHARE): a run of 20 aims for 8, 6 and 6
 * leads ready to email. A lead several brands could take (a GCC lead: Humans of Globe or Gulf Icons; a US or European
 * one: Humans of Globe or CIO Minds) goes to whichever of them still needs the most in the run; outside a run, to
 * whichever is furthest below its share of that overlap.
 */
export type Brand = 'hog' | 'gulficons' | 'ciominds';

export const BRANDS: Record<Brand, { label: string; domain: string; regions: Market[]; regionLabel: string }> = {
  hog: { label: 'Humans of Globe', domain: 'humansofglobe.com', regions: ['gcc', 'us', 'eu', 'af'], regionLabel: 'GCC, US, Europe, Africa' },
  gulficons: { label: 'Gulf Icons', domain: 'gulficons.com', regions: ['gcc'], regionLabel: 'GCC' },
  ciominds: { label: 'CIO Minds', domain: 'ciominds.com', regions: ['us', 'eu'], regionLabel: 'US, Europe' },
};

export const BRAND_LIST = Object.keys(BRANDS) as Brand[];

/** Each brand's share of every run. */
export const BRAND_SHARE: Record<Brand, number> = { gulficons: 0.4, hog: 0.3, ciominds: 0.3 };

export type Quotas = Record<Brand, number>;

/** How many leads ready to email each brand gets in a run of `target`: 20 gives Gulf Icons 8, Humans of Globe 6, CIO Minds 6. */
export function quotasFor(target: number): Quotas {
  const gulficons = Math.round(target * BRAND_SHARE.gulficons);
  const ciominds = Math.round(target * BRAND_SHARE.ciominds);
  return { gulficons, ciominds, hog: Math.max(0, target - gulficons - ciominds) };
}

/** Which brands a market's leads can go to (GCC: Humans of Globe or Gulf Icons…). */
export function brandsForMarket(market: Market): Brand[] {
  return BRAND_LIST.filter((b) => BRANDS[b].regions.includes(market));
}

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
 * Picks the brand for a new lead among those that cover their country. In a run (`need` = what each brand still needs),
 * the one that still needs the most; when none needs any more, or outside a run, the one furthest below its share of
 * the leads from the same overlap. Ties go to the bigger share. Returns the brand and the overlap key.
 */
export async function pickBrand(db: Db, eligible: Brand[], need?: Partial<Quotas>): Promise<{ brand: Brand; group: string } | null> {
  if (!eligible.length) return null;
  const group = eligible.join(',');
  if (eligible.length === 1) return { brand: eligible[0], group };
  const byShare = (a: Brand, b: Brand) => BRAND_SHARE[b] - BRAND_SHARE[a] || BRAND_LIST.indexOf(a) - BRAND_LIST.indexOf(b);
  const needing = eligible.filter((b) => (need?.[b] ?? 0) > 0);
  if (needing.length) return { brand: [...needing].sort((a, b) => (need?.[b] ?? 0) - (need?.[a] ?? 0) || byShare(a, b))[0], group };
  const counts = new Map(
    (await db.query<{ brand: string; n: number }>('SELECT brand, count(*)::int AS n FROM people WHERE brand_group = $1 GROUP BY brand', [group])).map((r) => [r.brand, r.n]),
  );
  const load = (b: Brand) => (counts.get(b) ?? 0) / BRAND_SHARE[b];
  return { brand: [...eligible].sort((a, b) => load(a) - load(b) || byShare(a, b))[0], group };
}

export function brandLabel(id: string | null | undefined): string {
  return isBrand(id) ? BRANDS[id].label : '—';
}
