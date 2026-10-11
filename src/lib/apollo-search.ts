import { MARKETS, type Market } from './markets';
import { getJson, type Services } from './services';
import { SECTORS, SECTOR_LABEL, type Sector, type TitleRules } from './targeting';

/**
 * Apollo People Search: finds people by title, where they are based, company size and verified email, and costs no
 * credits. It returns Apollo ids, first names, titles and company names only; the full record (email, LinkedIn,
 * website, industry, size, country) comes from bulk_match by id, which costs credits.
 */

const URL_BASE = 'https://api.apollo.io/api/v1/mixed_people/api_search';

/** Results per search page. 50 keeps each step (one search plus the lookups it leads to) well under a minute. */
export const PER_PAGE = 50;
/** Apollo shows at most 50,000 records per search. */
export const MAX_PAGE = Math.floor(50_000 / PER_PAGE);

export const SMALL_RANGE = '1,50';
export const LARGE_RANGE = '51,1000000';

/** One search in a market: these titles, at companies of this size, optionally narrowed by a keyword. */
export type SearchSpec = {
  /** Stable name for the search, used to remember how deep it has been read. Changes when its titles change. */
  key: string;
  market: Market;
  label: string;
  sector: Sector;
  titles: string[];
  ranges: string[];
  keywords?: string;
};

export type FoundPerson = { id: string; firstName: string; title: string; company: string; hasEmail: boolean };

/** Query string with repeated array keys, as Apollo expects: person_titles[]=a&person_titles[]=b. */
function query(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    if (Array.isArray(v)) for (const item of v) parts.push(`${encodeURIComponent(`${k}[]`)}=${encodeURIComponent(item)}`);
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

/** The search's address. Only people Apollo holds a verified email for are asked for. */
export function searchUrl(spec: SearchSpec, page: number): string {
  return `${URL_BASE}?${query({
    'person_titles': spec.titles,
    include_similar_titles: true,
    'person_locations': MARKETS[spec.market].countries,
    'organization_num_employees_ranges': spec.ranges,
    'contact_email_status': ['verified'],
    q_keywords: spec.keywords,
    page,
    per_page: PER_PAGE,
  })}`;
}

type SearchResponse = {
  total_entries?: number;
  people?: { id?: string; first_name?: string | null; title?: string | null; has_email?: boolean | null; organization?: { name?: string | null } | null }[];
};

export async function searchPeople(svc: Services, spec: SearchSpec, page: number): Promise<{ total: number; people: FoundPerson[] }> {
  const key = svc.keys.apollo;
  if (!key) throw new Error('APOLLO_API_KEY is not set');
  const res = await getJson<SearchResponse>(svc, searchUrl(spec, page), {
    method: 'POST',
    headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json', 'cache-control': 'no-cache' },
  });
  return {
    total: Number(res.total_entries) || 0,
    people: (res.people ?? [])
      .filter((p) => p.id)
      .map((p) => ({ id: String(p.id), firstName: p.first_name ?? '', title: p.title ?? '', company: p.organization?.name ?? '', hasEmail: p.has_email !== false })),
  };
}

const unique = (list: string[]) => [...new Set(list)];
const short = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/**
 * Every search for a market, from the title rules:
 *  - everyone's small-firm titles at 1–50 employees, and large-firm titles at 51+;
 *  - each sector's own titles (Chief Medical Officer, General Manager) at any size, narrowed to that sector by keyword
 *    where the title alone is too broad ("General Manager"). Whether a lead really is in the sector is checked on their
 *    Apollo industry once their record is fetched.
 * The healthcare and hospitality CEOs and MDs come from the general searches, and are told apart by their industry.
 */
export function searchesFor(market: Market, rules: TitleRules): SearchSpec[] {
  const out: SearchSpec[] = [];
  const add = (sector: Sector, size: string, titles: string[], ranges: string[], keywords?: string) => {
    if (!titles.length) return;
    const label = `${SECTOR_LABEL[sector] === 'All other industries' ? 'All industries' : SECTOR_LABEL[sector]}: ${size}${keywords ? ` (${keywords})` : ''}`;
    out.push({ key: `${sector}|${size}|${titles.map(short).join(',')}|${keywords ?? ''}`, market, label, sector, titles, ranges, keywords });
  };
  add('general', 'small firms', rules.general.small, [SMALL_RANGE]);
  add('general', 'large firms', rules.general.large, [LARGE_RANGE]);
  const generalTitles = new Set([...rules.general.small, ...rules.general.large].map((t) => t.toLowerCase()));
  for (const sector of SECTORS.filter((s): s is Exclude<Sector, 'general'> => s !== 'general')) {
    const own = unique([...rules[sector].small, ...rules[sector].large]).filter((t) => !generalTitles.has(t.toLowerCase()));
    if (!own.length) continue;
    // Titles that only exist in the sector need no keyword; broad ones are narrowed by the sector's first keywords.
    const needsKeyword = own.some((t) => !/medical|clinical|nurs|hotel|chef|restaurant/i.test(t));
    if (needsKeyword) for (const kw of rules.sectorKeywords[sector].slice(0, 3)) add(sector, 'own titles', own, [SMALL_RANGE, LARGE_RANGE], kw);
    else add(sector, 'own titles', own, [SMALL_RANGE, LARGE_RANGE]);
  }
  return out;
}
